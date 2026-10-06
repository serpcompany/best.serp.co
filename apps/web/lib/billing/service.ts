import {
  type BillingOperations,
  buildAttachCheckoutPlans,
  buildClaimRefundPlans,
  buildFinishRefundPlans,
  buildMarkFailedReasonPlans,
  buildMarkOrderAppliedPlans,
  buildMarkOrderFailedPlans,
  buildMarkOrderPaidPlans,
  type CheckoutSubmission,
  listingCheckoutPurpose,
  type OrderRecord,
  orderTargetKey
} from '@serpdirectory/data-ops/billing'
import {
  type CatalogPublication,
  prepareCatalogPublication,
  type StatementPlan
} from '@serpdirectory/data-ops/plan-support'
import type {
  OrderOutcome,
  OrderRefundListingAction,
  OrderRefundReason
} from '@serpdirectory/data-ops/schema'
import {
  buildChooseSubmissionPlanPlans,
  buildRecordSubmissionPaymentPlans,
  buildRecordUnappliedPaymentPlans,
  buildRefundSubmissionPlans,
  buildRelistListingToPaidPlans,
  buildUpgradeListingToPaidPlans
} from '@serpdirectory/data-ops/submission-plans'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'
import type { GuardrailResult } from './guardrails'
import {
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookError,
  type CheckoutState
} from './provider'

/**
 * The billing service (serpcompany/best.serp.co#68): checkout, the webhook, fulfilment, and
 * refunds, on the provider interface (`provider.ts`) and the D1 ledger
 * (`@serpdirectory/data-ops/billing`). It holds no SQL and no provider specifics; the runtime
 * (`worker-billing.ts`) wires D1, the provider, email, and the badge check.
 *
 * Every step is idempotent, because a payment reaches it up to three ways: the webhook (and its
 * replays), the buyer's return from checkout, and the hourly sweep. The order's status is the
 * compare-and-swap: `pending` → `paid` once, then applied once (`applied_at`, in the same batch
 * as the submission or listing change). A refund is claimed in D1 first (`paid` →
 * `refunding`, swapped on the state it was decided on), then asked of the provider, then
 * finalized (`refunded`), so a fulfilment racing it can never apply a refunded payment, nor a
 * refund undo an applied one. Provider calls carry idempotency keys (`checkout:<order>`,
 * `refund:<order>`), so a retry never charges or refunds twice.
 */

/** The actor recorded on billing events and publication runs. */
export const BILLING_ACTOR = 'billing'
const BILLING_WORKFLOW = 'app/billing'
/** A checkout stays open this long; an unpaid order is then failed and a new one opened. */
export const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000
/** An open checkout is reused unless it closes sooner than this. */
const CHECKOUT_REUSE_MARGIN_MS = 5 * 60 * 1000
/** The sweep looks again at orders this long after their checkout closed or they were paid. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000
/** A failed order's checkout is reconciled this long: the provider's webhook retry window. */
const FAILED_RECONCILE_MS = 3 * 24 * 60 * 60 * 1000
/** Provider calls the hourly sweep makes at most. */
const SWEEP_PROVIDER_CALLS = 20
/** How often a write that lost the catalog publication race tries again. */
const PUBLICATION_ATTEMPTS = 3

export type Notify = <K extends keyof AppEmailTemplates & string>(
  templateId: K,
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
) => Promise<void>

/** The result of the badge check at refund (`checkBadgeAtRefund`, #66). */
export interface RefundBadgeResult {
  checkId: number
  keepFree: boolean
}

/**
 * Paid claims (#67). Absent until #67's claims module is merged and wired in
 * `worker-billing.ts`: a paid claim cannot start a checkout, and a claim payment that arrives
 * anyway is refunded.
 */
export interface PaidClaims {
  /** `completePaidClaim` (#67): the claimer becomes the owner. */
  complete(input: { actor: string; claimId: string; userId: string }): Promise<boolean>
  /** The claim the user may pay for: confirmed, paid method, still open. */
  forCheckout(input: {
    claimId: string
    userId: string
  }): Promise<{ listingId: string; listingName: string } | null>
}

export interface BillingDependencies {
  adminRecipient: string
  /** `checkBadgeAtRefund` for the listing (records a `refund` badge check). */
  badgeAtRefund(listingId: string): Promise<RefundBadgeResult>
  currency: string
  eventKey(event: string, ...ids: string[]): string
  guardrails(website: string): Promise<GuardrailResult>
  newId(): string
  notify: Notify
  now(): Date
  operations: BillingOperations
  paidClaims?: PaidClaims
  priceCents: number
  provider: BillingProvider
}

export type BillingFailure = {
  error: string
  message: string
  ok: false
  status: 404 | 409 | 422 | 503
}

const failure = (
  status: BillingFailure['status'],
  error: string,
  message: string
): BillingFailure => ({ error, message, ok: false, status })

function log(event: string, detail: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...detail }))
}

function logError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      event,
      ...detail,
      code: error instanceof BillingProviderError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
  )
}

const nowIso = (deps: BillingDependencies) => deps.now().toISOString()

// ---------------------------------------------------------------------------------------------
// Checkout

export type CheckoutStart =
  | { ok: true; url: string }
  /** Nothing to pay: go to the page that shows where it stands. */
  | { ok: true; redirect: string }
  | BillingFailure

interface CheckoutTarget {
  cancelPath: string
  claimId?: string
  description: string
  listingId?: string
  purpose: OrderRecord['purpose']
  submissionId?: string
  successPath: (orderId: string) => string
  targetKey: string
}

/**
 * Expires a checkout at the provider so it can't be paid any more (best effort). True only when
 * the provider confirmed it; otherwise the sweep keeps asking about it (it may have been paid).
 */
async function expireCheckout(
  deps: BillingDependencies,
  checkoutId: string | null
): Promise<boolean> {
  if (!checkoutId) return true
  try {
    return await deps.provider.expireCheckout(checkoutId)
  } catch (error) {
    logError('billing_checkout_expire_failed', error, { checkout: checkoutId })
    return false
  }
}

/**
 * Opens (or reuses) the provider checkout for one target. An open order whose checkout is
 * still good is reused, so a double click or a second tab never opens two payments; an older
 * one is expired at the provider and failed first. A payment that still reaches a superseded
 * checkout is recorded (the webhook, or the sweep within the provider's retry window) and
 * refunded if it can't apply.
 */
async function openCheckout(
  deps: BillingDependencies,
  input: { email: string; origin: string; userId: string },
  target: CheckoutTarget
): Promise<CheckoutStart> {
  const now = deps.now()
  const open = await deps.operations.openOrder(target.targetKey)
  if (open) {
    const expires = open.checkoutExpiresAt ? Date.parse(open.checkoutExpiresAt) : 0
    if (
      open.userId === input.userId &&
      open.checkoutUrl &&
      expires - now.getTime() > CHECKOUT_REUSE_MARGIN_MS
    ) {
      return { ok: true, url: open.checkoutUrl }
    }
    const expired = await expireCheckout(deps, open.providerCheckoutId)
    await deps.operations.apply(
      buildMarkOrderFailedPlans({
        now: now.toISOString(),
        orderId: open.id,
        reason: expired ? 'superseded' : 'superseded_unconfirmed'
      })
    )
  }
  const order = await deps.operations.createOrder({
    amountCents: deps.priceCents,
    claimId: target.claimId ?? null,
    currency: deps.currency,
    id: deps.newId(),
    listingId: target.listingId ?? null,
    now: now.toISOString(),
    provider: deps.provider.name,
    purpose: target.purpose,
    submissionId: target.submissionId ?? null,
    userId: input.userId
  })
  if (order.userId !== input.userId) {
    return failure(409, 'checkout_in_progress', 'A checkout for this is already open.')
  }
  if (order.checkoutUrl) return { ok: true, url: order.checkoutUrl }
  const unavailable = async (reason: string) => {
    await deps.operations.apply(
      buildMarkOrderFailedPlans({ now: nowIso(deps), orderId: order.id, reason })
    )
    return failure(503, 'checkout_unavailable', 'Checkout is unavailable right now. Try again.')
  }
  let session: Awaited<ReturnType<BillingProvider['createCheckout']>>
  try {
    session = await deps.provider.createCheckout({
      amountCents: order.amountCents,
      cancelUrl: `${input.origin}${target.cancelPath}`,
      currency: order.currency,
      customerEmail: input.email,
      description: target.description,
      expiresAt: new Date(now.getTime() + CHECKOUT_LIFETIME_MS),
      idempotencyKey: `checkout:${order.id}`,
      orderId: order.id,
      successUrl: `${input.origin}${target.successPath(order.id)}`
    })
  } catch (error) {
    logError('billing_checkout_failed', error, { order: order.id })
    return unavailable('checkout_unavailable')
  }
  const attached = await deps.operations.apply(
    buildAttachCheckoutPlans({
      checkoutId: session.checkoutId,
      expiresAt: session.expiresAt,
      now: nowIso(deps),
      orderId: order.id,
      url: session.url
    })
  )
  if (!attached) {
    // Never hand out a checkout the ledger doesn't know: expire it and fail the order.
    const expired = await expireCheckout(deps, session.checkoutId)
    return unavailable(expired ? 'checkout_not_recorded' : 'checkout_not_recorded_unconfirmed')
  }
  log('billing_checkout_opened', { order: order.id, purpose: order.purpose })
  return { ok: true, url: session.url }
}

/** A submission that a payment applies to (`submissionTransitions.payPublish`). */
function payableSubmission(submission: CheckoutSubmission): boolean {
  if (submission.paidAt !== null || submission.refundedAt !== null) return false
  if (submission.listingId !== null) return false
  return (
    submission.status === 'draft' ||
    submission.status === 'pending_badge' ||
    (submission.status === 'verified' && submission.plan === 'free')
  )
}

/**
 * `/submit/<id>/checkout/` (#70 screen 4): the owner pays for their submission: a draft
 * (choosing paid on the way), one waiting for its badge, or a free one waiting for review. A
 * website that a prohibited block now covers, or another listing now has, is refused before
 * anything is charged.
 */
export async function startSubmissionCheckout(
  deps: BillingDependencies,
  input: { email: string; origin: string; submissionId: string; userId: string }
): Promise<CheckoutStart> {
  const submission = await deps.operations.checkoutSubmission(input.submissionId)
  if (!submission || submission.ownerUserId !== input.userId) {
    return failure(404, 'not_found', 'Submission not found.')
  }
  const account = `/account/submissions/${submission.id}/`
  if (!payableSubmission(submission)) return { ok: true, redirect: account }
  const conflicts = await deps.operations.websiteConflicts(submission.website)
  if (conflicts.blocked || conflicts.listed) {
    return failure(
      409,
      conflicts.blocked ? 'website_blocked' : 'website_listed',
      'This website can’t be listed as a paid listing.'
    )
  }
  if (submission.status === 'draft' && submission.plan !== 'paid') {
    const chosen = await deps.operations.apply(
      buildChooseSubmissionPlanPlans({
        now: nowIso(deps),
        ownerUserId: input.userId,
        plan: 'paid',
        submissionId: submission.id
      })
    )
    // An expired draft can't choose a plan any more; the account shows where it stands.
    if (!chosen) return { ok: true, redirect: account }
  }
  return openCheckout(deps, input, {
    cancelPath: `/submit/${submission.id}/checkout/cancelled/`,
    description: `Paid listing: ${submission.name}`,
    purpose: 'submission',
    submissionId: submission.id,
    successPath: orderId => `/submit/${submission.id}/checkout/return/?order=${orderId}`,
    targetKey: orderTargetKey({ purpose: 'submission', submissionId: submission.id })
  })
}

/**
 * `/account/listings/<slug>/checkout/`: "Upgrade: $49 one-off" for a live free listing, or
 * "Relist for $49" for one the badge program unlisted.
 */
export async function startListingCheckout(
  deps: BillingDependencies,
  input: { email: string; origin: string; slug: string; userId: string }
): Promise<CheckoutStart> {
  const listing = await deps.operations.checkoutListing({ slug: input.slug, userId: input.userId })
  if (!listing) return failure(404, 'not_found', 'Listing not found.')
  const account = `/account/listings/${listing.slug}/`
  const purpose = listingCheckoutPurpose(listing)
  if (!purpose || !listing.submission) return { ok: true, redirect: account }
  return openCheckout(deps, input, {
    cancelPath: account,
    description: `Paid listing: ${listing.name}`,
    listingId: listing.id,
    purpose,
    submissionId: listing.submission.id,
    successPath: orderId => `/account/listings/${listing.slug}/checkout/success/?order=${orderId}`,
    targetKey: orderTargetKey({ listingId: listing.id, purpose })
  })
}

/** A paid claim's checkout (#67), once its address is confirmed. */
export async function startClaimCheckout(
  deps: BillingDependencies,
  input: {
    cancelPath: string
    claimId: string
    email: string
    origin: string
    successPath: (orderId: string) => string
    userId: string
  }
): Promise<CheckoutStart> {
  if (!deps.paidClaims) return failure(404, 'not_found', 'Claim not found.')
  const claim = await deps.paidClaims.forCheckout({ claimId: input.claimId, userId: input.userId })
  if (!claim) return failure(409, 'not_payable', 'This claim can’t be paid for.')
  return openCheckout(deps, input, {
    cancelPath: input.cancelPath,
    claimId: input.claimId,
    description: `Paid claim: ${claim.listingName}`,
    listingId: claim.listingId,
    purpose: 'claim',
    successPath: input.successPath,
    targetKey: orderTargetKey({ claimId: input.claimId, purpose: 'claim' })
  })
}

/**
 * The buyer's return from checkout: asks the provider about the order's own checkout and, when
 * it is paid, records and applies the payment now, so the page they land on already shows it
 * (whichever of this and the webhook comes first does the work). Never throws.
 */
export async function confirmReturn(
  deps: BillingDependencies,
  input: { orderId: string; userId: string }
): Promise<OrderRecord | null> {
  const order = await deps.operations.order(input.orderId)
  if (!order || order.userId !== input.userId) return null
  try {
    if (order.status === 'pending' && order.providerCheckoutId) {
      const checkout = await deps.provider.getCheckout(order.providerCheckoutId)
      if (checkout.state === 'paid') await recordPayment(deps, order, checkout)
    } else if (order.status === 'paid' && order.appliedAt === null) {
      await fulfilOrder(deps, order.id)
    }
  } catch (error) {
    logError('billing_return_failed', error, { order: order.id })
  }
  return deps.operations.order(order.id)
}

// ---------------------------------------------------------------------------------------------
// Webhook

export interface WebhookAnswer {
  body: Record<string, unknown>
  status: number
}

/**
 * The order an event's checkout belongs to: the order holding that checkout id. The order id
 * the checkout echoes is trusted only for an order that never recorded its checkout.
 */
async function orderForCheckout(
  deps: BillingDependencies,
  checkout: CheckoutState
): Promise<OrderRecord | null> {
  const byCheckout = await deps.operations.orderByCheckout(deps.provider.name, checkout.checkoutId)
  if (byCheckout) return byCheckout
  if (!checkout.orderId) return null
  const byReference = await deps.operations.order(checkout.orderId)
  return byReference && byReference.providerCheckoutId === null ? byReference : null
}

/**
 * The provider's webhook: verify (raw body, signature, timestamp; the provider also refuses an
 * event from another mode or account as `ignored`), record the event once by its id, act on
 * it, and mark it processed. A replay of a processed event is a no-op. A failure midway answers
 * 500 and leaves the event unprocessed, so the provider's retry runs it again.
 */
export async function handleWebhook(
  deps: BillingDependencies,
  input: { body: string; headers: Headers }
): Promise<WebhookAnswer> {
  let event: BillingEvent
  try {
    event = await deps.provider.verifyWebhook(input)
  } catch (error) {
    if (error instanceof BillingWebhookError) {
      log('billing_webhook_refused', { reason: error.message })
      return { body: { error: 'invalid_webhook' }, status: 400 }
    }
    throw error
  }
  const provider = deps.provider.name
  const now = nowIso(deps)
  const claim = await deps.operations.claimEvent({
    eventId: event.id,
    eventType: event.providerType,
    now,
    provider
  })
  if (claim === 'processed') return { body: { received: true, replayed: true }, status: 200 }
  let orderId: string | null = null
  let outcome = 'ignored'
  if (event.checkout && event.type !== 'ignored') {
    const order = await orderForCheckout(deps, event.checkout)
    if (order) {
      orderId = order.id
      outcome = await actOnCheckout(deps, order, event.type, event.checkout)
    } else {
      outcome = 'unknown_order'
    }
  }
  await deps.operations.finishEvent({ eventId: event.id, now, orderId, outcome, provider })
  log('billing_webhook_processed', { event: event.providerType, order: orderId, outcome })
  return { body: { received: true }, status: 200 }
}

async function actOnCheckout(
  deps: BillingDependencies,
  order: OrderRecord,
  type: Exclude<BillingEvent['type'], 'ignored'>,
  checkout: CheckoutState
): Promise<string> {
  if (type === 'checkout_paid') return recordPayment(deps, order, checkout)
  if (type === 'checkout_processing') return 'processing'
  if (order.status !== 'pending') return `already_${order.status}`
  await deps.operations.apply(
    buildMarkOrderFailedPlans({
      now: nowIso(deps),
      orderId: order.id,
      reason: type === 'checkout_expired' ? 'expired' : 'payment_failed'
    })
  )
  return 'failed'
}

/**
 * A paid checkout: the order becomes `paid` (once), recording what was actually charged, then
 * the payment is applied. A charge that doesn't match the order's amount and currency is never
 * applied: it is flagged for an admin (`amount_mismatch`) and refunded in full.
 */
async function recordPayment(
  deps: BillingDependencies,
  order: OrderRecord,
  checkout: CheckoutState
): Promise<string> {
  if (order.providerCheckoutId && checkout.checkoutId !== order.providerCheckoutId) {
    return 'checkout_mismatch'
  }
  if (order.status === 'pending' || order.status === 'failed') {
    if (!checkout.paymentId) return 'no_payment_id'
    const mismatch =
      checkout.amountCents !== order.amountCents || checkout.currency !== order.currency
    await deps.operations.apply(
      buildMarkOrderPaidPlans({
        attention: mismatch ? 'amount_mismatch' : null,
        chargedCents: checkout.amountCents ?? order.amountCents,
        chargedCurrency: checkout.currency ?? order.currency,
        now: nowIso(deps),
        orderId: order.id,
        paymentId: checkout.paymentId
      })
    )
    if (mismatch) {
      logError('billing_amount_mismatch', new Error('The charge does not match the order.'), {
        order: order.id
      })
    }
    log('billing_order_paid', { order: order.id })
  }
  return fulfilOrder(deps, order.id)
}

// ---------------------------------------------------------------------------------------------
// Fulfilment

async function publicationFor(
  deps: BillingDependencies,
  input: { action: string; actor: string; entityId: string; now: string; slug: string }
): Promise<CatalogPublication> {
  const state = await deps.operations.publicationState()
  return prepareCatalogPublication({
    action: input.action,
    actor: input.actor,
    affectedRoutes: `/products/${input.slug}/`,
    checksum: state.checksum,
    entityId: input.entityId,
    now: input.now,
    version: state.version,
    workflow: BILLING_WORKFLOW
  })
}

/**
 * Applies a paid order once and returns its outcome. Safe to call any number of times: an
 * applied (or refunded) order answers its recorded outcome. A payment the target can no longer
 * accept (withdrawn, rejected, already paid by another checkout, an admin unpublished it), or a
 * charge that didn't match the order, is refunded in full (`unapplied`).
 */
export async function fulfilOrder(deps: BillingDependencies, orderId: string): Promise<string> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const order = await deps.operations.order(orderId)
    if (!order) return 'unknown_order'
    if (order.status !== 'paid' || order.appliedAt !== null) return order.outcome ?? order.status
    const applied =
      order.attention === 'amount_mismatch'
        ? await refundUnapplied(deps, order)
        : await applyOnce(deps, order)
    if (applied !== 'retry') return applied
  }
  const order = await deps.operations.order(orderId)
  return order?.outcome ?? 'retry_later'
}

/** One attempt; `retry` when a compare-and-swap lost (re-read and decide again). */
async function applyOnce(deps: BillingDependencies, order: OrderRecord): Promise<string> {
  switch (order.purpose) {
    case 'submission':
      return applySubmissionPayment(deps, order)
    case 'upgrade':
    case 'relist':
      return applyListingPayment(deps, order)
    case 'claim':
      return applyClaimPayment(deps, order)
  }
}

async function applied(
  deps: BillingDependencies,
  order: OrderRecord,
  plans: StatementPlan[],
  outcome: OrderOutcome,
  checkProblem: string | null = null
): Promise<boolean> {
  return deps.operations.apply([
    ...plans,
    ...buildMarkOrderAppliedPlans({ checkProblem, now: nowIso(deps), orderId: order.id, outcome })
  ])
}

async function applySubmissionPayment(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<string> {
  const submission = order.submissionId
    ? await deps.operations.checkoutSubmission(order.submissionId)
    : null
  if (!submission) return refundUnapplied(deps, order)
  if (submission.status === 'withdrawn' && submission.paidAt === null) {
    // Withdrawn or expired while the checkout was open: recorded on the submission and refunded.
    return refundUnapplied(
      deps,
      order,
      buildRecordUnappliedPaymentPlans({
        actor: BILLING_ACTOR,
        now: nowIso(deps),
        submissionId: submission.id
      })
    )
  }
  if (!payableSubmission(submission)) return refundUnapplied(deps, order)
  const checks = await deps.guardrails(submission.website)
  const now = nowIso(deps)
  if (checks.ok) {
    const done = await applied(
      deps,
      order,
      buildRecordSubmissionPaymentPlans({
        actor: BILLING_ACTOR,
        listingId: deps.newId(),
        now,
        outcome: 'publish',
        publication: await publicationFor(deps, {
          action: 'paid-listing',
          actor: BILLING_ACTOR,
          entityId: submission.id,
          now,
          slug: submission.slug
        }),
        submissionId: submission.id
      }),
      'published'
    )
    if (!done) return 'retry'
    log('billing_order_applied', { order: order.id, outcome: 'published' })
    await emailPaidSubmission(deps, submission, order, { live: true })
    return 'published'
  }
  const done = await applied(
    deps,
    order,
    buildRecordSubmissionPaymentPlans({
      actor: BILLING_ACTOR,
      now,
      outcome: 'hold',
      submissionId: submission.id
    }),
    'held',
    checks.code
  )
  if (!done) return 'retry'
  log('billing_order_applied', { check: checks.code, order: order.id, outcome: 'held' })
  await emailPaidSubmission(deps, submission, order, { live: false, problem: checks.problem })
  return 'held'
}

/** "Live after payment" or "Payment received: in review", and the admin's review alert. */
async function emailPaidSubmission(
  deps: BillingDependencies,
  submission: CheckoutSubmission,
  order: OrderRecord,
  result: { live: true } | { live: false; problem: string }
): Promise<void> {
  const eventKey = deps.eventKey('submission-paid', submission.id)
  const sends: Promise<void>[] = []
  if (submission.ownerEmail) {
    sends.push(
      result.live
        ? deps.notify('listing-live-paid', {
            eventKey,
            input: {
              listingName: submission.name,
              listingSlug: submission.slug,
              paidCents: order.amountCents
            },
            to: submission.ownerEmail
          })
        : deps.notify('payment-received-in-review', {
            eventKey,
            input: {
              checkProblem: result.problem,
              paidCents: order.amountCents,
              submissionId: submission.id,
              submissionName: submission.name,
              website: submission.website
            },
            to: submission.ownerEmail
          })
    )
  }
  sends.push(
    deps.notify('admin-review-ready', {
      eventKey,
      input: {
        category: submission.categoryName ?? '',
        plan: { kind: 'paid', live: result.live },
        source: 'submission',
        submissionId: submission.id,
        submissionName: submission.name,
        submittedBy: submission.ownerEmail ?? '',
        website: submission.website
      },
      to: deps.adminRecipient
    })
  )
  await Promise.all(sends)
}

async function applyListingPayment(deps: BillingDependencies, order: OrderRecord): Promise<string> {
  const listing = order.listingId
    ? await deps.operations.checkoutListing({ listingId: order.listingId, userId: order.userId })
    : null
  const purpose = listing ? listingCheckoutPurpose(listing) : null
  if (!listing?.submission || purpose !== order.purpose) return refundUnapplied(deps, order)
  const now = nowIso(deps)
  if (purpose === 'upgrade') {
    const done = await applied(
      deps,
      order,
      buildUpgradeListingToPaidPlans({
        actor: BILLING_ACTOR,
        now,
        submissionId: listing.submission.id
      }),
      'upgraded'
    )
    if (!done) return 'retry'
    log('billing_order_applied', { order: order.id, outcome: 'upgraded' })
    return 'upgraded'
  }
  const done = await applied(
    deps,
    order,
    buildRelistListingToPaidPlans({
      actor: BILLING_ACTOR,
      listingId: listing.id,
      now,
      publication: await publicationFor(deps, {
        action: 'paid-relist',
        actor: BILLING_ACTOR,
        entityId: listing.id,
        now,
        slug: listing.slug
      }),
      submissionId: listing.submission.id
    }),
    'relisted'
  )
  if (!done) return 'retry'
  log('billing_order_applied', { order: order.id, outcome: 'relisted' })
  return 'relisted'
}

async function applyClaimPayment(deps: BillingDependencies, order: OrderRecord): Promise<string> {
  if (!deps.paidClaims || !order.claimId) return refundUnapplied(deps, order)
  const completed = await deps.paidClaims.complete({
    actor: BILLING_ACTOR,
    claimId: order.claimId,
    userId: order.userId
  })
  if (!completed) return refundUnapplied(deps, order)
  if (!(await applied(deps, order, [], 'claimed'))) return 'retry'
  log('billing_order_applied', { order: order.id, outcome: 'claimed' })
  return 'claimed'
}

// ---------------------------------------------------------------------------------------------
// Refunds: claim, then the provider, then finalize

/** What a finished refund did to the listing. */
export type RefundListing = 'kept_free' | 'unchanged' | 'unpublished'

function listingResult(action: OrderRefundListingAction | null): RefundListing {
  if (action === 'keep_free') return 'kept_free'
  if (action === 'unpublish') return 'unpublished'
  return 'unchanged'
}

/**
 * Claims the refund in D1 (`paid` → `refunding`) on the state it was decided on: an unapplied
 * payment only while nothing has applied it, an applied one only with the outcome it was read
 * with. `extra` (a withdrawn submission's record) joins the claim when it still applies. False
 * when the order moved on.
 */
async function claimRefund(
  deps: BillingDependencies,
  order: OrderRecord,
  input: {
    actor: string
    badgeCheckId?: number | null
    listingAction?: OrderRefundListingAction | null
    note?: string | null
    reason: OrderRefundReason
  },
  extra: StatementPlan[] = []
): Promise<boolean> {
  const claim = buildClaimRefundPlans({
    ...input,
    now: nowIso(deps),
    orderId: order.id,
    ...(order.appliedAt === null
      ? { from: 'unapplied' as const }
      : { from: 'applied' as const, outcome: order.outcome ?? 'unapplied' })
  })
  if (extra.length > 0 && (await deps.operations.apply([...extra, ...claim]))) return true
  return deps.operations.apply(claim)
}

/** The provider refund of exactly what was charged, under the order's refund key. */
async function providerRefund(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<string | null> {
  if (!order.providerPaymentId) throw new Error(`Order ${order.id} has no payment to refund.`)
  const { refundId } = await deps.provider.refund({
    amountCents: order.chargedCents ?? order.amountCents,
    idempotencyKey: `refund:${order.id}`,
    orderId: order.id,
    paymentId: order.providerPaymentId
  })
  return refundId
}

function finishPlans(
  deps: BillingDependencies,
  order: OrderRecord,
  refundId: string | null
): StatementPlan[] {
  return buildFinishRefundPlans({ now: nowIso(deps), orderId: order.id, refundId })
}

/**
 * The listing change an admin's refund decided, built on the current publication state. The
 * badge check recorded with the claim decides, at the claim's time (`decidedAt`): a refund
 * finished later (the sweep, after the provider failed) applies the same decision, whatever
 * checks came since. A listing that went down in the meantime is refunded as it is.
 */
async function adminListingPlans(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<{ plans: StatementPlan[]; result: RefundListing }> {
  const submissionId = order.submissionId
  const actor = order.refundedBy ?? BILLING_ACTOR
  const now = nowIso(deps)
  const decidedAt = order.refundRequestedAt ?? now
  const unchanged = { plans: [], result: 'unchanged' as const }
  if (!submissionId || order.refundListingAction === 'none') return unchanged
  const submission = await deps.operations.checkoutSubmission(submissionId)
  // Recorded already (another attempt finished the listing change): refund the order only.
  if (!submission || submission.refundedAt !== null) {
    return { plans: [], result: listingResult(order.refundListingAction) }
  }
  const live = await deps.operations.listingLive(submission.listingId)
  if (order.refundListingAction === 'keep_free' && live) {
    return {
      plans: buildRefundSubmissionPlans({
        actor,
        badgeCheckId: order.refundBadgeCheckId ?? 0,
        decidedAt,
        mode: 'keep_free',
        now,
        submissionId
      }),
      result: 'kept_free'
    }
  }
  if (order.refundListingAction === 'unpublish' && live) {
    return {
      plans: buildRefundSubmissionPlans({
        actor,
        badgeCheckId: order.refundBadgeCheckId ?? 0,
        decidedAt,
        mode: 'unpublish',
        now,
        publication: await publicationFor(deps, {
          action: 'refund-unpublish',
          actor,
          entityId: submissionId,
          now,
          slug: submission.slug
        }),
        submissionId
      }),
      result: 'unpublished'
    }
  }
  return {
    plans: buildRefundSubmissionPlans({ actor, mode: 'already_unpublished', now, submissionId }),
    result: order.refundListingAction === 'unpublish' ? 'unpublished' : 'unchanged'
  }
}

/**
 * Finishes a claimed refund: the provider refunds (idempotently, so a retry is safe), then one
 * batch records it: the rejection's or the admin's recorded listing change, and `refunded`.
 * Throws when the provider fails or the batch keeps losing (the catalog publication race); the
 * order stays `refunding` and the sweep finishes the same decision later.
 */
async function finishRefund(deps: BillingDependencies, orderId: string): Promise<RefundListing> {
  const claimed = await deps.operations.order(orderId)
  if (!claimed) throw new Error(`Order ${orderId} not found.`)
  if (claimed.status === 'refunded') return listingResult(claimed.refundListingAction)
  if (claimed.status !== 'refunding') throw new Error(`Order ${orderId} has no claimed refund.`)
  const refundId = await providerRefund(deps, claimed)
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const order = await deps.operations.order(orderId)
    if (!order) throw new Error(`Order ${orderId} not found.`)
    if (order.status === 'refunded') return listingResult(order.refundListingAction)
    let plans: StatementPlan[] = []
    let result: RefundListing = 'unchanged'
    if (order.refundReason === 'rejected' && order.submissionId) {
      const submission = await deps.operations.checkoutSubmission(order.submissionId)
      plans =
        submission?.refundedAt === null
          ? buildRefundSubmissionPlans({
              actor: order.refundedBy ?? BILLING_ACTOR,
              mode: 'after_rejection',
              now: nowIso(deps),
              submissionId: order.submissionId
            })
          : []
    } else if (order.refundReason === 'admin') {
      ;({ plans, result } = await adminListingPlans(deps, order))
    }
    if (await deps.operations.apply([...plans, ...finishPlans(deps, order, refundId)])) {
      log('billing_order_refunded', { order: order.id, reason: order.refundReason })
      return result
    }
  }
  const order = await deps.operations.order(orderId)
  if (order?.status === 'refunded') return listingResult(order.refundListingAction)
  throw new Error(`The refund of order ${orderId} could not be recorded yet.`)
}

/**
 * A payment its target can't accept: claimed as unapplied (only while nothing applied it),
 * refunded in full, and recorded, with `extra` when given. If a fulfilment applied it first,
 * nothing is refunded and its outcome is answered.
 */
async function refundUnapplied(
  deps: BillingDependencies,
  order: OrderRecord,
  extra: StatementPlan[] = []
): Promise<string> {
  const claimed = await claimRefund(
    deps,
    order,
    { actor: BILLING_ACTOR, reason: 'unapplied' },
    extra
  )
  if (!claimed) {
    const current = await deps.operations.order(order.id)
    if (!current || current.status === 'paid' || current.status === 'refunded') {
      return current?.outcome ?? 'retry'
    }
  }
  await finishRefund(deps, order.id)
  return 'unapplied'
}

/**
 * The admin panel's refund hook for a paid submission rejected as `other` (`AdminRefunds`,
 * docs/ADMIN_PANEL.md "Refunds"): claims its order's refund, refunds at the provider, records
 * it on the submission and the order in one batch, and sends "rejected and refunded". Runs
 * after the rejection, on every replay of it, and from the sweep; throws when the refund didn't
 * go through, so it stays pending.
 */
export async function refundRejectedSubmission(
  deps: BillingDependencies,
  input: { actor: string; submissionId: string }
): Promise<void> {
  const submission = await deps.operations.checkoutSubmission(input.submissionId)
  if (!submission || submission.status !== 'rejected') {
    throw new Error('Only a rejected submission is refunded this way.')
  }
  const review = await deps.operations.rejection(input.submissionId)
  if (review?.category !== 'other') throw new Error('A prohibited rejection is never refunded.')
  const order = await deps.operations.submissionPaymentOrder(input.submissionId)
  if (!order) throw new Error(`No paid order for submission ${input.submissionId}.`)
  if (order.status === 'paid') {
    const claimed = await claimRefund(deps, order, { actor: input.actor, reason: 'rejected' })
    const current = claimed ? null : await deps.operations.order(order.id)
    if (current && current.status === 'paid') throw new Error('The refund could not be claimed.')
  }
  const current = await deps.operations.order(order.id)
  if (current?.status === 'refunding') {
    await finishRefund(deps, order.id)
  } else if (current?.status === 'refunded' && submission.refundedAt === null) {
    // Refunded from the order already (by an admin, before this rejection): record it here.
    await deps.operations.apply(
      buildRefundSubmissionPlans({
        actor: input.actor,
        mode: 'after_rejection',
        now: nowIso(deps),
        submissionId: input.submissionId
      })
    )
  }
  if (submission.ownerEmail) {
    await deps.notify('submission-rejected-refunded', {
      eventKey: deps.eventKey('submission-rejected', input.submissionId),
      input: {
        reason: review.reason,
        refundedCents: order.chargedCents ?? order.amountCents,
        submissionId: input.submissionId,
        submissionName: submission.name
      },
      to: submission.ownerEmail
    })
  }
}

export type RefundOrderResult =
  | { listing: RefundListing; ok: true; replayed: boolean }
  | BillingFailure

/** What an admin's refund of an order will do, decided before anything is refunded. */
export type RefundDecision =
  | {
      /** The badge check at refund that decided it (keep free, or unpublish). */
      badgeCheckId: number | null
      kind: 'refund'
      listingAction: OrderRefundListingAction
      /** The listing now: whether it is live, and on the paid plan. */
      listingNow: { live: boolean; paid: boolean } | null
    }
  /** A paid submission rejected as `other`: its rejection's refund. */
  | { kind: 'rejection'; submissionId: string }

const REFUND_CHECK_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Decides an admin's refund of a paid order (#70 screen 13; #59 amendment 2). A live paid
 * listing (a paid submission, an upgrade, or a relist) has its badge checked once, at refund
 * (`checkBadgeAtRefund`): a pass keeps it live as a free listing, a miss or a result that can't
 * tell unpublishes it. The dialog runs this first and shows the result; the refund then passes
 * the same check (`badgeCheckId`), which must still be this listing's and recent, so the admin
 * confirms exactly what happens. One already down is refunded as it is. A submission still in
 * review is rejected instead (its rejection refunds it), and a prohibited rejection is never
 * refunded. A payment that was never applied, or a claim, is refunded from the order alone.
 */
async function decideRefund(
  deps: BillingDependencies,
  order: OrderRecord,
  badgeCheckId?: number | null
): Promise<RefundDecision | BillingFailure> {
  const none = (listingNow: { live: boolean; paid: boolean } | null = null): RefundDecision => ({
    badgeCheckId: null,
    kind: 'refund',
    listingAction: 'none',
    listingNow
  })
  const listingOrder =
    order.purpose !== 'claim' && order.appliedAt !== null && order.outcome !== 'unapplied'
  const submission =
    listingOrder && order.submissionId
      ? await deps.operations.checkoutSubmission(order.submissionId)
      : null
  if (!submission || submission.refundedAt !== null) return none()
  if (submission.status === 'rejected') {
    if ((await deps.operations.rejection(submission.id))?.category === 'prohibited') {
      return failure(409, 'prohibited', 'A rejection for prohibited content isn’t refunded.')
    }
    return { kind: 'rejection', submissionId: submission.id }
  }
  if (submission.status !== 'approved') {
    return failure(
      409,
      'submission_in_review',
      'This submission is still in review. Reject it from the review page instead.'
    )
  }
  const paid = submission.plan === 'paid' && submission.paidAt !== null
  const live = await deps.operations.listingLive(submission.listingId)
  if (!paid) return none({ live, paid })
  if (!live || !submission.listingId) {
    return {
      badgeCheckId: null,
      kind: 'refund',
      listingAction: 'already_unpublished',
      listingNow: { live, paid }
    }
  }
  let check: RefundBadgeResult | null = null
  if (badgeCheckId) {
    const shown = await deps.operations.refundBadgeCheck(badgeCheckId)
    if (
      shown?.latest &&
      shown.listingId === submission.listingId &&
      deps.now().getTime() - Date.parse(shown.checkedAt) < REFUND_CHECK_MAX_AGE_MS
    ) {
      check = { checkId: shown.id, keepFree: shown.outcome === 'pass' }
    }
  }
  check ??= await deps.badgeAtRefund(submission.listingId)
  return {
    badgeCheckId: check.checkId,
    kind: 'refund',
    listingAction: check.keepFree ? 'keep_free' : 'unpublish',
    listingNow: { live, paid }
  }
}

/** The refund dialog's preview: the decision, with the badge checked once, right now. */
export async function previewRefund(
  deps: BillingDependencies,
  input: { orderId: string }
): Promise<({ ok: true } & RefundDecision) | BillingFailure> {
  const order = await deps.operations.order(input.orderId)
  if (!order) return failure(404, 'not_found', 'That order doesn’t exist.')
  if (order.status === 'refunding' && order.refundReason === 'admin') {
    // A refund a failure left: finishing it repeats the recorded decision.
    return {
      badgeCheckId: order.refundBadgeCheckId,
      kind: 'refund',
      listingAction: order.refundListingAction ?? 'none',
      listingNow: null,
      ok: true
    }
  }
  if (order.status !== 'paid') {
    return failure(409, 'not_refundable', 'Only a paid order can be refunded.')
  }
  const decision = await decideRefund(deps, order)
  return 'kind' in decision ? { ok: true, ...decision } : decision
}

/**
 * The admin "Refund" on an order. The decision (above) is recorded with the claim, then the
 * order is refunded at the provider and finalized. A retry after a lost write finishes the
 * recorded decision without checking the badge again.
 */
export async function refundOrder(
  deps: BillingDependencies,
  input: { actor: string; badgeCheckId?: number | null; note?: string | null; orderId: string }
): Promise<RefundOrderResult> {
  const order = await deps.operations.order(input.orderId)
  if (!order) return failure(404, 'not_found', 'That order doesn’t exist.')
  if (order.status === 'refunded') {
    return { listing: await finishRefund(deps, order.id), ok: true, replayed: true }
  }
  if (order.status === 'refunding') {
    return { listing: await finishRefund(deps, order.id), ok: true, replayed: false }
  }
  if (order.status !== 'paid') {
    return failure(409, 'not_refundable', 'Only a paid order can be refunded.')
  }
  const decision = await decideRefund(deps, order, input.badgeCheckId)
  if (!('kind' in decision)) return decision
  if (decision.kind === 'rejection') {
    await refundRejectedSubmission(deps, {
      actor: input.actor,
      submissionId: decision.submissionId
    })
    return { listing: 'unchanged', ok: true, replayed: false }
  }
  const claimed = await claimRefund(deps, order, {
    actor: input.actor,
    badgeCheckId: decision.badgeCheckId,
    listingAction: decision.listingAction,
    note: input.note,
    reason: 'admin'
  })
  if (!claimed) {
    const current = await deps.operations.order(order.id)
    if (current?.refundReason !== 'admin') {
      return failure(
        409,
        'conflict',
        'This changed since you opened it. Reload the page and try again.'
      )
    }
  }
  return { listing: await finishRefund(deps, order.id), ok: true, replayed: !claimed }
}

// ---------------------------------------------------------------------------------------------
// Sweep

/**
 * The hourly sweep: retries refunds still owed after an `other` rejection, finishes claimed
 * refunds a failure left, asks the provider about pending orders whose checkout has closed (paid
 * → applied; otherwise failed) and about failed orders still inside the provider's retry window
 * (a superseded checkout paid late), and applies paid orders a crash left unapplied. Each item
 * is independent; a failure is logged and retried on the next run.
 */
export async function runBillingSweep(
  deps: BillingDependencies,
  input: { limit: number; providerCalls?: number }
): Promise<Record<string, number>> {
  const counts = { applied: 0, errors: 0, failed: 0, refunds: 0, skipped: 0 }
  // Each item may call the provider once; the run stops calling it after this many.
  let calls = input.providerCalls ?? SWEEP_PROVIDER_CALLS
  const now = deps.now().getTime()
  const orders = await deps.operations.ordersToReconcile({
    before: new Date(now - RECONCILE_AFTER_MS).toISOString(),
    failedSince: new Date(now - FAILED_RECONCILE_MS).toISOString(),
    limit: input.limit
  })
  // Most urgent first: claimed refunds, then paid orders never applied, then checkouts.
  for (const order of orders) {
    if (calls <= 0) {
      counts.skipped += 1
      continue
    }
    calls -= 1
    try {
      if (order.status === 'refunding') {
        await finishRefund(deps, order.id)
        counts.refunds += 1
        continue
      }
      if (order.status === 'paid') {
        await fulfilOrder(deps, order.id)
        counts.applied += 1
        continue
      }
      const checkout = await deps.provider.getCheckout(order.providerCheckoutId ?? '')
      if (checkout.state === 'paid') {
        await recordPayment(deps, order, checkout)
        counts.applied += 1
      } else if (order.status === 'pending' && checkout.state !== 'processing') {
        await deps.operations.apply(
          buildMarkOrderFailedPlans({
            now: nowIso(deps),
            orderId: order.id,
            reason: checkout.state === 'failed' ? 'payment_failed' : 'expired'
          })
        )
        counts.failed += 1
      } else if (order.status === 'failed' && checkout.state === 'open') {
        // A superseded checkout still open: expire it, so the sweep can stop asking.
        if (await expireCheckout(deps, checkout.checkoutId)) {
          await deps.operations.apply(
            buildMarkFailedReasonPlans({
              orderId: order.id,
              now: nowIso(deps),
              reason: 'superseded'
            })
          )
        }
      } else if (order.status === 'failed' && checkout.state === 'expired') {
        await deps.operations.apply(
          buildMarkFailedReasonPlans({ orderId: order.id, now: nowIso(deps), reason: 'expired' })
        )
      }
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_order_failed', error, { order: order.id })
    }
  }
  for (const submissionId of await deps.operations.refundPendingSubmissions(input.limit)) {
    if (calls <= 0) {
      counts.skipped += 1
      continue
    }
    calls -= 1
    try {
      await refundRejectedSubmission(deps, { actor: BILLING_ACTOR, submissionId })
      counts.refunds += 1
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_refund_failed', error, { submission: submissionId })
    }
  }
  return counts
}
