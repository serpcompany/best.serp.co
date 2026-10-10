import {
  applyStagedContentPlans,
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  listingHasQueuedSubmission,
  listingIsLiveGuard,
  replaceStagedChildrenPlans,
  revisionContentSource,
  type StagedListingContent,
  type StatementPlan,
  tagSlugsJson
} from './plan-support'
import type { RevisionStatus } from './schema'

/**
 * Revisions (serpcompany/best.serp.co#62): an owner's staged edit of a live listing. Nothing
 * reaches the catalog until a reviewer approves it, and approval applies it atomically. The
 * transition map, compared and swapped by the plans below and proved by
 * `revision-plans.test.ts`:
 */
export const revisionTransitions = {
  approve: { from: ['pending_review'], to: 'approved' },
  edit: { from: ['pending_review', 'changes_requested'], to: null },
  reject: { from: ['pending_review', 'changes_requested'], to: 'rejected' },
  requestChanges: { from: ['pending_review'], to: 'changes_requested' },
  resubmit: { from: ['changes_requested'], to: 'pending_review' },
  withdraw: { from: ['pending_review', 'changes_requested'], to: 'withdrawn' }
} as const satisfies Record<string, { from: readonly RevisionStatus[]; to: RevisionStatus | null }>

function statusList(statuses: readonly RevisionStatus[]): string {
  return statuses.map(status => `'${status}'`).join(',')
}

function event(
  revisionId: string,
  eventType: string,
  actor: string,
  detail: string | null = null
): StatementPlan {
  return {
    sql: `INSERT INTO listing_revision_events (revision_id,event_type,detail,actor)
      VALUES (?,?,?,?)`,
    params: [revisionId, eventType, detail, actor]
  }
}

const currentOwner = (listingIdSql: string, userIdSql: string) => `EXISTS (
  SELECT 1 FROM listing_owners o WHERE o.listing_id=${listingIdSql} AND o.user_id=${userIdSql}
    AND o.role='owner' AND o.revoked_at IS NULL)`

export function selectRevisionForDecisionPlan(revisionId: string): StatementPlan {
  return {
    sql: `SELECT r.id,r.status,r.listing_id,r.author_user_id,r.base_checksum,r.content_version,
        l.slug,l.checksum AS listing_checksum,ps.version,ps.checksum,
        CASE WHEN ${listingIsLiveGuard('r.listing_id')} THEN 1 ELSE 0 END AS listing_live
      FROM listing_revisions r JOIN listings l ON l.id=r.listing_id
      JOIN publication_state ps ON ps.id=1
      WHERE r.id=?`,
    params: [revisionId]
  }
}

/**
 * A listing's current owner stages an edit of the live listing. `base_checksum` records the
 * listing content it was based on; a listing has at most one open revision, and none while its
 * own submission is still in review (`paid_pending_review` or `changes_requested`), so a listing
 * has one staged-edit channel at a time. `tagSlugs` null (or left out) leaves the listing's tags
 * as they are when the revision is approved; a list replaces them (#341).
 */
export function buildCreateRevisionPlans(input: {
  authorUserId: string
  content: StagedListingContent
  listingId: string
  now: string
  revisionId: string
}): StatementPlan[] {
  const { content } = input
  return [
    {
      sql: `INSERT INTO listing_revisions
        (id,listing_id,author_user_id,status,base_checksum,name,description,content,
         category_slug,logo_url,video_url,tag_slugs,created_at,updated_at)
        SELECT ?,l.id,?,'pending_review',l.checksum,?,?,?,?,?,?,?,?,?
        FROM listings l
        WHERE l.id=? AND ${listingIsLiveGuard('l.id')} AND ${currentOwner('l.id', '?')}
          AND NOT ${listingHasQueuedSubmission('l.id')}`,
      params: [
        input.revisionId,
        input.authorUserId,
        content.name,
        content.description,
        content.content,
        content.categorySlug,
        content.logoUrl,
        content.videoUrl ?? null,
        tagSlugsJson(content.tagSlugs ?? null),
        input.now,
        input.now,
        input.listingId,
        input.authorUserId
      ]
    },
    assertPreviousStatementChangedOne('revision_created'),
    ...replaceStagedChildrenPlans(revisionContentSource(input.revisionId), content),
    event(input.revisionId, 'created', input.authorUserId)
  ]
}

/**
 * Replaces an open revision's staged content and increments its `content_version`; only its
 * author edits it. Approval compares and swaps on the version the reviewer saw. Pass
 * `expectedContentVersion` (the version the author's form loaded) so a stale second tab is
 * refused instead of overwriting newer edits (#102 review round 1).
 */
export function buildReplaceRevisionContentPlans(input: {
  authorUserId: string
  content: StagedListingContent
  expectedContentVersion?: number
  now: string
  revisionId: string
}): StatementPlan[] {
  const { content } = input
  const expected = input.expectedContentVersion
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw new Error('A content version is a positive integer read with the revision.')
  }
  return [
    {
      sql: `UPDATE listing_revisions
        SET name=?,description=?,content=?,category_slug=?,logo_url=?,video_url=?,tag_slugs=?,
          updated_at=?,content_version=content_version+1
        WHERE id=? AND author_user_id=? AND status IN (${statusList(revisionTransitions.edit.from)})${
          expected === undefined ? '' : ' AND content_version=?'
        }`,
      params: [
        content.name,
        content.description,
        content.content,
        content.categorySlug,
        content.logoUrl,
        content.videoUrl ?? null,
        tagSlugsJson(content.tagSlugs ?? null),
        input.now,
        input.revisionId,
        input.authorUserId,
        ...(expected === undefined ? [] : [expected])
      ]
    },
    assertPreviousStatementChangedOne('revision_content_replaced'),
    ...replaceStagedChildrenPlans(revisionContentSource(input.revisionId), content),
    event(input.revisionId, 'edited', input.authorUserId)
  ]
}

/** `pending_review` → `changes_requested`, with a note for the owner. */
export function buildRequestRevisionChangesPlans(input: {
  note: string
  now: string
  reviewer: string
  revisionId: string
}): StatementPlan[] {
  if (!input.note.trim()) throw new Error('A change request needs a note for the owner.')
  return [
    {
      sql: `UPDATE listing_revisions
        SET status='changes_requested',reviewer_note=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status IN (${statusList(revisionTransitions.requestChanges.from)})`,
      params: [input.note, input.now, input.reviewer, input.now, input.revisionId]
    },
    assertPreviousStatementChangedOne('revision_changes_requested'),
    event(input.revisionId, 'changes_requested', input.reviewer, input.note)
  ]
}

/** `changes_requested` → `pending_review`, by its author. */
export function buildResubmitRevisionPlans(input: {
  authorUserId: string
  now: string
  revisionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_revisions SET status='pending_review',updated_at=?
        WHERE id=? AND author_user_id=? AND status='changes_requested'`,
      params: [input.now, input.revisionId, input.authorUserId]
    },
    assertPreviousStatementChangedOne('revision_resubmitted'),
    event(input.revisionId, 'resubmitted', input.authorUserId)
  ]
}

/** An open revision → `withdrawn`, by its author. */
export function buildWithdrawRevisionPlans(input: {
  authorUserId: string
  now: string
  revisionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_revisions SET status='withdrawn',updated_at=?
        WHERE id=? AND author_user_id=? AND status IN (${statusList(revisionTransitions.withdraw.from)})`,
      params: [input.now, input.revisionId, input.authorUserId]
    },
    assertPreviousStatementChangedOne('revision_withdrawn'),
    event(input.revisionId, 'withdrawn', input.authorUserId)
  ]
}

/** An open revision → `rejected`, with a reason. The live listing is unchanged. */
export function buildRejectRevisionPlans(input: {
  now: string
  reason: string
  reviewer: string
  revisionId: string
}): StatementPlan[] {
  if (!input.reason.trim()) throw new Error('A rejection needs a reason.')
  return [
    {
      sql: `UPDATE listing_revisions
        SET status='rejected',rejection_reason=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status IN (${statusList(revisionTransitions.reject.from)})`,
      params: [input.reason, input.now, input.reviewer, input.now, input.revisionId]
    },
    assertPreviousStatementChangedOne('revision_rejected'),
    event(input.revisionId, 'rejected', input.reviewer, input.reason)
  ]
}

/**
 * `pending_review` → `approved`: the revision replaces the live listing's content in the same
 * batch. It is refused when the revision's content is not the version the reviewer saw
 * (`expectedContentVersion`), when the listing changed since the revision was based on it
 * (`base_checksum`), when the listing is no longer live or its submission is back in review, or
 * when the author no longer owns it.
 */
export function buildApproveRevisionPlans(input: {
  expectedContentVersion: number
  /**
   * The hosted logo the reviewer saw (null for the tile): only that logo is adopted, never a
   * later fetch of the revision's logo URL (#96 review round 3, S1).
   */
  expectedLogoKey?: string | null
  listingId: string
  now: string
  publication: CatalogPublication
  reviewer: string
  revisionId: string
}): StatementPlan[] {
  if (!Number.isSafeInteger(input.expectedContentVersion) || input.expectedContentVersion < 1) {
    throw new Error('A content version is a positive integer read with the revision.')
  }
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_revisions r JOIN listings l ON l.id=r.listing_id
        WHERE r.id=? AND r.listing_id=? AND r.status='pending_review' AND r.content_version=?
          AND l.checksum=r.base_checksum AND ${listingIsLiveGuard('l.id')}
          AND NOT ${listingHasQueuedSubmission('l.id')}
          AND ${currentOwner('l.id', 'r.author_user_id')})`,
      params: [input.revisionId, input.listingId, input.expectedContentVersion]
    }),
    ...applyStagedContentPlans({
      checksum: input.publication.afterChecksum,
      listingId: input.listingId,
      now: input.now,
      reviewedLogoKey: input.expectedLogoKey,
      source: revisionContentSource(input.revisionId)
    }),
    {
      sql: `UPDATE listing_revisions SET status='approved',reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND listing_id=? AND status='pending_review'`,
      params: [input.now, input.reviewer, input.now, input.revisionId, input.listingId]
    },
    assertPreviousStatementChangedOne('revision_approved'),
    event(input.revisionId, 'approved', input.reviewer),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}
