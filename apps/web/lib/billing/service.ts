import {
  type BillingOperations,
  buildAttachCheckoutPlans,
  buildMarkOrderAppliedPlans,
  buildMarkOrderFailedPlans,
  buildMarkOrderPaidPlans,
  buildMarkOrderRefundedPlans,
  type CheckoutSubmission,
  listingCheckoutPurpose,
  type OrderRecord,
  orderTargetKey
} from '@serpdirectory/data-ops/billing'
import type { StatementPlan } from '@serpdirectory/data-ops/plan-support'
import {
  type CatalogPublication,
  prepareCatalogPublication
} from '@serpdirectory/data-ops/plan-support'
import type { OrderOutcome, OrderRefundReason } from '@serpdirectory/data-ops/schema'
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
  type BillingProvider,
  BillingProviderError,
  BillingWebhookError,
  type CheckoutState
} from './provider'

/**
 * The billing service (serpcompany/best.serp.co#68): checkout, the webhook, fulfilment, and
 * refunds, on the provider interface (`provider.ts`) and the D1 ledger
 * (`@serpdirectory/data-ops/billing`). It holds no SQL and no provider specifics; the runtime
 * (`runtime.ts`) wires D1, the provider, email, and the badge check.
 *
 * Every step is idempotent, because a payment reaches it up to three ways: the webhook (and its
 * replays), the buyer's return from checkout, and the hourly sweep. The order's status is the
 * compare-and-swap: `pending` → `paid` once, then applied once (`applied_at`, in the same batch
 * as the submission or listing change), and `paid` → `refunded` once. Provider calls carry
 * idempotency keys (`checkout:<order>`, `refund:<order>`), so a retry never charges or refunds
 * twice.
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
/** How often a fulfilment that lost the catalog publication race tries again. */
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
 * Paid claims (#67). Absent until #67's claims module is merged and wired in `runtime.ts`: a
 * paid claim cannot start a checkout, and a claim payment that arrives anyway is refunded.
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

// ---------------------------------------------------------------------------------------------
// Checkout

export type CheckoutStart =
  | { ok: true; url: string }
  /** Nothing to pay: go to the page that shows where it stands. */
  | { ok: true; redirect: string }
  | BillingFailure

interface CheckoutTarget {
  cancelPath: string
  description: string
  listingId?: string
  purpose: OrderRecord['purpose']
  submissionId?: string
  claimId?: string
  successPath: (orderId: string) => string
  targetKey: string
}

/**
 * Opens (or reuses) the provider checkout for one target. An open order whose checkout is
 * still good is reused, so a double click or a second tab never opens two payments; an older
 * one is failed first (`expired`). A late payment of a failed order is still recorded by the
 * webhook and refunded if it can't apply.
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
    await deps.operations.apply(
      buildMarkOrderFailedPlans({ now: now.toISOString(), orderId: open.id, reason: 'expired' })
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
  try {
    const session = await deps.provider.createCheckout({
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
    await deps.operations.apply(
      buildAttachCheckoutPlans({
        checkoutId: session.checkoutId,
        expiresAt: session.expiresAt,
        now: deps.now().toISOString(),
        orderId: order.id,
        url: session.url
      })
    )
    log('billing_checkout_opened', { order: order.id, purpose: order.purpose })
    return { ok: true, url: session.url }
  } catch (error) {
    logError('billing_checkout_failed', error, { order: order.id })
    await deps.operations.apply(
      buildMarkOrderFailedPlans({
        now: deps.now().toISOString(),
        orderId: order.id,
        reason: 'checkout_unavailable'
      })
    )
    return failure(503, 'checkout_unavailable', 'Checkout is unavailable right now. Try again.')
  }
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
 * (choosing paid on the way), one waiting for its badge, or a free one waiting for review.
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
  if (submission.status === 'draft' && submission.plan !== 'paid') {
    const chosen = await deps.operations.apply(
      buildChooseSubmissionPlanPlans({
        now: deps.now().toISOString(),
        ownerUserId: input.userId,
        plan: 'paid',
        submissionId: submission.id
      })
    )
    // An expired draft can't choose a plan any more; the account shows where it stands.
    if (!chosen) return { ok: true, redirect: account }
  }
  return openCheckout(deps, input, {
    cancelPath: `/submit/${submission.id}/choose/`,
    description: `Paid listing: ${submission.name}`,
    purpose: 'submission',
    submissionId: submission.id,
    successPath: orderId => `/submit/${submission.id}/checkout/success/?order=${orderId}`,
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
 * The buyer's return from checkout: asks the provider about the order's checkout and, when it
 * is paid, records and applies the payment now, so the page they land on already shows it
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
 * The provider's webhook: verify (raw body, signature, timestamp), record the event once by its
 * id, act on it, and mark it processed. A replay of a processed event is a no-op. A failure
 * midway answers 500 and leaves the event unprocessed, so the provider's retry runs it again.
 */
export async function handleWebhook(
  deps: BillingDependencies,
  input: { body: string; headers: Headers }
): Promise<WebhookAnswer> {
  let event: Awaited<ReturnType<BillingProvider['verifyWebhook']>>
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
  const now = deps.now().toISOString()
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
    const order =
      (await deps.operations.orderByCheckout(provider, event.checkout.checkoutId)) ??
      (event.checkout.orderId ? await deps.operations.order(event.checkout.orderId) : null)
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
  type: Exclude<Awaited<ReturnType<BillingProvider['verifyWebhook']>>['type'], 'ignored'>,
  checkout: CheckoutState
): Promise<string> {
  if (type === 'checkout_paid') return recordPayment(deps, order, checkout)
  if (type === 'checkout_processing') return 'processing'
  if (order.status !== 'pending') return `already_${order.status}`
  await deps.operations.apply(
    buildMarkOrderFailedPlans({
      now: deps.now().toISOString(),
      orderId: order.id,
      reason: type === 'checkout_expired' ? 'expired' : 'payment_failed'
    })
  )
  return 'failed'
}

/**
 * A paid checkout: the order becomes `paid` (once), then the payment is applied. A charge that
 * doesn't match the order's amount and currency is never applied; it stays for an admin.
 */
async function recordPayment(
  deps: BillingDependencies,
  order: OrderRecord,
  checkout: CheckoutState
): Promise<string> {
  if (checkout.amountCents !== order.amountCents || checkout.currency !== order.currency) {
    logError('billing_amount_mismatch', new Error('The charge does not match the order.'), {
      order: order.id
    })
    return 'amount_mismatch'
  }
  if (order.status === 'pending' || order.status === 'failed') {
    if (!checkout.paymentId) return 'no_payment_id'
    await deps.operations.apply(
      buildMarkOrderPaidPlans({
        now: deps.now().toISOString(),
        orderId: order.id,
        paymentId: checkout.paymentId
      })
    )
    log('billing_order_paid', { order: order.id })
  }
  return fulfilOrder(deps, order.id)
}

// ---------------------------------------------------------------------------------------------
// Fulfilment

async function publicationFor(
  deps: BillingDependencies,
  action: string,
  entityId: string,
  slug: string,
  now: string
): Promise<CatalogPublication> {
  const state = await deps.operations.publicationState()
  return prepareCatalogPublication({
    action,
    actor: BILLING_ACTOR,
    affectedRoutes: `/products/${slug}/`,
    checksum: state.checksum,
    entityId,
    now,
    version: state.version,
    workflow: BILLING_WORKFLOW
  })
}

/**
 * Applies a paid order once and returns its outcome. Safe to call any number of times: an
 * applied (or refunded) order answers its recorded outcome. A payment the target can no longer
 * accept (withdrawn, rejected, already paid by another checkout, an admin unpublished it) is
 * refunded in full (`unapplied`).
 */
export async function fulfilOrder(deps: BillingDependencies, orderId: string): Promise<string> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const order = await deps.operations.order(orderId)
    if (!order) return 'unknown_order'
    if (order.status !== 'paid' || order.appliedAt !== null) return order.outcome ?? order.status
    const applied = await applyOnce(deps, order)
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
  outcome: OrderOutcome
): Promise<boolean> {
  return deps.operations.apply([
    ...plans,
    ...buildMarkOrderAppliedPlans({ now: deps.now().toISOString(), orderId: order.id, outcome })
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
        now: deps.now().toISOString(),
        submissionId: submission.id
      })
    )
  }
  if (!payableSubmission(submission)) return refundUnapplied(deps, order)
  const checks = await deps.guardrails(submission.website)
  const now = deps.now().toISOString()
  if (checks.ok) {
    const done = await applied(
      deps,
      order,
      buildRecordSubmissionPaymentPlans({
        actor: BILLING_ACTOR,
        listingId: deps.newId(),
        now,
        outcome: 'publish',
        publication: await publicationFor(
          deps,
          'paid-listing',
          submission.id,
          submission.slug,
          now
        ),
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
    'held'
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
  const now = deps.now().toISOString()
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
      publication: await publicationFor(deps, 'paid-relist', listing.id, listing.slug, now),
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

/** Refunds the provider payment once, under the order's refund key. */
async function providerRefund(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<string | null> {
  if (!order.providerPaymentId) throw new Error(`Order ${order.id} has no payment to refund.`)
  const { refundId } = await deps.provider.refund({
    amountCents: order.amountCents,
    idempotencyKey: `refund:${order.id}`,
    orderId: order.id,
    paymentId: order.providerPaymentId
  })
  return refundId
}

function refundedPlans(
  deps: BillingDependencies,
  order: OrderRecord,
  input: { actor: string; reason: OrderRefundReason; refundId: string | null }
): StatementPlan[] {
  return buildMarkOrderRefundedPlans({
    actor: input.actor,
    now: deps.now().toISOString(),
    orderId: order.id,
    reason: input.reason,
    refundId: input.refundId
  })
}

/** A payment its target can't accept: refunded in full, recorded with `extra` when given. */
async function refundUnapplied(
  deps: BillingDependencies,
  order: OrderRecord,
  extra: StatementPlan[] = []
): Promise<string> {
  const refundId = await providerRefund(deps, order)
  const plans = refundedPlans(deps, order, { actor: BILLING_ACTOR, reason: 'unapplied', refundId })
  if (!(await deps.operations.apply([...extra, ...plans])) && extra.length > 0) {
    await deps.operations.apply(plans)
  }
  log('billing_order_refunded', { order: order.id, reason: 'unapplied' })
  return 'unapplied'
}

// ---------------------------------------------------------------------------------------------
// Refunds

/**
 * The admin panel's refund hook for a paid submission rejected as `other` (`AdminRefunds`,
 * docs/ADMIN_PANEL.md "Refunds"): refunds its order, records it on the submission and the order
 * in one batch, and sends "rejected and refunded". Runs after the rejection, on every replay of
 * it, and from the sweep; throws when the refund didn't go through, so it stays pending.
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
  if (submission.refundedAt === null) {
    const refundId = order.status === 'paid' ? await providerRefund(deps, order) : null
    const plans = [
      ...buildRefundSubmissionPlans({
        actor: input.actor,
        mode: 'after_rejection',
        now: deps.now().toISOString(),
        submissionId: input.submissionId
      }),
      ...(order.status === 'paid'
        ? refundedPlans(deps, order, { actor: input.actor, reason: 'rejected', refundId })
        : [])
    ]
    if (!(await deps.operations.apply(plans))) {
      const current = await deps.operations.checkoutSubmission(input.submissionId)
      if (current?.refundedAt === null) throw new Error('The refund could not be recorded.')
    }
    log('billing_order_refunded', { order: order.id, reason: 'rejected' })
  }
  if (submission.ownerEmail) {
    await deps.notify('submission-rejected-refunded', {
      eventKey: deps.eventKey('submission-rejected', input.submissionId),
      input: {
        reason: review.reason,
        refundedCents: order.amountCents,
        submissionId: input.submissionId,
        submissionName: submission.name
      },
      to: submission.ownerEmail
    })
  }
}

export type RefundOrderResult =
  | {
      /** What happened to the listing: unpublished, kept live as free, or nothing to change. */
      listing: 'kept_free' | 'unchanged' | 'unpublished'
      ok: true
      replayed: boolean
    }
  | BillingFailure

/**
 * The admin "Refund" on an order (#70 screen 13; #59 amendment 2). A paid listing (a paid
 * submission, an upgrade, or a relist) that is live has its badge checked once, right now
 * (`checkBadgeAtRefund`): a pass keeps it live as a free listing, a miss or a result that can't
 * tell unpublishes it. One already down is refunded as it is. A submission still in review is
 * rejected instead (its rejection refunds it), and a prohibited rejection is never refunded.
 * A payment that was never applied, or a claim, is refunded from the order alone.
 */
export async function refundOrder(
  deps: BillingDependencies,
  input: { actor: string; orderId: string }
): Promise<RefundOrderResult> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const result = await refundOrderOnce(deps, input)
    if (result !== 'retry') return result
  }
  return failure(
    409,
    'conflict',
    'This changed since you opened it. Reload the page and try again.'
  )
}

async function refundOrderOnce(
  deps: BillingDependencies,
  input: { actor: string; orderId: string }
): Promise<RefundOrderResult | 'retry'> {
  const order = await deps.operations.order(input.orderId)
  if (!order) return failure(404, 'not_found', 'That order doesn’t exist.')
  if (order.status === 'refunded') return { listing: 'unchanged', ok: true, replayed: true }
  if (order.status !== 'paid') {
    return failure(409, 'not_refundable', 'Only a paid order can be refunded.')
  }
  const listingOrder =
    order.purpose !== 'claim' && order.appliedAt !== null && order.outcome !== 'unapplied'
  const submission =
    listingOrder && order.submissionId
      ? await deps.operations.checkoutSubmission(order.submissionId)
      : null
  const refundOnly = async (): Promise<RefundOrderResult | 'retry'> => {
    const refundId = await providerRefund(deps, order)
    const done = await deps.operations.apply(
      refundedPlans(deps, order, { actor: input.actor, reason: 'admin', refundId })
    )
    log('billing_order_refunded', { order: order.id, reason: 'admin' })
    return done ? { listing: 'unchanged', ok: true, replayed: false } : 'retry'
  }
  if (!submission || submission.refundedAt !== null) return refundOnly()
  if (submission.status === 'rejected') {
    if ((await deps.operations.rejection(submission.id))?.category === 'prohibited') {
      return failure(409, 'prohibited', 'A rejection for prohibited content isn’t refunded.')
    }
    await refundRejectedSubmission(deps, { actor: input.actor, submissionId: submission.id })
    return { listing: 'unchanged', ok: true, replayed: false }
  }
  if (submission.status !== 'approved') {
    return failure(
      409,
      'submission_in_review',
      'This submission is still in review. Reject it from the review page instead.'
    )
  }
  if (submission.plan !== 'paid' || submission.paidAt === null) return refundOnly()
  const listing = submission.listingId
    ? await deps.operations.checkoutListing({
        listingId: submission.listingId,
        userId: order.userId
      })
    : null
  const live = await deps.operations.listingLive(submission.listingId)
  const now = deps.now().toISOString()
  let plans: StatementPlan[]
  let outcome: 'kept_free' | 'unchanged' | 'unpublished'
  if (!live || !submission.listingId) {
    plans = buildRefundSubmissionPlans({
      actor: input.actor,
      mode: 'already_unpublished',
      now,
      submissionId: submission.id
    })
    outcome = 'unchanged'
  } else {
    const check = await deps.badgeAtRefund(submission.listingId)
    if (check.keepFree) {
      plans = buildRefundSubmissionPlans({
        actor: input.actor,
        badgeCheckId: check.checkId,
        mode: 'keep_free',
        now,
        submissionId: submission.id
      })
      outcome = 'kept_free'
    } else {
      plans = buildRefundSubmissionPlans({
        actor: input.actor,
        badgeCheckId: check.checkId,
        mode: 'unpublish',
        now,
        publication: {
          ...(await publicationFor(
            deps,
            'refund-unpublish',
            submission.id,
            listing?.slug ?? submission.slug,
            now
          )),
          actor: input.actor
        },
        submissionId: submission.id
      })
      outcome = 'unpublished'
    }
  }
  const refundId = await providerRefund(deps, order)
  const done = await deps.operations.apply([
    ...plans,
    ...refundedPlans(deps, order, { actor: input.actor, reason: 'admin', refundId })
  ])
  if (!done) return 'retry'
  log('billing_order_refunded', { listing: outcome, order: order.id, reason: 'admin' })
  return { listing: outcome, ok: true, replayed: false }
}

// ---------------------------------------------------------------------------------------------
// Sweep

/**
 * The hourly sweep: retries refunds still owed after an `other` rejection, asks the provider
 * about pending orders whose checkout has closed (paid → applied; otherwise failed), and applies
 * paid orders a crash left unapplied. Each item is independent; a failure is logged and retried
 * on the next run.
 */
export async function runBillingSweep(
  deps: BillingDependencies,
  input: { limit: number }
): Promise<Record<string, number>> {
  const counts = { applied: 0, errors: 0, failed: 0, refunds: 0 }
  for (const submissionId of await deps.operations.refundPendingSubmissions(input.limit)) {
    try {
      await refundRejectedSubmission(deps, { actor: BILLING_ACTOR, submissionId })
      counts.refunds += 1
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_refund_failed', error, { submission: submissionId })
    }
  }
  const before = new Date(deps.now().getTime() - RECONCILE_AFTER_MS).toISOString()
  for (const order of await deps.operations.ordersToReconcile({ before, limit: input.limit })) {
    try {
      if (order.status === 'paid') {
        await fulfilOrder(deps, order.id)
        counts.applied += 1
        continue
      }
      const checkout = await deps.provider.getCheckout(order.providerCheckoutId ?? '')
      if (checkout.state === 'paid') {
        await recordPayment(deps, order, checkout)
        counts.applied += 1
      } else if (checkout.state !== 'processing') {
        await deps.operations.apply(
          buildMarkOrderFailedPlans({
            now: deps.now().toISOString(),
            orderId: order.id,
            reason: checkout.state === 'failed' ? 'payment_failed' : 'expired'
          })
        )
        counts.failed += 1
      }
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_order_failed', error, { order: order.id })
    }
  }
  return counts
}
