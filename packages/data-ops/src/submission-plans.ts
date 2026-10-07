import { draftClockCutoffs } from './draft-plans'
import {
  adoptStagedLogoPlans,
  adoptSubmissionImagePlans,
  applyStagedContentPlans,
  assertGuard,
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  hoursBefore,
  listingIsLiveGuard,
  type PlanGuard,
  replaceStagedChildrenPlans,
  type StagedListingContent,
  type StatementPlan,
  submissionContentSource
} from './plan-support'
import {
  type ListingLinkRel,
  listingLinkRels,
  type RejectionCategory,
  type SubmissionStatus
} from './schema'

export { assertPreviousStatementChangedOne } from './plan-support'

export type SubmissionStatementPlan = StatementPlan

export interface SubmissionApprovalSnapshot {
  checksum: string
  contentVersion: number
  listingId: string | null
  slug: string
  status: SubmissionStatus
  version: number
}

/**
 * How old the refund's own badge check (`badge_checks.kind = 'refund'`, #66) may be when the
 * refund is recorded: the owner decided the badge is checked once, right at refund (2026-10-06),
 * so a refund retried later checks again (`checkBadgeAtRefund`).
 */
export const REFUND_BADGE_CHECK_MAX_AGE_HOURS = 1

/**
 * The submission transition map (docs/SUBMISSION_FLOW.md). Each plan below compares and swaps
 * exactly these source statuses; the tests run every plan from every status.
 */
export const submissionTransitions = {
  approve: { from: ['verified'], to: 'approved' },
  approveLive: { from: ['paid_pending_review'], to: 'approved' },
  chooseFree: { from: ['draft'], to: 'pending_badge' },
  choosePaid: { from: ['draft'], to: 'draft' },
  /** An admin frees a draft's URL key (`buildClearDraftPlans`). */
  clearDraft: { from: ['draft'], to: 'withdrawn' },
  /** A reviewer's edit before deciding. */
  edit: {
    from: ['draft', 'pending_badge', 'verified', 'paid_pending_review', 'changes_requested'],
    to: null
  },
  /** System transition after 30 days (`draft-plans.ts`, `buildExpireDraftPlans`). */
  expire: { from: ['draft'], to: 'withdrawn' },
  /**
   * The owner checks a live free listing's badge from the account (#65): bookkeeping on its
   * approved submission (the check counters and an event), never a review transition.
   */
  listingBadgeCheck: { from: ['approved'], to: null },
  /** The owner's edit: never while the submission is in the review queue. */
  ownerEdit: { from: ['draft', 'pending_badge', 'changes_requested'], to: null },
  /**
   * The owner adds FAQs and links while the submission waits for review (#65; #70 screen 6
   * "Add them now and they're reviewed with the listing"). The rest of its content stays as the
   * reviewer sees it, and the content version moves, so a stale approval is refused.
   */
  ownerExtras: { from: ['verified', 'paid_pending_review'], to: null },
  /**
   * A completed payment. From a paid draft, from `pending_badge` (the upgrade, or a draft that
   * switched to free while its checkout was open), or from a free `verified` submission.
   */
  payHold: { from: ['draft', 'pending_badge', 'verified'], to: 'verified' },
  payPublish: { from: ['draft', 'pending_badge', 'verified'], to: 'paid_pending_review' },
  /** A payment that arrived after the submission was withdrawn: recorded and refunded. */
  payUnapplied: { from: ['withdrawn'], to: null },
  refund: { from: ['approved', 'rejected'], to: null },
  reject: {
    from: ['pending_badge', 'verified', 'paid_pending_review', 'changes_requested'],
    to: 'rejected'
  },
  requestChanges: { from: ['verified', 'paid_pending_review'], to: 'changes_requested' },
  resubmit: { from: ['changes_requested'], to: 'verified | paid_pending_review' },
  /** Upgrade of an approved free listing to the paid plan. */
  upgradeListing: { from: ['approved'], to: null },
  /** The owner's withdrawal, only before any payment and while nothing is live. */
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

function contentVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('A content version is a positive integer read with the submission.')
  }
  return value
}

/**
 * The decision snapshot: status, plan, payment, the content version the reviewer is looking at,
 * whether its listing is live, and the publication state to compare and swap against.
 */
export function selectSubmissionForDecisionPlan(submissionId: string): StatementPlan {
  return {
    sql: `SELECT s.id,s.slug,s.status,s.listing_id,s.plan,s.paid_at,s.refunded_at,
        s.owner_user_id,s.rejection_category,s.content_version,s.published_checksum,
        COALESCE(s.block_key,s.slug) AS block_key,
        COALESCE(s.block_covers_subdomains,0) AS block_covers_subdomains,ps.version,ps.checksum,
        CASE WHEN ${listingIsLiveGuard('s.listing_id')} THEN 1 ELSE 0 END AS listing_live
      FROM listing_submissions s JOIN publication_state ps ON ps.id=1
      WHERE s.id=?`,
    params: [submissionId]
  }
}

/**
 * Creates the listing from a submission's staged data and publishes it: `source` is
 * `submission` and the outbound link `nofollow` (#59), and the submitter, when signed in,
 * becomes the listing's owner (`verified_via = 'submission'`). `sourceCondition` is the
 * caller's compare-and-swap on the submission (unqualified columns); the first insert asserts it.
 */
function createListingFromSubmissionPlans(input: {
  checksum: string
  /**
   * The hosted featured image the reviewer saw (or null for none); absent when nobody reviewed
   * the submission (a paid listing goes live at payment), and then no image is adopted.
   */
  featuredImageKey?: string | null
  linkRel: ListingLinkRel
  listingId: string
  /** The hosted logo the reviewer saw (null for the tile); absent when nobody reviewed it. */
  logoKey?: string | null
  now: string
  sourceCondition: PlanGuard
  submissionId: string
}): StatementPlan[] {
  const { listingId, submissionId } = input
  if (!(listingLinkRels as readonly string[]).includes(input.linkRel)) {
    throw new Error('Link rel must be follow, nofollow, or sponsored.')
  }
  return [
    {
      sql: `INSERT INTO listings
        (id,slug,name,description,website,content,is_unofficial,is_featured,is_active,status,
         source_kind,source_identity,checksum,display_order,source,link_rel)
        SELECT ?,slug,name,description,website,content,0,0,1,'draft',
          'verified-submission',id,?,COALESCE((SELECT MAX(display_order)+1 FROM listings),0),
          'submission',?
        FROM listing_submissions WHERE id=? AND listing_id IS NULL AND (${input.sourceCondition.sql})`,
      params: [
        listingId,
        input.checksum,
        input.linkRel,
        submissionId,
        ...input.sourceCondition.params
      ]
    },
    assertPreviousStatementChangedOne('draft_listing_created'),
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        SELECT ?,c.id,0,1 FROM listing_submissions s JOIN categories c
          ON c.slug=s.category_slug AND c.is_active=1
        WHERE s.id=?`,
      params: [listingId, submissionId]
    },
    assertPreviousStatementChangedOne('primary_category_created'),
    // Never a hotlink (#95): the submission's hosted logo is queued for a copy into the
    // listing's path (or its source for the cron), and its featured image only as reviewed.
    ...adoptStagedLogoPlans({
      listingId,
      now: input.now,
      reviewedKey: input.logoKey,
      stagedId: submissionId,
      stagedTable: 'listing_submissions'
    }),
    ...(input.featuredImageKey === undefined
      ? []
      : adoptSubmissionImagePlans({
          listingId,
          now: input.now,
          reviewedKey: input.featuredImageKey,
          submissionId
        })),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'video',video_url,1 FROM listing_submissions
        WHERE id=? AND video_url IS NOT NULL`,
      params: [listingId, submissionId]
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

/**
 * `verified` → `approved`: the staged submission becomes a published listing. Refused unless
 * the staged content is still the version the reviewer saw (`expectedContentVersion`). The
 * outbound link is `nofollow` (#59) unless the reviewer chose another `linkRel` (#64).
 */
export function buildApproveSubmissionPlans(input: {
  afterChecksum: string
  affectedRoute: string
  beforeChecksum: string
  expectedContentVersion: number
  /**
   * The hosted featured image key the reviewer saw (null for none). Absent: no featured image
   * is adopted.
   */
  expectedImageKey?: string | null
  /** The hosted logo key the reviewer saw (null for the tile), like `expectedImageKey`. */
  expectedLogoKey?: string | null
  linkRel?: ListingLinkRel
  listingId: string
  manifestId: string
  now: string
  reviewer: string
  runId: string
  submissionId: string
  version: number
  workflow: string
}): StatementPlan[] {
  const reviewed = contentVersion(input.expectedContentVersion)
  const publication: CatalogPublication = {
    actor: input.reviewer,
    affectedRoutes: input.affectedRoute,
    afterChecksum: input.afterChecksum,
    beforeChecksum: input.beforeChecksum,
    manifestId: input.manifestId,
    now: input.now,
    runId: input.runId,
    version: input.version,
    workflow: input.workflow
  }
  const current = { sql: `status='verified' AND content_version=?`, params: [reviewed] }
  return [
    ...beginCatalogPublicationPlans(
      publication,
      {
        sql: `EXISTS (SELECT 1 FROM listing_submissions
          WHERE id=? AND listing_id IS NULL AND ${current.sql})`,
        params: [input.submissionId, ...current.params]
      },
      'approval_snapshot_current'
    ),
    ...createListingFromSubmissionPlans({
      checksum: input.afterChecksum,
      featuredImageKey: input.expectedImageKey,
      linkRel: input.linkRel ?? 'nofollow',
      logoKey: input.expectedLogoKey,
      listingId: input.listingId,
      now: input.now,
      sourceCondition: current,
      submissionId: input.submissionId
    }),
    {
      sql: `UPDATE listing_submissions SET status='approved',listing_id=?,reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE id=? AND listing_id IS NULL AND ${current.sql}`,
      params: [
        input.listingId,
        input.now,
        input.reviewer,
        input.now,
        input.submissionId,
        ...current.params
      ]
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
 * to free before paying: a checkout that completes afterwards still applies, as an upgrade from
 * `pending_badge`. An expired draft (30 days, even before the job withdraws it) cannot choose.
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

/** Statuses a completed payment applies to (`submissionTransitions.payPublish`). */
const payable = {
  sql: `paid_at IS NULL AND refunded_at IS NULL AND listing_id IS NULL
    AND ((status='draft' AND plan='paid') OR status='pending_badge'
      OR (status='verified' AND plan='free'))`,
  params: [] as unknown[]
}

/**
 * A completed payment (#68). It applies to a paid draft, to a `pending_badge` submission (the
 * free-to-paid upgrade; also a draft that switched to free while its checkout was open), and to a
 * free `verified` submission. `publish` (the guardrail checks passed) creates and publishes the
 * listing and moves the submission to `paid_pending_review`: live and in the review queue.
 * `hold` (a check failed) moves it to `verified` with the paid plan. A payment for a withdrawn
 * submission goes to `buildRecordUnappliedPaymentPlans` instead.
 */
export function buildRecordSubmissionPaymentPlans(
  input: { actor: string; now: string; submissionId: string } & (
    | { listingId: string; outcome: 'publish'; publication: CatalogPublication }
    | { outcome: 'hold' }
  )
): StatementPlan[] {
  if (input.outcome === 'hold') {
    return [
      {
        sql: `UPDATE listing_submissions SET status='verified',plan='paid',paid_at=?,updated_at=?
          WHERE id=? AND ${payable.sql}`,
        params: [input.now, input.now, input.submissionId]
      },
      assertPreviousStatementChangedOne('submission_paid_held'),
      event(input.submissionId, 'paid', input.actor, 'held_for_review')
    ]
  }
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions WHERE id=? AND ${payable.sql})`,
      params: [input.submissionId]
    }),
    ...createListingFromSubmissionPlans({
      checksum: input.publication.afterChecksum,
      linkRel: 'nofollow',
      listingId: input.listingId,
      now: input.now,
      sourceCondition: payable,
      submissionId: input.submissionId
    }),
    {
      sql: `UPDATE listing_submissions
        SET status='paid_pending_review',plan='paid',paid_at=?,listing_id=?,published_checksum=?,
          updated_at=?
        WHERE id=? AND ${payable.sql}`,
      params: [
        input.now,
        input.listingId,
        input.publication.afterChecksum,
        input.now,
        input.submissionId
      ]
    },
    assertPreviousStatementChangedOne('submission_paid_published'),
    event(input.submissionId, 'paid', input.actor, 'published'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * A payment that completed after its submission was withdrawn (by the owner or by expiry while
 * the checkout was open). The payment and its full refund are recorded together; the caller
 * (#68's webhook) issues the refund. This keeps every charge on record.
 */
export function buildRecordUnappliedPaymentPlans(input: {
  actor: string
  now: string
  submissionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions SET paid_at=?,refunded_at=?,updated_at=?
        WHERE id=? AND status='withdrawn' AND paid_at IS NULL`,
      params: [input.now, input.now, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('unapplied_payment_recorded'),
    event(input.submissionId, 'paid', input.actor, 'unapplied'),
    event(input.submissionId, 'refunded', input.actor, 'unapplied')
  ]
}

/**
 * An approved free listing upgraded to the paid plan (the "Upgrade: $49 one-off" in the #70
 * mockups). The listing stays live; nothing public changes, so the catalog version stays.
 * Upgrading an unpublished free listing ("returning means paying") is left to #66/#67.
 */
export function buildUpgradeListingToPaidPlans(input: {
  actor: string
  now: string
  submissionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions SET plan='paid',paid_at=?,updated_at=?
        WHERE id=? AND status='approved' AND plan='free' AND paid_at IS NULL
          AND ${listingIsLiveGuard('listing_submissions.listing_id')}`,
      params: [input.now, input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('listing_upgraded_to_paid'),
    event(input.submissionId, 'paid', input.actor, 'upgrade')
  ]
}

/**
 * A free listing the badge program unlisted (its latest `unpublished` event is `badge_missing`,
 * #66) comes back as a paid listing (#68, "Relist for $49"): the listing is republished at the
 * same URL and its approved submission moves to the paid plan, in one batch that advances the
 * catalog version. A listing an admin unpublished, or one whose submission is not approved and
 * free and unpaid, is refused.
 */
export function buildRelistListingToPaidPlans(input: {
  actor: string
  listingId: string
  now: string
  publication: CatalogPublication
  submissionId: string
}): StatementPlan[] {
  const relistable = `EXISTS (SELECT 1 FROM listing_submissions s JOIN listings l ON l.id=s.listing_id
      WHERE s.id=? AND s.listing_id=? AND s.status='approved' AND s.plan='free'
        AND s.paid_at IS NULL AND s.refunded_at IS NULL
        AND l.status='approved' AND l.is_active=0 AND l.published_at IS NOT NULL
        AND (SELECT e.detail FROM listing_submission_events e
          WHERE e.submission_id=s.id AND e.event_type='unpublished'
          ORDER BY e.id DESC LIMIT 1)='badge_missing')`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: relistable,
      params: [input.submissionId, input.listingId]
    }),
    {
      sql: `UPDATE listings SET is_active=1,updated_at=?
        WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL`,
      params: [input.now, input.listingId]
    },
    assertPreviousStatementChangedOne('listing_relisted'),
    {
      sql: `UPDATE listing_submissions SET plan='paid',paid_at=?,updated_at=?
        WHERE id=? AND listing_id=? AND status='approved' AND plan='free' AND paid_at IS NULL`,
      params: [input.now, input.now, input.submissionId, input.listingId]
    },
    assertPreviousStatementChangedOne('relisted_submission_paid'),
    event(input.submissionId, 'paid', input.actor, 'relist'),
    {
      sql: `INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,?,?,?)`,
      params: [
        input.listingId,
        'republished',
        JSON.stringify({ reason: 'relisted_paid' }),
        input.actor
      ]
    },
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * `paid_pending_review` → `approved`. The listing is already live; its content is replaced by
 * the submission's staged content (which a reviewer may have edited before approving). Refused
 * unless the staged content is the version the reviewer saw and the live listing is unchanged
 * since it was published from this submission (`published_checksum`), so no admin edit is lost.
 */
export function buildApproveLiveSubmissionPlans(input: {
  expectedContentVersion: number
  /** As in `buildApproveSubmissionPlans`: the paid listing went live without its image. */
  expectedImageKey?: string | null
  /** The hosted logo key the reviewer saw (null for the tile). */
  expectedLogoKey?: string | null
  listingId: string
  now: string
  publication: CatalogPublication
  reviewer: string
  submissionId: string
}): StatementPlan[] {
  const reviewed = contentVersion(input.expectedContentVersion)
  const current = `id=? AND status='paid_pending_review' AND listing_id=? AND content_version=?`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions s JOIN listings l ON l.id=s.listing_id
          WHERE s.id=? AND s.status='paid_pending_review' AND s.listing_id=?
            AND s.content_version=? AND l.checksum=s.published_checksum)
        AND ${listingIsLiveGuard('?')}`,
      params: [input.submissionId, input.listingId, reviewed, input.listingId]
    }),
    ...applyStagedContentPlans({
      checksum: input.publication.afterChecksum,
      listingId: input.listingId,
      now: input.now,
      reviewedLogoKey: input.expectedLogoKey,
      source: submissionContentSource(input.submissionId)
    }),
    ...(input.expectedImageKey === undefined
      ? []
      : adoptSubmissionImagePlans({
          listingId: input.listingId,
          now: input.now,
          reviewedKey: input.expectedImageKey,
          submissionId: input.submissionId
        })),
    {
      sql: `UPDATE listing_submissions SET status='approved',reviewed_at=?,reviewed_by=?,updated_at=?
        WHERE ${current}`,
      params: [input.now, input.reviewer, input.now, input.submissionId, input.listingId, reviewed]
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
 * `changes_requested` → back to the review queue it left: `paid_pending_review` when it has a
 * listing, otherwise `verified`. A submission whose listing is no longer live cannot resubmit
 * (`paid_pending_review` is always live); unpublishing is refused while it is queued anyway.
 * Only the submission's owner may resubmit.
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
        WHERE id=? AND owner_user_id=? AND status='changes_requested'
          AND (listing_id IS NULL OR ${listingIsLiveGuard('listing_submissions.listing_id')})`,
      params: [input.now, input.submissionId, input.ownerUserId]
    },
    assertPreviousStatementChangedOne('submission_resubmitted'),
    event(input.submissionId, 'resubmitted', input.ownerUserId)
  ]
}

/**
 * Withdrawal by the submission's owner, only before payment and while nothing is live (#59
 * owner decision, 2026-10-06): a paid submission is resolved by the team (#73 messages, then an
 * admin decision). The CHECK `listing_submissions_withdrawn_unpaid` enforces the same rule.
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

/** An admin clears a draft (for example, one holding a URL key), freeing its URL key. */
export function buildClearDraftPlans(input: {
  admin: string
  note: string
  now: string
  submissionId: string
}): StatementPlan[] {
  if (!input.note.trim()) throw new Error('Clearing a draft needs a note.')
  return [
    {
      sql: `UPDATE listing_submissions SET status='withdrawn',withdrawal_reason='admin',updated_at=?
        WHERE id=? AND status='draft'`,
      params: [input.now, input.submissionId]
    },
    assertPreviousStatementChangedOne('draft_cleared'),
    event(
      input.submissionId,
      'withdrawn',
      input.admin,
      JSON.stringify({ by: 'admin', note: input.note })
    )
  ]
}

/**
 * Rejection with a reason and its category. Pass `live` whenever the submission has a listing
 * (`listing_id` is set): the listing is unpublished in the same batch (or stays down if an admin
 * already unpublished it) and the submitter's ownership is revoked. A `prohibited` rejection
 * blocks the submission's block key from new submissions until an admin lifts it: its
 * registrable domain with every subdomain, or the exact host when the host has no registrable
 * domain (a public suffix or an IP) or the row predates #62 (no `block_key`). Refunding an
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
      // Recorded only when this batch took it down; an admin may already have unpublished it.
      {
        sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
          SELECT ?,'unpublished','rejected',? WHERE changes()=1`,
        params: [input.submissionId, input.reviewer]
      },
      assertGuard('rejected_listing_unpublished', {
        sql: `NOT ${listingIsLiveGuard('?')}`,
        params: [input.live.listingId]
      }),
      {
        sql: `UPDATE listing_owners SET revoked_at=?,revoked_reason='submission_rejected'
          WHERE listing_id=? AND revoked_at IS NULL`,
        params: [input.now, input.live.listingId]
      }
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
    // An active block on the same key is kept, and widened to cover subdomains when this one
    // does (a pre-#62 row blocks only its exact host; a later native row covers the domain).
    plans.push(
      {
        sql: `INSERT INTO listing_submission_url_blocks
          (url_key,covers_subdomains,submission_id,reason,blocked_by,blocked_at)
          SELECT COALESCE(block_key,slug),COALESCE(block_covers_subdomains,0),id,?,?,?
          FROM listing_submissions WHERE id=? AND status='rejected'
          ON CONFLICT(url_key) WHERE lifted_at IS NULL
          DO UPDATE SET covers_subdomains=MAX(covers_subdomains,excluded.covers_subdomains)`,
        params: [input.reason, input.reviewer, input.now, input.submissionId]
      },
      assertGuard('prohibited_url_blocked', {
        sql: `EXISTS (SELECT 1 FROM listing_submission_url_blocks b
          JOIN listing_submissions s ON COALESCE(s.block_key,s.slug)=b.url_key
          WHERE s.id=? AND b.lifted_at IS NULL)`,
        params: [input.submissionId]
      })
    )
  }
  if (input.live) plans.push(...finishCatalogPublicationPlans(input.live.publication))
  return plans
}

/**
 * The refund's own badge check (#66 review round 2): check `?` is this listing's latest `refund`
 * check, made at or after `?`, and (`passed`) passed or (`!passed`) did not. The refund decides on
 * that check alone, so an earlier weekly pass can neither keep a listing whose refund check
 * missed or couldn't tell, nor block its unpublish.
 */
function refundBadgeCheck(passed: boolean, recorded: boolean): string {
  const outcome = passed ? "rc.outcome='pass'" : "rc.outcome<>'pass'"
  const check = `rc.id=? AND rc.listing_id=s.listing_id AND rc.kind='refund' AND rc.checked_at>=?
    AND ${outcome}`
  // A decision recorded with a claimed refund (#68) is final: newer checks don't undo it.
  if (recorded) return `EXISTS (SELECT 1 FROM badge_checks rc WHERE ${check})`
  return `EXISTS (SELECT 1 FROM badge_checks rc WHERE ${check}
    AND NOT EXISTS (SELECT 1 FROM badge_checks later WHERE later.listing_id=rc.listing_id
      AND later.kind='refund' AND (later.checked_at>rc.checked_at
        OR (later.checked_at=rc.checked_at AND later.id>rc.id))))`
}

/**
 * Records a refund of a paid submission (`refunded_at`; #59 amendment 2026-10-06):
 * - `after_rejection`: only a rejection tagged `other` (a `prohibited` one is never refunded;
 *   a CHECK refuses that combination); the rejection already unpublished it.
 * - `keep_free`: an approved paid listing whose refund badge check (`badgeCheckId`, recorded by
 *   `checkBadgeAtRefund` within `REFUND_BADGE_CHECK_MAX_AGE_HOURS`) passed stays live as a free
 *   listing: its plan becomes `free` (paid → free), the badge program applies from now on, and
 *   the event records that check.
 * - `unpublish`: an approved paid listing that is live, whose refund badge check missed or
 *   couldn't tell (owner decision, 2026-10-06), is taken down in the same batch.
 * - `already_unpublished`: an approved paid listing that is already down (unpublished by an
 *   admin, or deleted) is refunded without touching the catalog.
 */
export function buildRefundSubmissionPlans(
  input: {
    actor: string
    /**
     * When the refund was decided and claimed (#68's `orders.refund_requested_at`): the badge
     * check recorded with that claim then decides, whatever its age at `now` and whatever
     * checks came after it. Without it, the check must be the listing's latest refund check
     * and recent at `now`.
     */
    decidedAt?: string
    now: string
    submissionId: string
  } & (
    | { mode: 'after_rejection' }
    | { mode: 'already_unpublished' }
    | { badgeCheckId: number; mode: 'keep_free' }
    | { badgeCheckId: number; mode: 'unpublish'; publication: CatalogPublication }
  )
): StatementPlan[] {
  const paid = `s.id=? AND s.plan='paid' AND s.paid_at IS NOT NULL AND s.refunded_at IS NULL`
  const checkWindow = hoursBefore(input.decidedAt ?? input.now, REFUND_BADGE_CHECK_MAX_AGE_HOURS)
  const recorded = input.decidedAt !== undefined
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
      ...refund(
        { sql: `s.status='rejected' AND s.rejection_category='other'`, params: [] },
        'paid',
        'rejected_submission_refunded'
      ),
      event(input.submissionId, 'refunded', input.actor, 'after_rejection')
    ]
  }
  const live = listingIsLiveGuard('s.listing_id')
  if (input.mode === 'already_unpublished') {
    return [
      ...refund(
        { sql: `s.status='approved' AND NOT ${live}`, params: [] },
        'paid',
        'unpublished_listing_refunded'
      ),
      event(input.submissionId, 'refunded', input.actor, 'already_unpublished')
    ]
  }
  if (input.mode === 'keep_free') {
    return [
      ...refund(
        {
          sql: `s.status='approved' AND ${live} AND ${refundBadgeCheck(true, recorded)}`,
          params: [input.badgeCheckId, checkWindow]
        },
        'free',
        'refunded_listing_kept_free'
      ),
      {
        sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
          SELECT s.id,'refunded',json_object('mode','kept_as_free',
            'badge_check_id',c.id,'badge_checked_at',c.checked_at),?
          FROM listing_submissions s JOIN badge_checks c ON c.id=? AND c.listing_id=s.listing_id
          WHERE s.id=?`,
        params: [input.actor, input.badgeCheckId, input.submissionId]
      },
      assertPreviousStatementChangedOne('kept_free_badge_recorded')
    ]
  }
  const condition = `s.status='approved' AND ${live} AND ${refundBadgeCheck(false, recorded)}`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_submissions s WHERE ${paid} AND ${condition})`,
      params: [input.submissionId, input.badgeCheckId, checkWindow]
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
 * Replaces a submission's staged content (event `edited`) and increments its
 * `content_version`. With `ownerUserId` it is the owner's edit, allowed only in a `draft`,
 * `pending_badge`, or `changes_requested` (never while in the review queue). Without it, it is a
 * reviewer's edit before deciding, in any non-final status. Pass `expectedContentVersion` to
 * refuse an edit of content that changed since it was read. Website and slug never change.
 */
export function buildReplaceSubmissionContentPlans(input: {
  actor: string
  content: StagedListingContent & { content: string }
  /** Recorded on the `edited` event, for example the fields a reviewer changed (JSON). */
  eventDetail?: string
  expectedContentVersion?: number
  expectedStatuses: readonly SubmissionStatus[]
  now: string
  ownerUserId?: string
  submissionId: string
}): StatementPlan[] {
  const editable: readonly string[] =
    input.ownerUserId === undefined
      ? submissionTransitions.edit.from
      : submissionTransitions.ownerEdit.from
  if (
    input.expectedStatuses.length === 0 ||
    input.expectedStatuses.some(status => !editable.includes(status))
  ) {
    throw new Error(
      input.ownerUserId === undefined
        ? 'Submission content can only be edited before a final decision.'
        : 'The owner edits a submission only as a draft, before badge verification, or when changes are requested.'
    )
  }
  const owner = input.ownerUserId === undefined ? '' : ' AND owner_user_id=?'
  const version = input.expectedContentVersion === undefined ? '' : ' AND content_version=?'
  return [
    {
      sql: `UPDATE listing_submissions
        SET name=?,description=?,content=?,category_slug=?,logo_url=?,video_url=?,updated_at=?,
          content_version=content_version+1
        WHERE id=? AND status IN (${statusList(input.expectedStatuses)})${owner}${version}`,
      params: [
        input.content.name,
        input.content.description,
        input.content.content,
        input.content.categorySlug,
        input.content.logoUrl,
        input.content.videoUrl ?? null,
        input.now,
        input.submissionId,
        ...(input.ownerUserId === undefined ? [] : [input.ownerUserId]),
        ...(input.expectedContentVersion === undefined
          ? []
          : [contentVersion(input.expectedContentVersion)])
      ]
    },
    assertPreviousStatementChangedOne('submission_content_replaced'),
    ...replaceStagedChildrenPlans(submissionContentSource(input.submissionId), input.content),
    event(input.submissionId, 'edited', input.actor, input.eventDetail ?? null)
  ]
}

/**
 * The owner replaces the FAQs and resource links of a submission waiting for review (#65),
 * compare-and-swapping on the content version they edited. Name, descriptions, category, and
 * logo stay as the reviewer sees them; the version moves, so an approval of the older content is
 * refused and the reviewer reloads.
 */
export function buildReplaceSubmissionExtrasPlans(input: {
  content: Pick<StagedListingContent, 'faqs' | 'resourceLinks'>
  expectedContentVersion: number
  now: string
  ownerUserId: string
  submissionId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE listing_submissions SET content_version=content_version+1,updated_at=?
        WHERE id=? AND owner_user_id=? AND content_version=?
          AND status IN (${statusList(submissionTransitions.ownerExtras.from)})`,
      params: [
        input.now,
        input.submissionId,
        input.ownerUserId,
        contentVersion(input.expectedContentVersion)
      ]
    },
    assertPreviousStatementChangedOne('submission_extras_replaced'),
    ...replaceStagedChildrenPlans(submissionContentSource(input.submissionId), input.content),
    event(
      input.submissionId,
      'edited',
      input.ownerUserId,
      JSON.stringify({ fields: ['faqs', 'resourceLinks'] })
    )
  ]
}

/** The actor of an owner's listing badge check events (#65), apart from the badge step's. */
export const LISTING_BADGE_CHECK_ACTOR = 'account-badge-check'

/** What a listing badge check compares and swaps against (#65). */
export interface ListingBadgeCheckClaim {
  /** `YYYY-MM-DD HH:MM:SS` (UTC), as the badge step's claim writes `last_verification_at`. */
  claimedAt: string
  /** Checks whose result counts against the cap (a conclusive failure). */
  conclusiveCodes: readonly string[]
  /** `last_verification_at` at or before this is past the cooldown. */
  cooldownCutoff: string
  /** Checks that found a result in the window, at most (10 per listing per 24 hours). */
  maxChecks: number
  now: string
  ownerUserId: string
  submissionId: string
  /** `YYYY-MM-DD HH:MM:SS` (UTC): the start of the window the cap counts. */
  windowStart: string
}

/** Events of the owner's listing checks that found a result, on the submission `s`. */
function countedListingChecks(submissionSql: string): string {
  return `(SELECT COUNT(*) FROM listing_submission_events e
    WHERE e.submission_id=${submissionSql} AND e.actor='${LISTING_BADGE_CHECK_ACTOR}'
      AND e.created_at>?
      AND (e.event_type='badge_verified' OR e.detail IN (SELECT value FROM json_each(?))))`
}

/**
 * The owner claims one badge check of their live free listing (#65), before anything is
 * fetched: the listing's approved free, unpaid submission, its listing live and still theirs,
 * past the 30-second cooldown, and under its own cap of checks that found a result in the last
 * 24 hours (round-1 review of #102: the badge step's lifetime cap of ten could lock the panel
 * forever). The claim and its result live on the submission (`last_verification_at`, an event),
 * never in `badge_checks`, which holds the badge program's checks (#66) only.
 */
export function buildClaimListingBadgeCheckPlans(input: ListingBadgeCheckClaim): StatementPlan[] {
  if (!Number.isSafeInteger(input.maxChecks) || input.maxChecks < 1) {
    throw new Error('A badge check cap is a positive integer.')
  }
  return [
    {
      sql: `UPDATE listing_submissions SET last_verification_at=?,updated_at=?
        WHERE id=? AND owner_user_id=?
          AND status IN (${statusList(submissionTransitions.listingBadgeCheck.from)})
          AND plan='free' AND paid_at IS NULL AND listing_id IS NOT NULL
          AND ${listingIsLiveGuard('listing_submissions.listing_id')}
          AND EXISTS (SELECT 1 FROM listing_owners o
            WHERE o.listing_id=listing_submissions.listing_id
              AND o.user_id=listing_submissions.owner_user_id
              AND o.role='owner' AND o.revoked_at IS NULL)
          AND (last_verification_at IS NULL OR last_verification_at<=?)
          AND ${countedListingChecks('listing_submissions.id')}<?`,
      params: [
        input.claimedAt,
        input.now,
        input.submissionId,
        input.ownerUserId,
        input.cooldownCutoff,
        input.windowStart,
        JSON.stringify(input.conclusiveCodes),
        input.maxChecks
      ]
    },
    assertPreviousStatementChangedOne('listing_badge_check_claimed')
  ]
}

/**
 * Records a claimed listing badge check (#65), compare-and-swapping on the claim, so a check
 * overtaken by a later claim records nothing. The event (actor `account-badge-check`, stamped
 * with the check's time) is the owner-visible history and what the 24-hour cap counts: a pass or
 * a conclusive failure counts, a connection problem doesn't. The badge step's own counters
 * (`verification_attempts`) are left alone.
 */
export function buildFinishListingBadgeCheckPlans(input: {
  claimedAt: string
  now: string
  ownerUserId: string
  result: { ok: true } | { code: string; ok: false }
  submissionId: string
}): StatementPlan[] {
  const error = input.result.ok ? null : input.result.code
  const stamp = input.now.slice(0, 19).replace('T', ' ')
  return [
    {
      sql: `UPDATE listing_submissions SET last_verification_error=?,updated_at=?
        WHERE id=? AND owner_user_id=? AND last_verification_at=?
          AND status IN (${statusList(submissionTransitions.listingBadgeCheck.from)})`,
      params: [error, input.now, input.submissionId, input.ownerUserId, input.claimedAt]
    },
    assertPreviousStatementChangedOne('listing_badge_check_recorded'),
    {
      sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor,created_at)
        VALUES (?,?,?,?,?)`,
      params: [
        input.submissionId,
        input.result.ok ? 'badge_verified' : 'verification_failed',
        // An inconclusive failure is recorded without counting: its code is not in the list.
        error,
        LISTING_BADGE_CHECK_ACTOR,
        stamp
      ]
    }
  ]
}

/** An admin lifts the active prohibited-URL block for a block key (a registrable domain). */
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

/**
 * Paid submissions rejected as `other` whose refund isn't recorded yet, oldest rejection first
 * (#64 review). The rejection batch is the refund-pending marker: it sets `status='rejected'`
 * and `rejection_category='other'` on a row with `paid_at` set and `refunded_at` null, and
 * `buildRefundSubmissionPlans` (`after_rejection`) clears it by recording `refunded_at`. A
 * replayed rejection and #68's refund sweep retry the rows this returns.
 */
export function selectRefundPendingSubmissionsPlan(limit: number): StatementPlan {
  return {
    sql: `SELECT id,slug,paid_at,reviewed_at FROM listing_submissions
      WHERE status='rejected' AND rejection_category='other'
        AND paid_at IS NOT NULL AND refunded_at IS NULL
      ORDER BY reviewed_at,id LIMIT ?`,
    params: [limit]
  }
}
