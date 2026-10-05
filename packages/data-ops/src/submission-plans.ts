import { draftClockCutoffs } from './draft-plans'
import {
  applyStagedContentPlans,
  assertGuard,
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  listingIsLiveGuard,
  type PlanGuard,
  replaceStagedChildrenPlans,
  type StagedListingContent,
  type StatementPlan,
  submissionContentSource
} from './plan-support'
import type { RejectionCategory, SubmissionStatus } from './schema'

export { assertPreviousStatementChangedOne } from './plan-support'

export type SubmissionStatementPlan = StatementPlan

export interface SubmissionApprovalSnapshot {
  checksum: string
  listingId: string | null
  slug: string
  status: SubmissionStatus
  version: number
}

const CHANNEL = 'github_issue'
const LEGACY_APPROVAL_WORKFLOW = 'github/approve-d1-submission'

/**
 * The submission transition map (docs/SUBMISSION_FLOW.md). Each plan below compares and swaps
 * exactly these source statuses; `submission-plans.test.ts` proves every other status fails.
 */
export const submissionTransitions = {
  approve: { from: ['verified'], to: 'approved' },
  approveLive: { from: ['paid_pending_review'], to: 'approved' },
  chooseFree: { from: ['draft'], to: 'pending_badge' },
  choosePaid: { from: ['draft'], to: 'draft' },
  edit: {
    from: ['draft', 'pending_badge', 'verified', 'paid_pending_review', 'changes_requested'],
    to: null
  },
  /** System transition after 30 days (`draft-plans.ts`, `buildExpireDraftPlans`). */
  expire: { from: ['draft'], to: 'withdrawn' },
  payHold: { from: ['draft'], to: 'verified' },
  payPublish: { from: ['draft'], to: 'paid_pending_review' },
  refund: { from: ['approved', 'rejected'], to: null },
  reject: {
    from: ['pending_badge', 'verified', 'paid_pending_review', 'changes_requested'],
    to: 'rejected'
  },
  requestChanges: { from: ['verified', 'paid_pending_review'], to: 'changes_requested' },
  resubmit: { from: ['changes_requested'], to: 'verified | paid_pending_review' },
  withdraw: { from: ['draft', 'pending_badge', 'verified', 'changes_requested'], to: 'withdrawn' }
} as const satisfies Record<
  string,
  {
    from: readonly SubmissionStatus[]
    to: SubmissionStatus | 'verified | paid_pending_review' | null
  }
>

function statusList(statuses: readonly SubmissionStatus[]): string {
  return statuses.map(status => `'${status}'`).join(',')
}

function event(
  submissionId: string,
  eventType: string,
  actor: string,
  detail: string | null = null
): StatementPlan {
  return {
    sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
      VALUES (?,?,?,?)`,
    params: [submissionId, eventType, detail, actor]
  }
}

export function selectSubmissionForDecisionPlan(submissionId: string): StatementPlan {
  return {
    sql: `SELECT s.id,s.slug,s.status,s.listing_id,s.plan,s.paid_at,s.refunded_at,
        s.owner_user_id,s.rejection_category,ps.version,ps.checksum,
        CASE WHEN ${listingIsLiveGuard('s.listing_id')} THEN 1 ELSE 0 END AS listing_live
      FROM listing_submissions s JOIN publication_state ps ON ps.id=1
      WHERE s.id=?`,
    params: [submissionId]
  }
}

/**
 * Creates the listing from a submission's staged data and publishes it: `source` is
 * `submission` and the outbound link `nofollow` (#59), and the submitter, when signed in,
 * becomes the listing's owner (`verified_via = 'submission'`).
 */
function createListingFromSubmissionPlans(input: {
  checksum: string
  fromStatus: SubmissionStatus
  listingId: string
  now: string
  submissionId: string
}): StatementPlan[] {
  const { fromStatus, listingId, submissionId } = input
  return [
    {
      sql: `INSERT INTO listings
        (id,slug,name,description,website,content,is_unofficial,is_featured,is_active,status,
         source_kind,source_identity,checksum,display_order,source,link_rel)
        SELECT ?,slug,name,description,website,content,0,0,1,'draft',
          'verified-submission',id,?,COALESCE((SELECT MAX(display_order)+1 FROM listings),0),
          'submission','nofollow'
        FROM listing_submissions WHERE id=? AND status=? AND listing_id IS NULL`,
      params: [listingId, input.checksum, submissionId, fromStatus]
    },
    assertPreviousStatementChangedOne('draft_listing_created'),
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        SELECT ?,c.id,0,1 FROM listing_submissions s JOIN categories c
          ON c.slug=s.category_slug AND c.is_active=1
        WHERE s.id=? AND s.status=?`,
      params: [listingId, submissionId, fromStatus]
    },
    assertPreviousStatementChangedOne('primary_category_created'),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'logo',logo_url,0 FROM listing_submissions
        WHERE id=? AND status=?`,
      params: [listingId, submissionId, fromStatus]
    },
    assertPreviousStatementChangedOne('logo_created'),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'video',video_url,1 FROM listing_submissions
        WHERE id=? AND status=? AND video_url IS NOT NULL`,
      params: [listingId, submissionId, fromStatus]
    },
    {
      sql: `INSERT INTO listing_resource_links (listing_id,label,url,sort_order)
        SELECT ?,label,url,sort_order FROM listing_submission_resource_links
        WHERE submission_id=? ORDER BY sort_order`,
      params: [listingId, submissionId]
    },
    {
      sql: `INSERT INTO listing_faqs (listing_id,question,answer,sort_order)
        SELECT ?,question,answer,sort_order FROM listing_submission_faqs
        WHERE submission_id=? ORDER BY sort_order`,
      params: [listingId, submissionId]
    },
    {
      sql: `UPDATE listings SET status='approved',published_at=?,updated_at=?
        WHERE id=? AND status='draft' AND source_kind='verified-submission'
          AND source_identity=?`,
      params: [input.now, input.now, listingId, submissionId]
    },
    assertPreviousStatementChangedOne('listing_published'),
    {
      sql: `INSERT INTO listing_owners (listing_id,user_id,role,verified_via,verified_at)
        SELECT ?,owner_user_id,'owner','submission',? FROM listing_submissions
        WHERE id=? AND owner_user_id IS NOT NULL`,
      params: [listingId, input.now, submissionId]
    }
  ]
}

/** `verified` → `approved`: the staged submission becomes a published listing. */
export function buildApproveSubmissionPlans(input: {
  afterChecksum: string
  affectedRoute: string
  beforeChecksum: string
  listingId: string
  manifestId: string
  now: string
  reviewer: string
  runId: string
  submissionId: string
  version: number
  workflow?: string
}): StatementPlan[] {
  const publication: CatalogPublication = {
    actor: input.reviewer,
    affectedRoutes: input.affectedRoute,
    afterChecksum: input.afterChecksum,
    beforeChecksum: input.beforeChecksum,
    manifestId: input.manifestId,
    now: input.now,
    runId: input.runId,
    version: input.version,
    workflow: input.workflow ?? LEGACY_APPROVAL_WORKFLOW
  }
  return [
    ...beginCatalogPublicationPlans(
      publication,
      {
        sql: `EXISTS (SELECT 1 FROM listing_submissions
          WHERE id=? AND status='verified' AND listing_id IS NULL)`,
        params: [input.submissionId]
      },
      'approval_snapshot_current'
    ),
    ...createListingFromSubmissionPlans({
      checksum: input.afterChecksum,
      fromStatus: 'verified',
      listingId: input.listingId,
      now: input.now,
      submissionId: input.submissionId
    }),
    {
      sql: `UPDATE listing_submissions SET status='approved',listing_id=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status='verified' AND listing_id IS NULL`,
      params: [input.listingId, input.now, input.reviewer, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('submission_approved'),
    event(input.submissionId, 'approved', input.reviewer),
    ...finishCatalogPublicationPlans(publication)
  ]
}

/**
 * The submitter's plan choice on a `draft` (#59 owner decision, 2026-10-06). `free` moves it to
 * `pending_badge` (install and verify the badge); `paid` records the choice and keeps it a draft
 * until checkout completes (`buildRecordSubmissionPaymentPlans`). A paid draft may still switch
 * to free before paying. An expired draft (30 days, even before the job withdraws it) cannot
 * choose a plan.
 */
export function buildChooseSubmissionPlanPlans(input: {
  now: string
  ownerUserId: string
  plan: 'free' | 'paid'
  submissionId: string
}): StatementPlan[] {
  if (input.plan !== 'free' && input.plan !== 'paid') {
    throw new Error('A submission plan must be free or paid.')
  }
  const status = input.plan === 'free' ? 'pending_badge' : 'draft'
  const { expiryCutoff } = draftClockCutoffs(input.now)
  return [
    {
      sql: `UPDATE listing_submissions SET status=?,plan=?,updated_at=?
        WHERE id=? AND owner_user_id=? AND status='draft' AND paid_at IS NULL
          AND listing_id IS NULL AND draft_saved_at>?`,
      params: [status, input.plan, input.now, input.submissionId, input.ownerUserId, expiryCutoff]
    },
    assertPreviousStatementChangedOne('submission_plan_chosen'),
    event(input.submissionId, 'plan_chosen', input.ownerUserId, input.plan)
  ]
}

/**
 * Payment confirmed for a draft whose submitter chose the paid plan (#68). `publish` (the
 * guardrail checks passed) creates and publishes the listing and moves the submission to
 * `paid_pending_review`: live and in the review queue. `hold` (a check failed) moves it to
 * `verified`: in the review queue, unpublished.
 */
export function buildRecordSubmissionPaymentPlans(
  input: { actor: string; now: string; submissionId: string } & (
    | { listingId: string; outcome: 'publish'; publication: CatalogPublication }
    | { outcome: 'hold' }
  )
): StatementPlan[] {
  const unpaid = `id=? AND status='draft' AND plan='paid' AND paid_at IS NULL
    AND refunded_at IS NULL AND listing_id IS NULL`
  if (input.outcome === 'hold') {
    return [
      {
        sql: `UPDATE listing_submissions SET status='verified',paid_at=?,updated_at=?
          WHERE ${unpaid}`,
        params: [input.now, input.now, input.submissionId]
      },
      assertPreviousStatementChangedOne('submission_paid_held'),
      event(input.submissionId, 'paid', input.actor, 'held_for_review')
    ]
  }
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions WHERE ${unpaid})`,
      params: [input.submissionId]
    }),
    ...createListingFromSubmissionPlans({
      checksum: input.publication.afterChecksum,
      fromStatus: 'draft',
      listingId: input.listingId,
      now: input.now,
      submissionId: input.submissionId
    }),
    {
      sql: `UPDATE listing_submissions
        SET status='paid_pending_review',paid_at=?,listing_id=?,updated_at=?
        WHERE ${unpaid}`,
      params: [input.now, input.listingId, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('submission_paid_published'),
    event(input.submissionId, 'paid', input.actor, 'published'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * `paid_pending_review` → `approved`. The listing is already live; its content is replaced by
 * the submission's staged content (which a reviewer may have edited before approving).
 */
export function buildApproveLiveSubmissionPlans(input: {
  listingId: string
  now: string
  publication: CatalogPublication
  reviewer: string
  submissionId: string
}): StatementPlan[] {
  const current = `id=? AND status='paid_pending_review' AND listing_id=?`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions WHERE ${current})
        AND ${listingIsLiveGuard('?')}`,
      params: [input.submissionId, input.listingId, input.listingId]
    }),
    ...applyStagedContentPlans({
      checksum: input.publication.afterChecksum,
      listingId: input.listingId,
      now: input.now,
      source: submissionContentSource(input.submissionId)
    }),
    {
      sql: `UPDATE listing_submissions SET status='approved',reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE ${current}`,
      params: [input.now, input.reviewer, input.now, input.submissionId, input.listingId]
    },
    assertPreviousStatementChangedOne('live_submission_approved'),
    event(input.submissionId, 'approved', input.reviewer),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/** `verified` | `paid_pending_review` → `changes_requested`, with a note for the submitter. */
export function buildRequestSubmissionChangesPlans(input: {
  note: string
  now: string
  reviewer: string
  submissionId: string
}): StatementPlan[] {
  if (!input.note.trim()) throw new Error('A change request needs a note for the submitter.')
  return [
    {
      sql: `UPDATE listing_submissions
        SET status='changes_requested',reviewer_note=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND status IN (${statusList(submissionTransitions.requestChanges.from)})`,
      params: [input.note, input.now, input.reviewer, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('submission_changes_requested'),
    event(input.submissionId, 'changes_requested', input.reviewer, input.note)
  ]
}

/**
 * `changes_requested` → back to the review queue it left: `paid_pending_review` when its
 * listing is live, otherwise `verified`. Only the submission's owner may resubmit.
 */
export function buildResubmitSubmissionPlans(input: {
  now: string
  ownerUserId: string
  submissionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions
        SET status=CASE WHEN listing_id IS NULL THEN 'verified' ELSE 'paid_pending_review' END,
          updated_at=?
        WHERE id=? AND owner_user_id=? AND status='changes_requested'`,
      params: [input.now, input.submissionId, input.ownerUserId]
    },
    assertPreviousStatementChangedOne('submission_resubmitted'),
    event(input.submissionId, 'resubmitted', input.ownerUserId)
  ]
}

/**
 * Withdrawal by the submission's owner while nothing is live and nothing was paid; a paid
 * submission is resolved by review instead (a rejection refunds it).
 */
export function buildWithdrawSubmissionPlans(input: {
  now: string
  ownerUserId: string
  submissionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions SET status='withdrawn',withdrawal_reason='owner',updated_at=?
        WHERE id=? AND owner_user_id=?
          AND status IN (${statusList(submissionTransitions.withdraw.from)})
          AND listing_id IS NULL AND paid_at IS NULL`,
      params: [input.now, input.submissionId, input.ownerUserId]
    },
    assertPreviousStatementChangedOne('submission_withdrawn'),
    event(input.submissionId, 'withdrawn', input.ownerUserId)
  ]
}

/**
 * Rejection with a reason and its category. A live submission (`live`) is unpublished in the
 * same batch, and the submitter's ownership of that listing is revoked. A `prohibited`
 * rejection blocks the URL key from new submissions until an admin lifts it; refunding an
 * `other` rejection of a paid submission is recorded by `buildRefundSubmissionPlans`.
 */
export function buildRejectSubmissionPlans(input: {
  category: RejectionCategory
  live?: { listingId: string; publication: CatalogPublication }
  now: string
  reason: string
  reviewer: string
  submissionId: string
}): StatementPlan[] {
  if (!input.reason.trim()) throw new Error('A rejection needs a reason.')
  if (input.category !== 'prohibited' && input.category !== 'other') {
    throw new Error('A rejection category must be prohibited or other.')
  }
  const listingMatch = input.live ? 'listing_id=?' : 'listing_id IS NULL'
  const listingParams = input.live ? [input.live.listingId] : []
  const current = `id=? AND status IN (${statusList(submissionTransitions.reject.from)})
    AND ${listingMatch}`
  const plans: StatementPlan[] = []
  if (input.live) {
    plans.push(
      ...beginCatalogPublicationPlans(input.live.publication, {
        sql: `EXISTS (SELECT 1 FROM listing_submissions WHERE ${current})`,
        params: [input.submissionId, ...listingParams]
      }),
      {
        sql: `UPDATE listings SET is_active=0,updated_at=?
          WHERE id=? AND status='approved' AND is_active=1`,
        params: [input.now, input.live.listingId]
      },
      // An admin may already have unpublished it; either way it must not stay live.
      assertGuard('rejected_listing_unpublished', {
        sql: `NOT ${listingIsLiveGuard('?')}`,
        params: [input.live.listingId]
      }),
      {
        sql: `UPDATE listing_owners SET revoked_at=?,revoked_reason='submission_rejected'
          WHERE listing_id=? AND revoked_at IS NULL`,
        params: [input.now, input.live.listingId]
      },
      event(input.submissionId, 'unpublished', input.reviewer, 'rejected')
    )
  }
  plans.push(
    {
      sql: `UPDATE listing_submissions
        SET status='rejected',rejection_reason=?,rejection_category=?,reviewed_at=?,reviewed_by=?,
          updated_at=?
        WHERE ${current}`,
      params: [
        input.reason,
        input.category,
        input.now,
        input.reviewer,
        input.now,
        input.submissionId,
        ...listingParams
      ]
    },
    assertPreviousStatementChangedOne('submission_rejected'),
    event(
      input.submissionId,
      'rejected',
      input.reviewer,
      JSON.stringify({ category: input.category, reason: input.reason })
    )
  )
  if (input.category === 'prohibited') {
    plans.push(
      {
        sql: `INSERT INTO listing_submission_url_blocks
          (url_key,submission_id,reason,blocked_by,blocked_at)
          SELECT slug,id,?,?,? FROM listing_submissions WHERE id=? AND status='rejected'
          ON CONFLICT(url_key) WHERE lifted_at IS NULL DO NOTHING`,
        params: [input.reason, input.reviewer, input.now, input.submissionId]
      },
      assertGuard('prohibited_url_blocked', {
        sql: `EXISTS (SELECT 1 FROM listing_submission_url_blocks b
          JOIN listing_submissions s ON s.slug=b.url_key
          WHERE s.id=? AND b.lifted_at IS NULL)`,
        params: [input.submissionId]
      })
    )
  }
  if (input.live) plans.push(...finishCatalogPublicationPlans(input.live.publication))
  return plans
}

const latestConclusiveBadgeCheck = `(SELECT outcome FROM badge_checks
  WHERE listing_id=s.listing_id AND conclusive=1 ORDER BY checked_at DESC,id DESC LIMIT 1)`

/**
 * Records a refund of a paid submission (`refunded_at`; #59 amendment 2026-10-06):
 * - `after_rejection`: the rejection already unpublished it; only the refund is recorded.
 * - `keep_free`: an approved paid listing whose latest conclusive badge check passed stays
 *   live as a free listing: its plan becomes `free` (paid → free), so the badge program
 *   applies to it from now on.
 * - `unpublish`: any other approved paid listing is taken down in the same batch.
 */
export function buildRefundSubmissionPlans(
  input: { actor: string; now: string; submissionId: string } & (
    | { mode: 'after_rejection' }
    | { mode: 'keep_free' }
    | { mode: 'unpublish'; publication: CatalogPublication }
  )
): StatementPlan[] {
  const paid = `s.id=? AND s.plan='paid' AND s.paid_at IS NOT NULL AND s.refunded_at IS NULL`
  const refund = (condition: PlanGuard, plan: 'free' | 'paid', label: string): StatementPlan[] => [
    {
      sql: `UPDATE listing_submissions SET plan=?,refunded_at=?,updated_at=?
        WHERE id IN (SELECT s.id FROM listing_submissions s WHERE ${paid} AND ${condition.sql})`,
      params: [plan, input.now, input.now, input.submissionId, ...condition.params]
    },
    assertPreviousStatementChangedOne(label)
  ]
  if (input.mode === 'after_rejection') {
    return [
      ...refund({ sql: `s.status='rejected'`, params: [] }, 'paid', 'rejected_submission_refunded'),
      event(input.submissionId, 'refunded', input.actor, 'after_rejection')
    ]
  }
  const approvedLive = `s.status='approved' AND ${listingIsLiveGuard('s.listing_id')}`
  if (input.mode === 'keep_free') {
    return [
      ...refund(
        { sql: `${approvedLive} AND ${latestConclusiveBadgeCheck}='pass'`, params: [] },
        'free',
        'refunded_listing_kept_free'
      ),
      event(input.submissionId, 'refunded', input.actor, 'kept_as_free')
    ]
  }
  const condition = `${approvedLive} AND ${latestConclusiveBadgeCheck} IS NOT 'pass'`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions s WHERE ${paid} AND ${condition})`,
      params: [input.submissionId]
    }),
    {
      sql: `UPDATE listings SET is_active=0,updated_at=?
        WHERE id=(SELECT listing_id FROM listing_submissions WHERE id=?)
          AND status='approved' AND is_active=1`,
      params: [input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('refunded_listing_unpublished'),
    {
      sql: `UPDATE listing_submissions SET refunded_at=?,updated_at=?
        WHERE id=? AND status='approved' AND plan='paid' AND refunded_at IS NULL`,
      params: [input.now, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('refunded_submission_recorded'),
    event(input.submissionId, 'refunded', input.actor, 'unpublished'),
    event(input.submissionId, 'unpublished', input.actor, 'refunded'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * Replaces a submission's staged content (event `edited`). The submitter edits while the
 * submission is a `draft`, `pending_badge`, or `changes_requested` (pass `ownerUserId`); a
 * reviewer may edit a queued submission before approving it. Website and slug never change.
 */
export function buildReplaceSubmissionContentPlans(input: {
  actor: string
  content: StagedListingContent & { logoUrl: string; content: string }
  expectedStatuses: readonly SubmissionStatus[]
  now: string
  ownerUserId?: string
  submissionId: string
}): StatementPlan[] {
  const allowed = input.expectedStatuses.filter(status =>
    (submissionTransitions.edit.from as readonly string[]).includes(status)
  )
  if (allowed.length === 0 || allowed.length !== input.expectedStatuses.length) {
    throw new Error('Submission content can only be edited before a final decision.')
  }
  const owner = input.ownerUserId === undefined ? '' : ' AND owner_user_id=?'
  return [
    {
      sql: `UPDATE listing_submissions
        SET name=?,description=?,content=?,category_slug=?,logo_url=?,video_url=?,updated_at=?
        WHERE id=? AND status IN (${statusList(allowed)})${owner}`,
      params: [
        input.content.name,
        input.content.description,
        input.content.content,
        input.content.categorySlug,
        input.content.logoUrl,
        input.content.videoUrl ?? null,
        input.now,
        input.submissionId,
        ...(input.ownerUserId === undefined ? [] : [input.ownerUserId])
      ]
    },
    assertPreviousStatementChangedOne('submission_content_replaced'),
    ...replaceStagedChildrenPlans(submissionContentSource(input.submissionId), input.content),
    event(input.submissionId, 'edited', input.actor)
  ]
}

/** An admin lifts the active prohibited-URL block for a URL key. */
export function buildLiftSubmissionUrlBlockPlans(input: {
  admin: string
  note: string
  now: string
  urlKey: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submission_url_blocks SET lifted_at=?,lifted_by=?,lift_note=?
        WHERE url_key=? AND lifted_at IS NULL`,
      params: [input.now, input.admin, input.note, input.urlKey]
    },
    assertPreviousStatementChangedOne('url_block_lifted')
  ]
}

export function selectVerifiedSubmissionNotificationPlans(limit: number): StatementPlan[] {
  const pending = `SELECT candidate.id FROM listing_submissions candidate
    LEFT JOIN listing_submission_notifications notification
      ON notification.submission_id=candidate.id AND notification.channel=?
    WHERE candidate.status='verified'
      AND (notification.submission_id IS NULL OR notification.preview_token_hash IS NULL)
    ORDER BY candidate.badge_verified_at,candidate.created_at LIMIT ?`
  const params = [CHANNEL, limit]
  return [
    {
      sql: `SELECT s.id,s.slug,s.name,s.description,s.website,s.content,s.category_slug,
          s.logo_url,s.video_url,s.verification_attempts,s.badge_verified_at,s.created_at
        FROM listing_submissions s
        WHERE s.id IN (${pending})
        ORDER BY s.badge_verified_at,s.created_at`,
      params
    },
    {
      sql: `WITH pending AS (${pending})
        SELECT r.submission_id,r.label,r.url,r.sort_order
        FROM listing_submission_resource_links r
        JOIN pending ON pending.id=r.submission_id
        ORDER BY r.submission_id,r.sort_order`,
      params
    },
    {
      sql: `WITH pending AS (${pending})
        SELECT f.submission_id,f.question,f.answer,f.sort_order
        FROM listing_submission_faqs f
        JOIN pending ON pending.id=f.submission_id
        ORDER BY f.submission_id,f.sort_order`,
      params
    }
  ]
}

export function recordSubmissionNotificationPlan(input: {
  externalId: string
  externalUrl: string
  previewTokenHash: string
  recipient: string
  submissionId: string
}): StatementPlan {
  return {
    sql: `INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
      SELECT ?,?,?,?,?,? FROM listing_submissions
      WHERE id=? AND status='verified'
      ON CONFLICT(submission_id,channel) DO UPDATE SET
        external_id=excluded.external_id,
        external_url=excluded.external_url,
        recipient=excluded.recipient,
        preview_token_hash=excluded.preview_token_hash,
        updated_at=CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM listing_submissions
        WHERE id=excluded.submission_id AND status='verified')`,
    params: [
      input.submissionId,
      CHANNEL,
      input.externalId,
      input.externalUrl,
      input.recipient,
      input.previewTokenHash,
      input.submissionId
    ]
  }
}
