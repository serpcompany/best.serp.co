import { urlKey } from '@serpdirectory/utils/url-key'
import type { Database } from './client'
import { listingIdsWithWebsite } from './listing-plans'
import { executePlans, isPlanConflict, queryPlan } from './plan-runner'
import {
  assertPreviousStatementChangedOne,
  listingIsLiveGuard,
  type StatementPlan
} from './plan-support'
import type {
  OrderAttention,
  OrderKind,
  OrderOutcome,
  OrderPurpose,
  OrderRefundListingAction,
  OrderRefundReason,
  OrderStatus,
  RejectionCategory,
  SubmissionPlan,
  SubmissionStatus
} from './schema'
import { selectRefundPendingSubmissionsPlan } from './submission-plans'
import { selectActiveUrlBlockStatement } from './submissions'

/**
 * Billing ledger (serpcompany/best.serp.co#68): `orders` and `billing_events`. The app's
 * billing module (`apps/web/lib/billing/`) composes these statement plans with the submission
 * and listing plans and never prepares SQL itself. Every write is a compare-and-swap on the
 * order's status, so a replayed webhook, a return from checkout, and the hourly sweep can all
 * run the same step and only one of them changes anything.
 */

export interface OrderRecord {
  amountCents: number
  appliedAt: string | null
  attention: OrderAttention | null
  chargedCents: number | null
  chargedCurrency: string | null
  /** The guardrail check that held a paid submission for review. */
  checkProblem: string | null
  checkoutExpiresAt: string | null
  checkoutUrl: string | null
  claimId: string | null
  createdAt: string
  currency: string
  failureReason: string | null
  id: string
  kind: OrderKind
  listingId: string | null
  /** The number people see: `ORD-<number>`. */
  number: number
  outcome: OrderOutcome | null
  paidAt: string | null
  provider: string
  providerCheckoutId: string | null
  providerPaymentId: string | null
  providerRefundId: string | null
  purpose: OrderPurpose
  refundBadgeCheckId: number | null
  refundListingAction: OrderRefundListingAction | null
  refundNote: string | null
  refundReason: OrderRefundReason | null
  refundRequestedAt: string | null
  refundedAt: string | null
  refundedBy: string | null
  status: OrderStatus
  submissionId: string | null
  targetKey: string
  updatedAt: string
  userId: string
}

type Row = Record<string, unknown>

const ORDER_COLUMNS = `o.id,o.number,o.check_problem,o.refund_note,o.user_id,o.kind,o.purpose,o.target_key,o.submission_id,o.listing_id,
  o.claim_id,o.amount_cents,o.currency,o.provider,o.provider_checkout_id,o.checkout_url,
  o.checkout_expires_at,o.provider_payment_id,o.provider_refund_id,o.status,o.outcome,
  o.failure_reason,o.refund_reason,o.refunded_by,o.paid_at,o.applied_at,o.refunded_at,
  o.charged_cents,o.charged_currency,o.attention,o.refund_listing_action,o.refund_badge_check_id,
  o.refund_requested_at,o.created_at,o.updated_at`

function optional(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toOrder(row: Row): OrderRecord {
  return {
    amountCents: Number(row.amount_cents),
    appliedAt: optional(row.applied_at),
    attention: optional(row.attention) as OrderAttention | null,
    chargedCents:
      row.charged_cents === null || row.charged_cents === undefined
        ? null
        : Number(row.charged_cents),
    chargedCurrency: optional(row.charged_currency),
    checkProblem: optional(row.check_problem),
    checkoutExpiresAt: optional(row.checkout_expires_at),
    checkoutUrl: optional(row.checkout_url),
    claimId: optional(row.claim_id),
    createdAt: String(row.created_at),
    currency: String(row.currency),
    failureReason: optional(row.failure_reason),
    id: String(row.id),
    kind: row.kind as OrderKind,
    listingId: optional(row.listing_id),
    number: Number(row.number),
    outcome: optional(row.outcome) as OrderOutcome | null,
    paidAt: optional(row.paid_at),
    provider: String(row.provider),
    providerCheckoutId: optional(row.provider_checkout_id),
    providerPaymentId: optional(row.provider_payment_id),
    providerRefundId: optional(row.provider_refund_id),
    purpose: row.purpose as OrderPurpose,
    refundBadgeCheckId:
      row.refund_badge_check_id === null || row.refund_badge_check_id === undefined
        ? null
        : Number(row.refund_badge_check_id),
    refundListingAction: optional(row.refund_listing_action) as OrderRefundListingAction | null,
    refundNote: optional(row.refund_note),
    refundReason: optional(row.refund_reason) as OrderRefundReason | null,
    refundRequestedAt: optional(row.refund_requested_at),
    refundedAt: optional(row.refunded_at),
    refundedBy: optional(row.refunded_by),
    status: row.status as OrderStatus,
    submissionId: optional(row.submission_id),
    targetKey: String(row.target_key),
    updatedAt: String(row.updated_at),
    userId: String(row.user_id)
  }
}

/** The order's target key: one open (`pending`) order per target (`orders_open_target_idx`). */
export function orderTargetKey(
  target:
    | { purpose: 'claim'; claimId: string }
    | { purpose: 'relist' | 'upgrade'; listingId: string }
    | { purpose: 'submission'; submissionId: string }
): string {
  if (target.purpose === 'claim') return `claim:${target.claimId}`
  if (target.purpose === 'submission') return `submission:${target.submissionId}`
  return `listing:${target.listingId}`
}

export interface NewOrder {
  amountCents: number
  claimId?: string | null
  currency: string
  id: string
  listingId?: string | null
  now: string
  provider: string
  purpose: OrderPurpose
  submissionId?: string | null
  userId: string
}

function newOrderTargetKey(input: NewOrder): string {
  if (input.purpose === 'claim') {
    return orderTargetKey({ claimId: input.claimId ?? '', purpose: 'claim' })
  }
  if (input.purpose === 'submission') {
    return orderTargetKey({ purpose: 'submission', submissionId: input.submissionId ?? '' })
  }
  return orderTargetKey({ listingId: input.listingId ?? '', purpose: input.purpose })
}

/** A new `pending` order. A second open order for the same target is refused by the index. */
export function buildCreateOrderPlans(input: NewOrder): StatementPlan[] {
  const kind: OrderKind = input.purpose === 'claim' ? 'paid_claim' : 'paid_listing'
  const targetKey = newOrderTargetKey(input)
  return [
    {
      // Order numbers run from 1001; the unique index refuses a number two inserts raced for.
      sql: `INSERT INTO orders (id,number,user_id,kind,purpose,target_key,submission_id,
          listing_id,claim_id,amount_cents,currency,provider,status,created_at,updated_at)
        SELECT ?,COALESCE((SELECT MAX(number) FROM orders),1000)+1,?,?,?,?,?,?,?,?,?,?,'pending',?,?`,
      params: [
        input.id,
        input.userId,
        kind,
        input.purpose,
        targetKey,
        input.submissionId ?? null,
        input.listingId ?? null,
        input.claimId ?? null,
        input.amountCents,
        input.currency,
        input.provider,
        input.now,
        input.now
      ]
    }
  ]
}

/** Stores the provider's checkout on a pending order. */
export function buildAttachCheckoutPlans(input: {
  checkoutId: string
  expiresAt: string
  now: string
  orderId: string
  url: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE orders SET provider_checkout_id=?,checkout_url=?,checkout_expires_at=?,
          updated_at=?
        WHERE id=? AND status='pending'`,
      params: [input.checkoutId, input.url, input.expiresAt, input.now, input.orderId]
    },
    assertPreviousStatementChangedOne('order_checkout_attached')
  ]
}

/**
 * `pending` (or `failed`, a checkout the provider reported failed and then paid) → `paid`,
 * recording what the provider actually charged. A charge that doesn't match the order is
 * recorded with `attention = 'amount_mismatch'` and never applied: the caller refunds it.
 */
export function buildMarkOrderPaidPlans(input: {
  attention?: OrderAttention | null
  chargedCents: number
  chargedCurrency: string
  now: string
  orderId: string
  paymentId: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE orders SET status='paid',provider_payment_id=?,charged_cents=?,charged_currency=?,
          attention=COALESCE(?,attention),paid_at=?,failed_at=NULL,failure_reason=NULL,updated_at=?
        WHERE id=? AND status IN ('pending','failed')`,
      params: [
        input.paymentId,
        input.chargedCents,
        input.chargedCurrency,
        input.attention ?? null,
        input.now,
        input.now,
        input.orderId
      ]
    },
    assertPreviousStatementChangedOne('order_paid')
  ]
}

/**
 * Records what a paid order did, once (`applied_at`). Sent in the same batch as the plans that
 * applied it (the submission's payment, the upgrade, the relist), so both happen or neither.
 */
export function buildMarkOrderAppliedPlans(input: {
  /** The guardrail check that held the submission (`held` only). */
  checkProblem?: string | null
  now: string
  orderId: string
  outcome: OrderOutcome
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE orders SET outcome=?,check_problem=?,applied_at=?,updated_at=?
        WHERE id=? AND status='paid' AND applied_at IS NULL`,
      params: [input.outcome, input.checkProblem ?? null, input.now, input.now, input.orderId]
    },
    assertPreviousStatementChangedOne('order_applied')
  ]
}

/** `pending` → `failed`: the checkout expired or its payment failed. */
export function buildMarkOrderFailedPlans(input: {
  now: string
  orderId: string
  reason: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE orders SET status='failed',failure_reason=?,failed_at=?,updated_at=?
        WHERE id=? AND status='pending'`,
      params: [input.reason, input.now, input.now, input.orderId]
    },
    assertPreviousStatementChangedOne('order_failed')
  ]
}

/**
 * Claims a refund: `paid` → `refunding`, compared and swapped on the state the refund was
 * decided on, before the provider is asked. `unapplied` claims a payment nothing applied yet
 * (it is recorded as applied with the outcome `unapplied` in the same statement), so a racing
 * fulfilment can no longer apply it; `applied` claims an order applied with `outcome`, so an
 * order applied in the meantime is never refunded as unapplied. An admin's refund records the
 * listing action it decided (and its badge check), so a retry finishes the same decision.
 */
export function buildClaimRefundPlans(
  input: {
    actor: string
    badgeCheckId?: number | null
    listingAction?: OrderRefundListingAction | null
    /** The admin's reason for the activity log. */
    note?: string | null
    now: string
    orderId: string
    reason: OrderRefundReason
  } & ({ from: 'unapplied' } | { from: 'applied'; outcome: OrderOutcome })
): StatementPlan[] {
  const unapplied = input.from === 'unapplied'
  if ((input.reason === 'admin') !== Boolean(input.listingAction)) {
    throw new Error('An admin refund (and only one) records its listing action.')
  }
  return [
    {
      sql: `UPDATE orders SET status='refunding',refund_reason=?,refunded_by=?,refund_requested_at=?,
          refund_listing_action=?,refund_badge_check_id=?,refund_note=?,
          ${unapplied ? "outcome='unapplied',applied_at=?," : ''}updated_at=?
        WHERE id=? AND status='paid'
          AND ${unapplied ? 'applied_at IS NULL' : 'applied_at IS NOT NULL AND outcome=?'}`,
      params: [
        input.reason,
        input.actor,
        input.now,
        input.listingAction ?? null,
        input.badgeCheckId ?? null,
        input.note?.trim() || null,
        ...(unapplied ? [input.now] : []),
        input.now,
        input.orderId,
        ...(input.from === 'applied' ? [input.outcome] : [])
      ]
    },
    assertPreviousStatementChangedOne('order_refund_claimed')
  ]
}

/** `refunding` → `refunded`, once the provider confirmed the refund. */
export function buildFinishRefundPlans(input: {
  attention?: OrderAttention | null
  now: string
  orderId: string
  refundId: string | null
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE orders SET status='refunded',provider_refund_id=?,refunded_at=?,
          attention=COALESCE(?,attention),updated_at=?
        WHERE id=? AND status='refunding'`,
      params: [input.refundId, input.now, input.attention ?? null, input.now, input.orderId]
    },
    assertPreviousStatementChangedOne('order_refunded')
  ]
}

export function selectOrderPlan(orderId: string): StatementPlan {
  return { sql: `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id=?`, params: [orderId] }
}

export function selectOrderByCheckoutPlan(provider: string, checkoutId: string): StatementPlan {
  return {
    sql: `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.provider=? AND o.provider_checkout_id=?`,
    params: [provider, checkoutId]
  }
}

export function selectOpenOrderPlan(targetKey: string): StatementPlan {
  return {
    sql: `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.target_key=? AND o.status='pending'`,
    params: [targetKey]
  }
}

/**
 * The paid order applied to a submission (its own new paid submission), the one an `other`
 * rejection refunds. Newest first, in case a refunded one came before.
 */
export function selectSubmissionPaymentOrderPlan(submissionId: string): StatementPlan {
  return {
    sql: `SELECT ${ORDER_COLUMNS} FROM orders o
      WHERE o.submission_id=? AND o.status IN ('paid','refunding','refunded')
        AND o.outcome IN ('published','held','upgraded','relisted')
      ORDER BY o.paid_at DESC,o.id DESC LIMIT 1`,
    params: [submissionId]
  }
}

/**
 * Orders the hourly sweep looks at again: pending orders whose checkout should have finished
 * (`before`); failed orders whose checkout might still have been paid (since `failedSince`,
 * the provider's retry window); paid orders never applied (a crash between recording the
 * payment and applying it); and claimed refunds a failure left unfinished.
 */
export function selectOrdersToReconcilePlan(input: {
  before: string
  failedSince: string
  limit: number
}): StatementPlan {
  return {
    sql: `SELECT ${ORDER_COLUMNS} FROM orders o
      WHERE (o.status='pending' AND o.provider_checkout_id IS NOT NULL
          AND o.checkout_expires_at<?)
        OR (o.status='failed' AND o.provider_checkout_id IS NOT NULL AND o.failed_at>=?
          AND o.failed_at<?)
        OR (o.status='paid' AND o.applied_at IS NULL AND o.paid_at<?)
        OR (o.status='refunding' AND o.refund_requested_at<?)
      ORDER BY o.created_at,o.id LIMIT ?`,
    params: [input.before, input.failedSince, input.before, input.before, input.before, input.limit]
  }
}

/** The submission a checkout or payment is for, scoped to its owner. */
export interface CheckoutSubmission {
  categoryName: string | null
  draftSavedAt: string | null
  id: string
  listingId: string | null
  name: string
  ownerEmail: string | null
  ownerUserId: string
  paidAt: string | null
  plan: SubmissionPlan | null
  refundedAt: string | null
  slug: string
  status: SubmissionStatus
  website: string
}

export function selectCheckoutSubmissionPlan(submissionId: string): StatementPlan {
  return {
    sql: `SELECT s.id,s.name,s.slug,s.website,s.status,s.plan,s.paid_at,s.refunded_at,
        s.listing_id,s.owner_user_id,s.draft_saved_at,c.name AS category_name,u.email AS owner_email
      FROM listing_submissions s
        LEFT JOIN categories c ON c.slug=s.category_slug
        LEFT JOIN users u ON u.id=s.owner_user_id
      WHERE s.id=?`,
    params: [submissionId]
  }
}

function toCheckoutSubmission(row: Row): CheckoutSubmission {
  return {
    categoryName: optional(row.category_name),
    draftSavedAt: optional(row.draft_saved_at),
    id: String(row.id),
    listingId: optional(row.listing_id),
    name: String(row.name),
    ownerEmail: optional(row.owner_email),
    ownerUserId: String(row.owner_user_id ?? ''),
    paidAt: optional(row.paid_at),
    plan: optional(row.plan) as SubmissionPlan | null,
    refundedAt: optional(row.refunded_at),
    slug: String(row.slug),
    status: row.status as SubmissionStatus,
    website: String(row.website)
  }
}

/**
 * A listing an owner can pay for from the account: the upgrade of a live free listing, or the
 * relist of one the badge program unlisted (`unpublished` with reason `badge_missing`).
 */
export interface CheckoutListing {
  id: string
  live: boolean
  name: string
  ownerEmail: string | null
  ownerUserId: string
  slug: string
  submission: {
    id: string
    paidAt: string | null
    plan: SubmissionPlan | null
    status: SubmissionStatus
    /** The latest `unpublished` event's reason on the approved submission. */
    unpublishedReason: string | null
  } | null
}

export function selectCheckoutListingPlan(
  listing: { listingId: string } | { slug: string },
  userId: string
): StatementPlan {
  const byId = 'listingId' in listing
  return {
    sql: `SELECT l.id,l.slug,l.name,o.user_id AS owner_user_id,u.email AS owner_email,
        CASE WHEN ${listingIsLiveGuard('l.id')} THEN 1 ELSE 0 END AS live,
        s.id AS submission_id,s.status AS submission_status,s.plan,s.paid_at,
        (SELECT e.detail FROM listing_submission_events e
          WHERE e.submission_id=s.id AND e.event_type='unpublished'
          ORDER BY e.id DESC LIMIT 1) AS unpublished_reason
      FROM listings l
        JOIN listing_owners o ON o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL
          AND o.user_id=?
        LEFT JOIN users u ON u.id=o.user_id
        LEFT JOIN listing_submissions s ON s.id=(SELECT x.id FROM listing_submissions x
          WHERE x.listing_id=l.id AND x.status='approved' ORDER BY x.created_at DESC,x.id DESC LIMIT 1)
      WHERE ${byId ? 'l.id=?' : 'l.slug=?'}`,
    params: [userId, byId ? listing.listingId : listing.slug]
  }
}

function toCheckoutListing(row: Row): CheckoutListing {
  const submissionId = optional(row.submission_id)
  return {
    id: String(row.id),
    live: Number(row.live) === 1,
    name: String(row.name),
    ownerEmail: optional(row.owner_email),
    ownerUserId: String(row.owner_user_id),
    slug: String(row.slug),
    submission: submissionId
      ? {
          id: submissionId,
          paidAt: optional(row.paid_at),
          plan: optional(row.plan) as SubmissionPlan | null,
          status: row.submission_status as SubmissionStatus,
          unpublishedReason: optional(row.unpublished_reason)
        }
      : null
  }
}

/** The badge program's unpublish reason (`listing-unpublish`, #66): relisting is paid. */
export const RELISTABLE_UNPUBLISH_REASON = 'badge_missing'

/** True when the listing can be upgraded (live, free) or relisted (unlisted for its badge). */
export function listingCheckoutPurpose(listing: CheckoutListing): 'relist' | 'upgrade' | null {
  const submission = listing.submission
  if (
    !submission ||
    submission.status !== 'approved' ||
    submission.plan !== 'free' ||
    submission.paidAt !== null
  ) {
    return null
  }
  if (listing.live) return 'upgrade'
  return submission.unpublishedReason === RELISTABLE_UNPUBLISH_REASON ? 'relist' : null
}

/** What the guardrails need to know about a website before a paid listing goes live. */
export interface WebsiteConflicts {
  blocked: boolean
  listed: boolean
}

// ---------------------------------------------------------------------------------------------
// Webhook events

/** `process`: run the event (first delivery, or one that stopped midway); `processed`: a replay. */
export type BillingEventClaim = 'process' | 'processed'

export function buildRecordBillingEventPlans(input: {
  eventId: string
  eventType: string
  now: string
  provider: string
}): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO billing_events (provider,event_id,event_type,received_at)
        VALUES (?,?,?,?) ON CONFLICT(provider,event_id) DO NOTHING`,
      params: [input.provider, input.eventId, input.eventType, input.now]
    }
  ]
}

export function buildFinishBillingEventPlans(input: {
  eventId: string
  now: string
  orderId: string | null
  outcome: string
  provider: string
}): StatementPlan[] {
  return [
    {
      sql: `UPDATE billing_events SET processed_at=?,order_id=?,outcome=?
        WHERE provider=? AND event_id=? AND processed_at IS NULL`,
      params: [input.now, input.orderId, input.outcome, input.provider, input.eventId]
    }
  ]
}

// ---------------------------------------------------------------------------------------------
// Admin reads

export interface AdminOrderRow extends OrderRecord {
  buyerEmail: string | null
  /** The listing's latest badge check (any kind), for "Badge passing". */
  latestBadgeOutcome: 'fail' | 'pass' | null
  /** The listing's hosted logo key, or null for the fallback tile. */
  logoKey: string | null
  rejectionCategory: RejectionCategory | null
  submissionPlan: SubmissionPlan | null
  /** Whether the target listing is live now. */
  listingLive: boolean
  listingSlug: string | null
  productName: string | null
  submissionStatus: SubmissionStatus | null
  website: string | null
}

const ADMIN_ORDER_LIMIT = 500

export function selectAdminOrdersPlan(): StatementPlan {
  return {
    sql: `SELECT ${ORDER_COLUMNS},u.email AS buyer_email,
        COALESCE(l.name,s.name) AS product_name,COALESCE(l.slug,sl.slug) AS listing_slug,
        COALESCE(l.website,s.website) AS website,s.status AS submission_status,
        CASE WHEN ${listingIsLiveGuard('COALESCE(o.listing_id,s.listing_id)')} THEN 1 ELSE 0 END
          AS listing_live,s.plan AS submission_plan,s.rejection_category,
        (SELECT m.media_key FROM listing_media m WHERE m.listing_id=COALESCE(o.listing_id,s.listing_id)
          AND m.kind='logo' AND m.media_key IS NOT NULL ORDER BY m.sort_order LIMIT 1) AS logo_key,
        (SELECT b.outcome FROM badge_checks b WHERE b.listing_id=COALESCE(o.listing_id,s.listing_id)
          ORDER BY b.checked_at DESC,b.id DESC LIMIT 1) AS latest_badge_outcome
      FROM orders o
        LEFT JOIN users u ON u.id=o.user_id
        LEFT JOIN listing_submissions s ON s.id=o.submission_id
        LEFT JOIN listings l ON l.id=o.listing_id
        LEFT JOIN listings sl ON sl.id=s.listing_id
      ORDER BY o.created_at DESC,o.id DESC LIMIT ${ADMIN_ORDER_LIMIT}`,
    params: []
  }
}

function toAdminOrder(row: Row): AdminOrderRow {
  return {
    ...toOrder(row),
    buyerEmail: optional(row.buyer_email),
    latestBadgeOutcome: optional(row.latest_badge_outcome) as 'fail' | 'pass' | null,
    logoKey: optional(row.logo_key),
    rejectionCategory: optional(row.rejection_category) as RejectionCategory | null,
    submissionPlan: optional(row.submission_plan) as SubmissionPlan | null,
    listingLive: Number(row.listing_live) === 1,
    listingSlug: optional(row.listing_slug),
    productName: optional(row.product_name),
    submissionStatus: optional(row.submission_status) as SubmissionStatus | null,
    website: optional(row.website)
  }
}

// ---------------------------------------------------------------------------------------------
// Operations

export interface BillingOperations {
  adminOrders(): Promise<AdminOrderRow[]>
  /** Sends plans as one batch; false when a compare-and-swap or constraint refused it. */
  apply(plans: StatementPlan[]): Promise<boolean>
  /** A listing the user owns, by slug (the account) or id (an order). */
  checkoutListing(
    input: ({ listingId: string } | { slug: string }) & { userId: string }
  ): Promise<CheckoutListing | null>
  checkoutSubmission(submissionId: string): Promise<CheckoutSubmission | null>
  /** Records the event once; `processed` when an earlier delivery finished it (a replay). */
  claimEvent(input: {
    eventId: string
    eventType: string
    now: string
    provider: string
  }): Promise<BillingEventClaim>
  createOrder(input: NewOrder): Promise<OrderRecord>
  finishEvent(input: {
    eventId: string
    now: string
    orderId: string | null
    outcome: string
    provider: string
  }): Promise<void>
  /** Whether the listing is live (public) now. */
  listingLive(listingId: string | null): Promise<boolean>
  openOrder(targetKey: string): Promise<OrderRecord | null>
  order(orderId: string): Promise<OrderRecord | null>
  orderByCheckout(provider: string, checkoutId: string): Promise<OrderRecord | null>
  ordersToReconcile(input: {
    before: string
    failedSince: string
    limit: number
  }): Promise<OrderRecord[]>
  /** A badge check at refund (`kind = 'refund'`), to confirm the one an admin's dialog showed. */
  refundBadgeCheck(
    checkId: number
  ): Promise<{ checkedAt: string; id: number; listingId: string; outcome: 'fail' | 'pass' } | null>
  /** Paid submissions rejected as `other` whose refund isn't recorded yet, oldest first. */
  refundPendingSubmissions(limit: number): Promise<string[]>
  /** A rejected submission's category and reason. */
  rejection(submissionId: string): Promise<{ category: RejectionCategory; reason: string } | null>
  /** The catalog publication state a catalog write compares and swaps against. */
  publicationState(): Promise<{ checksum: string; version: number }>
  submissionPaymentOrder(submissionId: string): Promise<OrderRecord | null>
  /** Whether another listing already has the website, or a prohibited block covers it. */
  websiteConflicts(website: string): Promise<WebsiteConflicts>
}

export function createBillingOperations(config: { client: Database }): BillingOperations {
  const { client } = config

  async function first<T>(plan: StatementPlan, map: (row: Row) => T): Promise<T | null> {
    const [row] = await queryPlan<Row>(client, plan)
    return row ? map(row) : null
  }

  async function apply(plans: StatementPlan[]): Promise<boolean> {
    try {
      await executePlans(client, plans)
      return true
    } catch (error) {
      if (isPlanConflict(error)) return false
      throw error
    }
  }

  return {
    async adminOrders() {
      return (await queryPlan<Row>(client, selectAdminOrdersPlan())).map(toAdminOrder)
    },
    apply,
    checkoutListing: ({ userId, ...listing }) =>
      first(selectCheckoutListingPlan(listing, userId), toCheckoutListing),
    checkoutSubmission: submissionId =>
      first(selectCheckoutSubmissionPlan(submissionId), toCheckoutSubmission),
    async claimEvent(input) {
      await executePlans(client, buildRecordBillingEventPlans(input))
      const [row] = await queryPlan<{ processed_at: string | null }>(client, {
        sql: `SELECT processed_at FROM billing_events WHERE provider=? AND event_id=?`,
        params: [input.provider, input.eventId]
      })
      if (!row) throw new Error('The billing event was not recorded.')
      return row.processed_at === null ? 'process' : 'processed'
    },
    async createOrder(input) {
      let created = await apply(buildCreateOrderPlans(input))
      // Lost only the race for the next order number (no open order took the target): again.
      if (!created && !(await first(selectOpenOrderPlan(newOrderTargetKey(input)), toOrder))) {
        created = await apply(buildCreateOrderPlans(input))
      }
      const order = created
        ? await first(selectOrderPlan(input.id), toOrder)
        : await first(selectOpenOrderPlan(newOrderTargetKey(input)), toOrder)
      if (!order) throw new Error('The order could not be created.')
      return order
    },
    async finishEvent(input) {
      await executePlans(client, buildFinishBillingEventPlans(input))
    },
    async listingLive(listingId) {
      if (!listingId) return false
      const [row] = await queryPlan<{ live: number }>(client, {
        sql: `SELECT CASE WHEN ${listingIsLiveGuard('?')} THEN 1 ELSE 0 END AS live`,
        params: [listingId]
      })
      return Number(row?.live) === 1
    },
    openOrder: targetKey => first(selectOpenOrderPlan(targetKey), toOrder),
    order: orderId => first(selectOrderPlan(orderId), toOrder),
    orderByCheckout: (provider, checkoutId) =>
      first(selectOrderByCheckoutPlan(provider, checkoutId), toOrder),
    async ordersToReconcile(input) {
      return (await queryPlan<Row>(client, selectOrdersToReconcilePlan(input))).map(toOrder)
    },
    async refundBadgeCheck(checkId) {
      const [row] = await queryPlan<Row>(client, {
        sql: `SELECT id,listing_id,checked_at,outcome FROM badge_checks WHERE id=? AND kind='refund'`,
        params: [checkId]
      })
      return row
        ? {
            checkedAt: String(row.checked_at),
            id: Number(row.id),
            listingId: String(row.listing_id),
            outcome: row.outcome === 'pass' ? 'pass' : 'fail'
          }
        : null
    },
    async refundPendingSubmissions(limit) {
      const rows = await queryPlan<{ id: string }>(
        client,
        selectRefundPendingSubmissionsPlan(limit)
      )
      return rows.map(row => String(row.id))
    },
    async rejection(submissionId) {
      const [row] = await queryPlan<{
        rejection_category: string | null
        rejection_reason: string | null
      }>(client, {
        sql: `SELECT rejection_category,rejection_reason FROM listing_submissions
            WHERE id=? AND status='rejected'`,
        params: [submissionId]
      })
      if (!row?.rejection_category) return null
      return {
        category: row.rejection_category as RejectionCategory,
        reason: String(row.rejection_reason ?? '')
      }
    },
    async publicationState() {
      const [row] = await queryPlan<{ checksum: string; version: number }>(client, {
        sql: 'SELECT version,checksum FROM publication_state WHERE id=1',
        params: []
      })
      if (!row) throw new Error('The catalog publication state is missing.')
      return { checksum: String(row.checksum), version: Number(row.version) }
    },
    submissionPaymentOrder: submissionId =>
      first(selectSubmissionPaymentOrderPlan(submissionId), toOrder),
    async websiteConflicts(website) {
      const listed = listingIdsWithWebsite(website)
      const block = selectActiveUrlBlockStatement(urlKey(website))
      const [row] = await queryPlan<{ blocked: number; listed: number }>(client, {
        sql: `SELECT EXISTS (${listed.sql}) AS listed,EXISTS (${block.sql}) AS blocked`,
        params: [...listed.params, ...block.params]
      })
      return { blocked: Number(row?.blocked) === 1, listed: Number(row?.listed) === 1 }
    }
  }
}
