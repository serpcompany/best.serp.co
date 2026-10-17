import {
  type BillingOperations,
  buildAttachCheckoutPlans,
  buildClaimRefundPlans,
  buildClearRefundFailedPlans,
  buildCloseDisputePlans,
  buildFinishRefundPlans,
  buildFlagRefundFailedPlans,
  buildMarkFailedReasonPlans,
  buildMarkOrderAppliedPlans,
  buildMarkOrderFailedPlans,
  buildMarkOrderPaidPlans,
  buildRecordDisputedRejectionPlans,
  buildRecordDisputePlans,
  buildRecordPartialRefundPlans,
  buildRecordProviderRefundPlans,
  buildRecordRefundFailurePlans,
  type CheckoutSubmission,
  listingCheckoutPurpose,
  type OrderRecord,
  orderTargetKey,
  PROVIDER_ACTOR
} from '@/db/billing'
import { buildUnpublishListingPlans } from '@/db/listing-plans'
import {
  type CatalogPublication,
  prepareCatalogPublication,
  type StatementPlan
} from '@/db/plan-support'
import type { OrderOutcome, OrderRefundListingAction, OrderRefundReason } from '@/db/schema'
import {
  buildChooseSubmissionPlanPlans,
  buildRecordSubmissionPaymentPlans,
  buildRecordUnappliedPaymentPlans,
  buildRefundSubmissionPlans,
  buildRelistListingToPaidPlans,
  buildUpgradeListingToPaidPlans,
  DISPUTE_DECIDES_REFUND_NOTE
} from '@/db/submission-plans'
import type { PaymentAlertKind } from '../email/emails/admin'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'
import { CodedError } from '../telemetry/coded-error'
import { errorFields } from '../telemetry/error-fields'
import { confirmAgainPath, tooLateForCheckout } from './checkout-window'
import { type GuardrailResult, guardrailProblem } from './guardrails'
import {
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookError,
  type CheckoutState,
  type PaymentChange,
  type ProviderRefund
} from './provider'

/**
 * The billing service (serpcompany/best.serp.co#68): checkout, the webhook, fulfilment, and
 * refunds, on the provider interface (`provider.ts`) and the D1 ledger
 * (`@/db/billing`). It holds no SQL and no provider specifics; the runtime
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
/**
 * How many times a refund event decides an order's `refund_failed` flag on the provider's record
 * before its delivery answers 500 (#498's review): a clear, or a `refund.failed`'s flag (#516's
 * review), refused because the order changed while the provider was asked reads both again once.
 */
const REFUND_FLAG_DECISIONS = 2
/**
 * The sweep sends a payment's emails again for this long after it was applied or changed
 * outside the site (#481), well inside the email provider's idempotency window, and from
 * `RECONCILE_AFTER_MS` after, once the webhook's own send has had its chance.
 */
const EMAIL_RECOVERY_MS = 6 * 60 * 60 * 1000

export type Notify = <K extends keyof AppEmailTemplates & string>(
  templateId: K,
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
) => Promise<void>

/** The result of the badge check at refund (`checkBadgeAtRefund`, #66). */
export interface RefundBadgeResult {
  checkId: number
  keepFree: boolean
}

/** A claim's listing, as the claim checkout's routes need it. */
export interface PaidClaimListing {
  listingId: string
  listingName: string
  listingSlug: string
}

/**
 * Paid claims (#67, `paid-claims.ts`): present only while claims are on too. Absent, a paid
 * claim cannot start a checkout, and a claim payment that arrives anyway is refunded.
 */
export interface PaidClaims {
  /**
   * `completePaidClaim` (#67): the claimer becomes the owner, in one batch with `together` (the
   * order's applied record). True only when this call completed the claim; false when it was
   * complete already (another payment, the badge) or can't complete.
   */
  complete(input: {
    actor: string
    claimId: string
    together: StatementPlan[]
    userId: string
  }): Promise<boolean>
  /**
   * The claim the user may pay for: the paid method, the listing unowned, and the address
   * confirmed, with when the confirmation lapses (a checkout must close before that; one that
   * already lapsed comes back too, so the checkout can ask for a new code).
   */
  forCheckout(input: {
    claimId: string
    userId: string
  }): Promise<(PaidClaimListing & { confirmedUntil: Date }) | null>
  /** The user's claim's listing, whatever its state (the return after paying). */
  listing(input: { claimId: string; userId: string }): Promise<PaidClaimListing | null>
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

function logWarning(event: string, detail: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...detail }))
}

/** A failure's code and name, never its message: a provider's can echo what the buyer entered. */
function logError(event: string, error: unknown, detail: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ...detail, ...errorFields(error) }))
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
  /** The checkout closes by then at the latest (a paid claim's confirmation). */
  closesBy?: Date
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
      expiresAt: new Date(
        Math.min(now.getTime() + CHECKOUT_LIFETIME_MS, target.closesBy?.getTime() ?? Infinity)
      ),
      idempotencyKey: `checkout:${order.id}`,
      kind: order.kind,
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
  input: { claimId: string; email: string; origin: string; userId: string }
): Promise<CheckoutStart> {
  if (!deps.paidClaims) return failure(404, 'not_found', 'Claim not found.')
  const listing = await deps.paidClaims.listing(input)
  if (!listing) return failure(404, 'not_found', 'Claim not found.')
  // Back to the listing's claim dialog, which shows where the claim stands.
  const dialog = `/products/${listing.listingSlug}/#claim`
  const claim = await deps.paidClaims.forCheckout(input)
  if (!claim) return { ok: true, redirect: dialog }
  // The checkout closes with the confirmation, so nobody pays for a claim that can't complete;
  // with less left than a checkout's shortest life, or none, the address is confirmed again
  // first: back to the dialog, told to ask for a new code whatever the browser's clock says
  // (#128, #476). The dialog asks before linking here too, on the browser's clock.
  if (tooLateForCheckout(claim.confirmedUntil.getTime(), deps.now().getTime())) {
    return { ok: true, redirect: confirmAgainPath(listing.listingSlug) }
  }
  return openCheckout(deps, input, {
    cancelPath: dialog,
    closesBy: claim.confirmedUntil,
    claimId: input.claimId,
    description: `Paid claim: ${claim.listingName}`,
    listingId: claim.listingId,
    purpose: 'claim',
    successPath: orderId => `/claims/${input.claimId}/checkout/success/?order=${orderId}`,
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
 * What acting on an event did before the answer (`outcome`, recorded on the event), and the work
 * that runs after it (`after`, through the request's `waitUntil`). Each event type the webhook
 * handles adds its branch to `actOnEvent`: the checkout events, and the payment events (refunds
 * and disputes, #473).
 */
interface EventAction {
  /**
   * Slow work (guardrails, publication, refunds) that runs after the answer. Its failure leaves
   * the order where the sweep and the buyer's return finish it, so it never fails the delivery.
   */
  after?: () => Promise<string>
  orderId: string | null
  outcome: string
}

type CheckoutEventType = Extract<BillingEvent['type'], `checkout_${string}`>
type PaymentEventType = Exclude<BillingEvent['type'], CheckoutEventType | 'ignored'>

const isCheckoutEvent = (type: BillingEvent['type']): type is CheckoutEventType =>
  type.startsWith('checkout_')

/**
 * Fulfilment outcomes that applied nothing (#481): three lost compare-and-swaps, or an order
 * that vanished. Logged as a failure, since the delivery itself was answered 200.
 */
const UNFINISHED_FULFILMENT = new Set(['retry_later', 'unknown_order'])

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
 *
 * It answers before the slow work (#468): a paid checkout is recorded on its order (`paid`)
 * before the answer, and fulfilled (guardrails, publication, refunds) after it, in `waitUntil`.
 * A fulfilment that fails or runs out of time leaves the order `paid` and unapplied (or a claimed
 * refund `refunding`), which the buyer's return and the hourly sweep finish; a later delivery of
 * the event is a replay, and every fulfilment step is a compare-and-swap, so it applies once.
 * A refund or dispute is recorded, and its listing taken down, before the answer
 * (`actOnPayment`, #473).
 */
export async function handleWebhook(
  deps: BillingDependencies,
  input: {
    body: string
    headers: Headers
    /** The request's `ctx.waitUntil`: the work handed to it runs on after the answer. */
    waitUntil: (task: Promise<unknown>) => void
  }
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
  const { after, orderId, outcome } = await actOnEvent(deps, event)
  if (after) {
    // Handed over before the event is marked processed: if that write fails (500, so the
    // provider retries), the payment is still applied, and the retry finds it applied.
    input.waitUntil(
      after().then(
        result => {
          const detail = { order: orderId, outcome: result, type: event.providerType }
          if (UNFINISHED_FULFILMENT.has(result)) {
            logWarning('billing_webhook_fulfilment_failed', detail)
          } else {
            log('billing_webhook_fulfilled', detail)
          }
        },
        error =>
          logError('billing_webhook_fulfilment_failed', error, {
            order: orderId,
            type: event.providerType
          })
      )
    )
  }
  await deps.operations.finishEvent({ eventId: event.id, now, orderId, outcome, provider })
  log('billing_webhook_processed', { order: orderId, outcome, type: event.providerType })
  return { body: { received: true }, status: 200 }
}

async function actOnEvent(deps: BillingDependencies, event: BillingEvent): Promise<EventAction> {
  const type = event.type
  if (type === 'ignored') return { orderId: null, outcome: 'ignored' }
  if (isCheckoutEvent(type)) {
    if (!event.checkout) return { orderId: null, outcome: 'ignored' }
    const order = await orderForCheckout(deps, event.checkout)
    if (!order) return { orderId: null, outcome: 'unknown_order' }
    return { orderId: order.id, ...(await actOnCheckout(deps, order, type, event.checkout)) }
  }
  if (!event.payment) return { orderId: null, outcome: 'ignored' }
  const order = await orderForPayment(deps, type, event.payment)
  // A payment no order took (a charge made outside the site): acknowledged and logged.
  if (!order) return { orderId: null, outcome: 'unknown_order' }
  return { orderId: order.id, outcome: await actOnPayment(deps, order, type, event.payment) }
}

/**
 * The order a payment event is about: the order that recorded the payment, or else, for a refund
 * reported before the checkout's own report, the buyer's return or the sweep recorded the payment
 * (#484), the order the payment names (`PaymentChange.orderId`), trusted only while that order has
 * no payment recorded, as a checkout's reference is (`orderForCheckout`). A refund of all of it
 * records the payment first, at the amount the event reports, so the refund is then recorded as on
 * any paid order and nothing applies the payment later; a partial one is recorded on the order as
 * it stands. A dispute names no order (the provider's carries none), so one that opened, or
 * closed lost, has its checkout asked of the provider (`orderForDispute`). Null for anything else.
 */
async function orderForPayment(
  deps: BillingDependencies,
  type: PaymentEventType,
  payment: PaymentChange
): Promise<OrderRecord | null> {
  const provider = deps.provider.name
  const recorded = await deps.operations.orderByPayment(provider, payment.paymentId)
  if (recorded) return recorded
  // A won dispute's payment stands: its checkout's own report records and applies it.
  if (
    type === 'payment_disputed' ||
    (type === 'dispute_closed' && payment.disputeOutcome === 'lost')
  ) {
    return orderForDispute(deps, payment.paymentId)
  }
  if (type !== 'payment_refunded' || !payment.orderId) return null
  const named = await deps.operations.order(payment.orderId)
  if (!named || named.providerPaymentId !== null) return null
  if (payment.partial) return named
  if (typeof payment.amountCents !== 'number' || !payment.currency) return null
  await deps.operations.apply(
    buildMarkOrderPaidPlans({
      chargedCents: payment.amountCents,
      chargedCurrency: payment.currency,
      now: nowIso(deps),
      orderId: named.id,
      paymentId: payment.paymentId
    })
  )
  log('billing_order_paid', { order: named.id, reportedBy: 'refund' })
  // Recorded now, or a moment ago by the checkout's own report: by this payment either way.
  return deps.operations.orderByPayment(provider, payment.paymentId)
}

/**
 * The order of a dispute reported before the site recorded its payment (#484): the provider's
 * checkout that took the payment names it, as a checkout event does (`orderForCheckout`). The
 * payment is recorded on it first, as that checkout's own report would (`markPaid`), so the
 * dispute is then recorded as on any paid order, and fulfilment never applies the payment (it
 * refuses a disputed one). Null when no checkout of this site's took the payment. A provider that
 * can't answer throws, so the delivery answers 500 and the provider's retry asks again.
 */
async function orderForDispute(
  deps: BillingDependencies,
  paymentId: string
): Promise<OrderRecord | null> {
  const checkout = await deps.provider.checkoutForPayment(paymentId)
  if (!checkout || checkout.paymentId !== paymentId || checkout.state !== 'paid') return null
  const order = await orderForCheckout(deps, checkout)
  if (!order || (await markPaid(deps, order, checkout))) return null
  // Recorded now, or a moment ago by the checkout's own report: by this payment either way.
  return deps.operations.orderByPayment(deps.provider.name, paymentId)
}

async function actOnCheckout(
  deps: BillingDependencies,
  order: OrderRecord,
  type: CheckoutEventType,
  checkout: CheckoutState
): Promise<Omit<EventAction, 'orderId'>> {
  if (type === 'checkout_paid') {
    const refused = await markPaid(deps, order, checkout)
    if (refused) return { outcome: refused }
    const owed =
      order.status === 'pending' ||
      order.status === 'failed' ||
      (order.status === 'paid' && order.appliedAt === null)
    // Applied or refunded already (the buyer's return came first): answered as it stands.
    if (!owed) return { outcome: order.outcome ?? order.status }
    return { after: () => fulfilOrder(deps, order.id), outcome: 'paid' }
  }
  if (type === 'checkout_processing') return { outcome: 'processing' }
  if (order.status !== 'pending') return { outcome: `already_${order.status}` }
  await deps.operations.apply(
    buildMarkOrderFailedPlans({
      now: nowIso(deps),
      orderId: order.id,
      reason: type === 'checkout_expired' ? 'expired' : 'payment_failed'
    })
  )
  return { outcome: 'failed' }
}

/**
 * Whether a checkout charged the order's price: the order's amount before any discount, in
 * its currency, less exactly the discount a promotion code took (#250). Anything else, a
 * changed price or an unexplained difference, does not match.
 */
export function chargeMatchesOrder(checkout: CheckoutState, order: OrderRecord): boolean {
  if (checkout.currency !== order.currency || checkout.amountCents === null) return false
  const subtotal = checkout.subtotalCents ?? checkout.amountCents
  const discount = checkout.discountCents ?? 0
  return (
    subtotal === order.amountCents &&
    discount >= 0 &&
    checkout.amountCents >= 0 &&
    checkout.amountCents + discount === order.amountCents
  )
}

/**
 * A promotion code's discount on an order, for people to see (#250): the price less what was
 * charged, only for an order its payment applied. A charge that didn't match the order is
 * never applied (it is refunded as `unapplied`), so it never reads as a discount, whatever
 * `attention` became later (a failed refund replaces `amount_mismatch` with `refund_failed`).
 */
export function orderDiscountCents(order: OrderRecord): number {
  if (order.outcome === null || order.outcome === 'unapplied') return 0
  if (order.chargedCents === null || order.chargedCurrency !== order.currency) return 0
  return Math.max(0, order.amountCents - order.chargedCents)
}

/**
 * A paid checkout, recorded and then applied: the buyer's return and the sweep apply it now;
 * the webhook records it now and applies it after its answer (`handleWebhook`).
 */
async function recordPayment(
  deps: BillingDependencies,
  order: OrderRecord,
  checkout: CheckoutState
): Promise<string> {
  return (await markPaid(deps, order, checkout)) ?? fulfilOrder(deps, order.id)
}

/**
 * Records a paid checkout on its order: the order becomes `paid` (once), recording what was
 * actually charged. A promotion code's discount is charged less (#250); a 100%-off code charges
 * nothing and has no payment, so the checkout stands as its reference. A charge that doesn't
 * match the order is flagged for an admin (`amount_mismatch`), and fulfilment refunds it in full
 * instead of applying it. The outcome of a payment it refuses, or null when the payment stands
 * (recorded now or before).
 */
async function markPaid(
  deps: BillingDependencies,
  order: OrderRecord,
  checkout: CheckoutState
): Promise<string | null> {
  if (order.providerCheckoutId && checkout.checkoutId !== order.providerCheckoutId) {
    return 'checkout_mismatch'
  }
  if (order.status === 'pending' || order.status === 'failed') {
    const paymentId =
      checkout.paymentId ?? (checkout.amountCents === 0 ? checkout.checkoutId : null)
    if (!paymentId) return 'no_payment_id'
    const mismatch = !chargeMatchesOrder(checkout, order)
    await deps.operations.apply(
      buildMarkOrderPaidPlans({
        attention: mismatch ? 'amount_mismatch' : null,
        chargedCents: checkout.amountCents ?? order.amountCents,
        chargedCurrency: checkout.currency ?? order.currency,
        now: nowIso(deps),
        orderId: order.id,
        paymentId
      })
    )
    if (mismatch) {
      logError('billing_amount_mismatch', new Error('The charge does not match the order.'), {
        order: order.id
      })
    }
    log('billing_order_paid', { order: order.id })
  }
  return null
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
 * charge that didn't match the order, is refunded in full (`unapplied`). A disputed payment is
 * never applied, nor refunded (the provider refuses): an admin decides (#473).
 */
export async function fulfilOrder(deps: BillingDependencies, orderId: string): Promise<string> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const order = await deps.operations.order(orderId)
    if (!order) return 'unknown_order'
    if (order.status !== 'paid' || order.appliedAt !== null) return order.outcome ?? order.status
    if (order.disputeStatus !== null) return 'disputed'
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

/**
 * "Live after payment" or "Payment received: in review", and the admin's review alert; the
 * sweep sends them again (`recover`) for a fulfilment cut off before they went (#481).
 */
async function emailPaidSubmission(
  deps: BillingDependencies,
  submission: CheckoutSubmission,
  order: OrderRecord,
  result: { live: true } | { live: false; problem: string },
  recover = false
): Promise<void> {
  const eventKey = deps.eventKey('submission-paid', submission.id)
  const again = recover ? { recover: true } : {}
  const sends: Promise<void>[] = []
  if (submission.ownerEmail) {
    sends.push(
      result.live
        ? deps.notify('listing-live-paid', {
            ...again,
            eventKey,
            input: {
              listingName: submission.name,
              listingSlug: submission.slug,
              paidCents: order.chargedCents ?? order.amountCents
            },
            to: submission.ownerEmail
          })
        : deps.notify('payment-received-in-review', {
            ...again,
            eventKey,
            input: {
              checkProblem: result.problem,
              paidCents: order.chargedCents ?? order.amountCents,
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
      ...again,
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

/**
 * A paid claim: the claim's completion and this order's applied record commit in one batch, so
 * the payment completed the claim exactly when it is applied. A claim completed some other way
 * (another payment, the badge), or one that can't complete, leaves this payment unapplied, and
 * it is refunded; a racing delivery of this same order that applied it is answered as is.
 */
async function applyClaimPayment(deps: BillingDependencies, order: OrderRecord): Promise<string> {
  if (!deps.paidClaims || !order.claimId) return refundUnapplied(deps, order)
  const completed = await deps.paidClaims.complete({
    actor: BILLING_ACTOR,
    claimId: order.claimId,
    together: buildMarkOrderAppliedPlans({
      now: nowIso(deps),
      orderId: order.id,
      outcome: 'claimed'
    }),
    userId: order.userId
  })
  if (completed) {
    log('billing_order_applied', { order: order.id, outcome: 'claimed' })
    return 'claimed'
  }
  const current = await deps.operations.order(order.id)
  if (current?.appliedAt) return current.outcome ?? 'claimed'
  // Disputed meanwhile (#473): never applied, nor refunded; `fulfilOrder` answers it.
  if (current?.disputeStatus) return 'retry'
  return refundUnapplied(deps, current ?? order)
}

// ---------------------------------------------------------------------------------------------
// Refunds: claim, then the provider, then finalize

/** What a finished refund did to the listing. */
export type RefundListing = 'kept_free' | 'unchanged' | 'unpublished'

const CHANGED = failure(
  409,
  'conflict',
  'This changed since you opened it. Reload the page and try again.'
)

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

/**
 * The refund that sent a claimed refund's money back (#486): its provider id when known, and
 * whether it was made outside the site (the provider's dashboard), so the order credits it.
 */
interface ReturnedRefund {
  outside: boolean
  refundId: string | null
}

/** The site's own refund, as today: credited to the claim's actor. */
const SITE_REFUND: ReturnedRefund = { outside: false, refundId: null }

/**
 * What the provider records of an order's payment now (#486): whether its refunds that haven't
 * failed send all of it back (`returned`), and the one that sends the money back (the site's own,
 * by the order it names, else the newest), and the newest that failed or was canceled (`failed`,
 * the refund a flag records unless a report names its own, #503, #514), or the provider's error
 * when it couldn't say. The error is null when retrying wouldn't help: nothing to ask about, or a
 * key refused the read.
 */
type RefundsAtProvider =
  | {
      checked: true
      failed: ProviderRefund | null
      refund: ProviderRefund | null
      returned: boolean
    }
  | { checked: false; error: unknown }

async function refundsAtProvider(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<RefundsAtProvider> {
  const charged = order.chargedCents ?? order.amountCents
  if (!order.providerPaymentId || charged === 0) return { checked: false, error: null }
  let refunds: ProviderRefund[]
  try {
    refunds = await deps.provider.paymentRefunds(order.providerPaymentId)
  } catch (error) {
    // A key refused the read (401, 403) won't be let in on a retry: the event decides as before
    // and is answered, rather than every refund event answering 500 until Stripe gives up (#498's
    // review). Anything else (Stripe down, rate-limited, a partial list) is retried.
    const refused =
      error instanceof BillingProviderError && (error.status === 401 || error.status === 403)
    logError('billing_refunds_unchecked', error, { order: order.id, retry: !refused })
    return { checked: false, error: refused ? null : error }
  }
  const sending = refunds.filter(
    refund => refund.status === 'pending' || refund.status === 'succeeded'
  )
  return {
    checked: true,
    failed:
      refunds.find(refund => refund.status === 'failed' || refund.status === 'canceled') ?? null,
    refund: sending.find(refund => refund.orderId === order.id) ?? sending[0] ?? null,
    returned: sending.reduce((sum, refund) => sum + refund.amountCents, 0) >= charged
  }
}

/**
 * The refund that sent back a payment the provider says was refunded already, by the provider's
 * record (`refundsAtProvider`): the site's own (an earlier attempt whose idempotency key expired)
 * or one made outside the site, perhaps while the site's ran (#486). `otherwise` decides when the
 * provider can't say.
 */
async function returnedRefund(
  deps: BillingDependencies,
  order: OrderRecord,
  otherwise: ReturnedRefund
): Promise<ReturnedRefund> {
  return refundOf(await refundsAtProvider(deps, order), order, otherwise)
}

function refundOf(
  atProvider: RefundsAtProvider,
  order: OrderRecord,
  otherwise: ReturnedRefund
): ReturnedRefund {
  if (!atProvider.checked || !atProvider.refund) return otherwise
  return { outside: atProvider.refund.orderId !== order.id, refundId: atProvider.refund.id }
}

/**
 * The provider refund of exactly what was charged, under the order's refund key. A 100%-off
 * order charged nothing, so there is nothing to send back (#250). A payment refunded already is
 * credited to the refund that sent the money back (#486); when the provider can't say which, to
 * the claim, as before.
 */
async function providerRefund(
  deps: BillingDependencies,
  order: OrderRecord
): Promise<ReturnedRefund> {
  const charged = order.chargedCents ?? order.amountCents
  if (charged === 0) return SITE_REFUND
  if (!order.providerPaymentId) {
    throw new CodedError('refund_payment_missing', `Order ${order.id} has no payment to refund.`)
  }
  const { refundId } = await deps.provider.refund({
    amountCents: charged,
    idempotencyKey: `refund:${order.id}`,
    orderId: order.id,
    paymentId: order.providerPaymentId
  })
  if (refundId !== null) return { outside: false, refundId }
  return returnedRefund(deps, order, SITE_REFUND)
}

function finishPlans(
  deps: BillingDependencies,
  order: OrderRecord,
  refund: ReturnedRefund
): StatementPlan[] {
  return buildFinishRefundPlans({
    now: nowIso(deps),
    orderId: order.id,
    refundedBy: refund.outside ? PROVIDER_ACTOR : null,
    refundId: refund.refundId
  })
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
  if (!claimed) throw new CodedError('refund_order_missing', `Order ${orderId} not found.`)
  if (claimed.status === 'refunded') return listingResult(claimed.refundListingAction)
  if (claimed.status !== 'refunding') {
    throw new CodedError('refund_not_claimed', `Order ${orderId} has no claimed refund.`)
  }
  let refund: ReturnedRefund
  try {
    refund = await providerRefund(deps, claimed)
  } catch (error) {
    // Backed off (1, 2, 4, 8 hours…); the last allowed failure flags it for an admin.
    const delay = RECONCILE_AFTER_MS * 6 * 2 ** Math.min(claimed.refundAttempts, 5)
    await deps.operations.apply(
      buildRecordRefundFailurePlans({
        attempts: claimed.refundAttempts,
        now: nowIso(deps),
        orderId: claimed.id,
        retryAt: new Date(deps.now().getTime() + delay).toISOString()
      })
    )
    throw error
  }
  const listing = await recordClaimedRefund(deps, orderId, refund, true)
  if (refund.outside) await alertRefundedOutside(deps, orderId)
  return listing
}

/**
 * The admin's "refunded outside the site" alert for a claimed refund an outside refund finished
 * (#486), once that is what the order records. A failed send is logged: the refund is recorded.
 */
async function alertRefundedOutside(deps: BillingDependencies, orderId: string): Promise<void> {
  const order = await deps.operations.order(orderId)
  if (order?.refundedBy !== PROVIDER_ACTOR) return
  log('billing_order_refunded_at_provider', { claimed: order.refundReason, order: order.id })
  try {
    await alertAdmin(deps, order, 'refunded')
  } catch (error) {
    logError('billing_payment_alert_failed', error, { order: order.id })
  }
}

/**
 * Records a claimed refund the provider made, in one batch: the rejection's or the admin's
 * recorded listing change, and `refunded`, credited to the refund that sent the money back
 * (#486). `withRejection` false records a rejection's refund on the order alone: its own refund
 * (`refundRejectedSubmission`, which the sweep retries) then records it on the submission and
 * emails the owner.
 */
async function recordClaimedRefund(
  deps: BillingDependencies,
  orderId: string,
  refund: ReturnedRefund,
  withRejection: boolean
): Promise<RefundListing> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const order = await deps.operations.order(orderId)
    if (!order) throw new CodedError('refund_order_missing', `Order ${orderId} not found.`)
    if (order.status === 'refunded') return listingResult(order.refundListingAction)
    let plans: StatementPlan[] = []
    let result: RefundListing = 'unchanged'
    if (order.refundReason === 'rejected' && order.submissionId && withRejection) {
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
    if (await deps.operations.apply([...plans, ...finishPlans(deps, order, refund)])) {
      log('billing_order_refunded', {
        order: order.id,
        outside: refund.outside,
        reason: order.refundReason
      })
      return result
    }
  }
  const order = await deps.operations.order(orderId)
  if (order?.status === 'refunded') return listingResult(order.refundListingAction)
  throw new CodedError(
    'refund_not_recorded',
    `The refund of order ${orderId} could not be recorded yet.`
  )
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
 * What a rejection's refund did: `refunded`, or `disputed` when the payment's dispute is open or
 * lost, so nothing was refunded and the dispute decides the money (#483).
 */
export type RejectionRefund = 'disputed' | 'refunded'

/**
 * The admin panel's refund hook for a paid submission rejected as `other` (`AdminRefunds`,
 * docs/admin-panel.md "Refunds"): claims its order's refund, refunds at the provider, records
 * it on the submission and the order in one batch, and sends "rejected and refunded". Runs
 * after the rejection, on every replay of it, and from the sweep; throws when the refund didn't
 * go through, so it stays pending. A payment under dispute, or whose dispute was lost, is never
 * refunded (the provider refuses, #483): the order records that the dispute decides the refund,
 * which ends the sweep's retries, and the owner gets the plain rejection.
 */
export async function refundRejectedSubmission(
  deps: BillingDependencies,
  input: { actor: string; submissionId: string }
): Promise<RejectionRefund> {
  const submission = await deps.operations.checkoutSubmission(input.submissionId)
  if (submission?.status !== 'rejected') {
    throw new CodedError(
      'refund_submission_not_rejected',
      'Only a rejected submission is refunded this way.'
    )
  }
  const review = await deps.operations.rejection(input.submissionId)
  if (review?.category !== 'other') {
    throw new CodedError('refund_rejection_prohibited', 'A prohibited rejection is never refunded.')
  }
  let order = await deps.operations.submissionPaymentOrder(input.submissionId)
  if (!order) {
    throw new CodedError(
      'refund_paid_order_missing',
      `No paid order for submission ${input.submissionId}.`
    )
  }
  if (order.status === 'paid' && disputeBlocksRefund(order)) {
    const recorded = await deps.operations.apply(
      buildRecordDisputedRejectionPlans({ now: nowIso(deps), orderId: order.id })
    )
    if (recorded) {
      log('billing_rejection_disputed', { order: order.id })
      await emailRejection(deps, submission, review, 0)
      return 'disputed'
    }
    // Its dispute closed won, or a refund was recorded, meanwhile: decided on it as it is now.
    order = (await deps.operations.order(order.id)) ?? order
  }
  if (order.status === 'paid') {
    const claimed = await claimRefund(deps, order, { actor: input.actor, reason: 'rejected' })
    const current = claimed ? null : await deps.operations.order(order.id)
    if (current && current.status === 'paid') {
      throw new CodedError('refund_claim_failed', 'The refund could not be claimed.')
    }
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
  await emailRejection(deps, submission, review, order.chargedCents ?? order.amountCents)
  return 'refunded'
}

/**
 * The owner's rejection email: "rejected and refunded", or the plain rejection when nothing went
 * back (a 100%-off order charged nothing, #250; a disputed payment, #483). `recover`: the sweep's
 * resend (#514).
 */
async function emailRejection(
  deps: BillingDependencies,
  submission: CheckoutSubmission,
  review: { reason: string },
  refundedCents: number,
  recover = false
): Promise<void> {
  if (!submission.ownerEmail) return
  const request = {
    eventKey: deps.eventKey('submission-rejected', submission.id),
    ...(recover ? { recover: true } : {}),
    to: submission.ownerEmail
  }
  const rejected = {
    reason: review.reason,
    submissionId: submission.id,
    submissionName: submission.name
  }
  await (refundedCents === 0
    ? deps.notify('submission-rejected', { ...request, input: rejected })
    : deps.notify('submission-rejected-refunded', {
        ...request,
        input: { ...rejected, refundedCents }
      }))
}

/**
 * "Rejected and refunded" for a rejection whose refund is recorded (#514): the submission rejected
 * as `other` and recorded refunded, its order `refunded` and not flagged `refund_failed` (the money
 * went back). It goes under the rejection's event key, so the email ledger sends it once whichever
 * path recorded the refund: the decision and its replays, the sweep's retry, an admin's "Refund…",
 * or the provider's report and then the sweep. True when it was asked to send.
 */
async function emailRefundedRejection(
  deps: BillingDependencies,
  submissionId: string,
  recover = false
): Promise<boolean> {
  const submission = await deps.operations.checkoutSubmission(submissionId)
  if (submission?.status !== 'rejected' || submission.refundedAt === null) return false
  const review = await deps.operations.rejection(submissionId)
  if (review?.category !== 'other') return false
  const order = await deps.operations.submissionPaymentOrder(submissionId)
  if (order?.status !== 'refunded' || order.attention === 'refund_failed') return false
  await emailRejection(deps, submission, review, order.chargedCents ?? order.amountCents, recover)
  return true
}

/**
 * Tells the owner of a rejection whose claimed refund was finished outside the rejection's own
 * refund (`refundRejectedSubmission`): by the sweep's retry, or an admin's "Refund…" of one a
 * failure left. Finishing it records the submission refunded too, which takes it off the
 * refund-pending list the rejection's own refund emails from, so nothing else would (#514). A
 * failure is logged, not thrown: the refund is recorded, and the sweep sends the email again
 * (`recoverEmails`).
 */
async function emailFinishedRejection(
  deps: BillingDependencies,
  order: Pick<OrderRecord, 'id' | 'refundReason' | 'submissionId'>
): Promise<void> {
  if (order.refundReason !== 'rejected' || !order.submissionId) return
  try {
    await emailRefundedRejection(deps, order.submissionId)
  } catch (error) {
    logError('billing_rejection_email_failed', error, { order: order.id })
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
 * A payment under dispute, or one whose dispute was lost, can't be refunded: the provider refuses
 * (#473). Admin Orders offers no "Refund…" for it, and the refund routes answer 409.
 */
export function disputeBlocksRefund(order: Pick<OrderRecord, 'disputeStatus'>): boolean {
  return order.disputeStatus === 'open' || order.disputeStatus === 'lost'
}

const DISPUTED = failure(409, 'disputed', 'This payment is disputed, so it can’t be refunded here.')

/** A payment refunded outside the site (#473), never reported as an admin's refund (#484). */
const REFUNDED_OUTSIDE = failure(
  409,
  'refunded_outside',
  'This payment was refunded outside the site, so nothing was refunded here.'
)

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
  let check: RefundBadgeResult
  if (badgeCheckId) {
    // The dialog's check decides, exactly as it showed it. One a newer dialog replaced, or one
    // left open over an hour, is refused (409): the dialog previews again rather than the
    // refund silently doing what another check says.
    const shown = await deps.operations.refundBadgeCheck(badgeCheckId)
    if (
      !shown?.latest ||
      shown.listingId !== submission.listingId ||
      deps.now().getTime() - Date.parse(shown.checkedAt) >= REFUND_CHECK_MAX_AGE_MS
    ) {
      return CHANGED
    }
    check = { checkId: shown.id, keepFree: shown.outcome === 'pass' }
  } else {
    check = await deps.badgeAtRefund(submission.listingId)
  }
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
  if (order.status === 'refunding') {
    // A refund a failure left: finishing it repeats the recorded decision.
    return {
      badgeCheckId: order.refundBadgeCheckId,
      kind: 'refund',
      listingAction: order.refundListingAction ?? 'none',
      listingNow: null,
      ok: true
    }
  }
  if (order.refundedBy === PROVIDER_ACTOR) return REFUNDED_OUTSIDE
  if (order.status !== 'paid') {
    return failure(409, 'not_refundable', 'Only a paid order can be refunded.')
  }
  if (disputeBlocksRefund(order)) return DISPUTED
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
  input: {
    actor: string
    badgeCheckId?: number | null
    /** What the dialog said the refund does to the listing; a different decision is a 409. */
    listingAction?: OrderRefundListingAction | null
    note?: string | null
    orderId: string
  }
): Promise<RefundOrderResult> {
  const order = await deps.operations.order(input.orderId)
  if (!order) return failure(404, 'not_found', 'That order doesn’t exist.')
  if (order.refundedBy === PROVIDER_ACTOR) return REFUNDED_OUTSIDE
  if (order.status === 'refunded') {
    return { listing: await finishRefund(deps, order.id), ok: true, replayed: true }
  }
  if (order.status === 'refunding') {
    const answer = await finishAdminRefund(deps, order.id, false)
    await emailFinishedRejection(deps, order)
    return answer
  }
  if (order.status !== 'paid') {
    return failure(409, 'not_refundable', 'Only a paid order can be refunded.')
  }
  if (disputeBlocksRefund(order)) return DISPUTED
  const decision = await decideRefund(deps, order, input.badgeCheckId)
  if (!('kind' in decision)) return decision
  if (
    input.listingAction &&
    (decision.kind !== 'refund' || decision.listingAction !== input.listingAction)
  ) {
    return CHANGED
  }
  if (decision.kind === 'rejection') {
    const refunded = await refundRejectedSubmission(deps, {
      actor: input.actor,
      submissionId: decision.submissionId
    })
    // A dispute opened since the check above: nothing was refunded, and the dispute decides.
    if (refunded === 'disputed') return DISPUTED
    return refundedOutside(deps, order.id, { listing: 'unchanged', ok: true, replayed: false })
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
    // Refunded outside the site meanwhile: that refund, not this one, sent the money back.
    if (current?.refundedBy === PROVIDER_ACTOR) return REFUNDED_OUTSIDE
    if (current?.refundReason !== 'admin') {
      return failure(
        409,
        'conflict',
        'This changed since you opened it. Reload the page and try again.'
      )
    }
  }
  return finishAdminRefund(deps, order.id, !claimed)
}

/** Finishes an admin's claimed refund and answers it (`refundedOutside`). */
async function finishAdminRefund(
  deps: BillingDependencies,
  orderId: string,
  replayed: boolean
): Promise<RefundOrderResult> {
  const listing = await finishRefund(deps, orderId)
  return refundedOutside(deps, orderId, { listing, ok: true, replayed })
}

/**
 * An admin's refund that a refund made outside the site beat while it ran (#486): that refund
 * sent the money back, so the admin's answers 409 (`refunded_outside`), never success. The
 * listing change the admin chose still applied.
 */
async function refundedOutside(
  deps: BillingDependencies,
  orderId: string,
  answer: RefundOrderResult
): Promise<RefundOrderResult> {
  const order = await deps.operations.order(orderId)
  return order?.refundedBy === PROVIDER_ACTOR ? REFUNDED_OUTSIDE : answer
}

// ---------------------------------------------------------------------------------------------
// Payment changes outside the site: refunds and disputes (#473)

/** The admin's alert for each payment event outcome that sends one. */
const PAYMENT_ALERTS: Readonly<Record<string, PaymentAlertKind>> = {
  disputed: 'disputed',
  disputed_lost: 'disputed',
  dispute_won_refund: 'dispute_won_refund',
  partially_refunded: 'partially_refunded',
  refund_failed: 'refund_failed',
  refunded_at_provider: 'refunded'
}

/**
 * A refund or a dispute the provider reported, on the order that took the payment, before the
 * answer. A dispute that opens, or a refund of the whole payment made outside the site (the
 * provider's dashboard), takes down the listing the payment made or kept live, in the same batch
 * as the order's record (the owner's decision on #156), and the admin is emailed. A closed
 * dispute records its outcome only (a lost one never reported open is opened first): nothing
 * republishes the listing, the admin decides. The site's own refund was claimed (`refunding`)
 * before the provider was asked, so its report is answered as the order stands; one the site's
 * refund failed to make is recorded as that refund. A refunded order's `refund_failed` flag then
 * follows the provider's record of the payment's refunds (`settleRefundFlag`, #486). Returns the
 * event's outcome.
 */
async function actOnPayment(
  deps: BillingDependencies,
  order: OrderRecord,
  type: PaymentEventType,
  payment: PaymentChange
): Promise<string> {
  switch (type) {
    case 'payment_disputed':
      return recordPaymentChange(deps, order, 'disputed')
    case 'dispute_closed':
      return payment.disputeOutcome ? closeDispute(deps, order, payment.disputeOutcome) : 'ignored'
    case 'payment_refunded': {
      if (payment.partial) return alertPartialRefund(deps, order, payment)
      const requestKey = payment.requestKey ?? null
      const outcome = await recordPaymentChange(deps, order, 'refunded', requestKey)
      await settleRefundFlag(deps, order.id, requestKey)
      return outcome
    }
    case 'payment_refund_failed':
      return flagRefundFailed(deps, order, payment.refundId ?? null)
  }
}

interface Takedown {
  listingAction: OrderRefundListingAction
  plans: StatementPlan[]
  submission: CheckoutSubmission | null
}

/**
 * The plans that take down the listing an order's payment made or kept live (a paid
 * submission's, an upgrade's, or a relist's), even while its submission is in review, or the
 * listing whose ownership a paid claim's payment bought: a claim's comes down too (the owner's
 * decision on #473, 2026-10-16) while its payer still owns it through that payment, and its
 * ownership stays as it is for an admin to decide. A payment nothing
 * applied, or one held for review, has no listing live; and a refunded order's listing no longer
 * rides on its payment (a refund decided its listing already): those take nothing down (`none`).
 * A dispute also takes it down while the site's own refund hasn't returned the money (still
 * `refunding`: in flight, retrying, or flagged `refund_failed`; a dispute usually makes that refund
 * fail), and on a `refunded` order whose refund failed (`refundFailed`, #484), whether its
 * `refund.failed` arrived before the dispute (flagged when the dispute arrives) or after it (the
 * lead's decision on #485): the money never went back and the buyer disputes it. A refund that
 * succeeded (`refunded`, not flagged) decided its listing, so a dispute on it takes nothing down.
 * A listing already down, by that refund's rejection or listing change say, stays as it is
 * (`already_unpublished`).
 */
async function takedownPlans(
  deps: BillingDependencies,
  order: OrderRecord,
  reason: 'disputed' | 'refunded',
  /** A `refunded` order's refund failed: flagged `refund_failed`, or being flagged now. */
  refundFailed = false
): Promise<Takedown> {
  const none: Takedown = { listingAction: 'none', plans: [], submission: null }
  const kept =
    order.status === 'paid' ||
    (reason === 'disputed' &&
      (order.status === 'refunding' || (refundFailed && order.status === 'refunded')))
  if (!kept || order.appliedAt === null || order.outcome === 'unapplied') return none
  if (order.purpose === 'claim') {
    // The listing whose ownership this payment bought, while the payer still owns it through it:
    // after an admin's revoke or transfer (a stolen card, say) it belongs to someone else, so
    // the payment change is recorded and the admin emailed, and nothing comes down.
    if (!(await deps.operations.paidClaimStands(order))) return none
    const slug = (await deps.operations.adminOrder(order.id))?.listingSlug
    return order.listingId && slug
      ? unpublishTakedown(deps, { listingId: order.listingId, reason, slug, submission: null })
      : none
  }
  if (!order.submissionId) return none
  const submission = await deps.operations.checkoutSubmission(order.submissionId)
  if (!submission?.listingId) return { ...none, submission }
  return unpublishTakedown(deps, {
    listingId: submission.listingId,
    reason,
    slug: submission.slug,
    submission
  })
}

/** Unpublishes a live listing, through the /admin unpublish path, even while in review. */
async function unpublishTakedown(
  deps: BillingDependencies,
  input: {
    listingId: string
    reason: 'disputed' | 'refunded'
    slug: string
    submission: CheckoutSubmission | null
  }
): Promise<Takedown> {
  const { listingId, reason, submission } = input
  if (!(await deps.operations.listingLive(listingId))) {
    return { listingAction: 'already_unpublished', plans: [], submission }
  }
  const now = nowIso(deps)
  return {
    listingAction: 'unpublish',
    plans: buildUnpublishListingPlans({
      listingId,
      publication: await publicationFor(deps, {
        action: reason === 'disputed' ? 'dispute-unpublish' : 'provider-refund-unpublish',
        actor: BILLING_ACTOR,
        entityId: listingId,
        now,
        slug: input.slug
      }),
      reason,
      whileInReview: true
    }),
    submission
  }
}

/**
 * The paid submission states a refund made at the provider records refunded on (`at_provider`):
 * approved, or held for review. One in review with its listing (`paid_pending_review`, or
 * `changes_requested` from it) can't hold `refunded_at` (a CHECK), so its refunded order is the
 * record the admin's plan reading checks; a rejection records it on the submission, as a
 * rejected one's own refund does (and emails the owner).
 */
const REFUNDABLE_AT_PROVIDER: ReadonlySet<string> = new Set(['approved', 'verified'])

/**
 * Records a dispute that opened, or a refund of the whole payment made at the provider, with the
 * listing's takedown in the same batch, then alerts the admin. Neither comes back as paid: the
 * admin's plan reading checks the paying order (refunded, or disputed and not won), and a refund
 * also records an approved or held submission as refunded. Each attempt decides on the order
 * as it reads it now; three lost writes (the catalog publication race) throw, so the delivery
 * answers 500 and the provider's retry runs it again. One already recorded (an earlier delivery
 * that failed before its answer) is alerted again, which the email ledger sends once.
 */
async function recordPaymentChange(
  deps: BillingDependencies,
  order: OrderRecord,
  change: 'disputed' | 'refunded',
  /** The refund's request key (`PaymentChange.requestKey`): the site's own is `refund:<order>`. */
  requestKey: string | null = null
): Promise<string> {
  const outcome = change === 'disputed' ? 'disputed' : 'refunded_at_provider'
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const current = attempt === 0 ? order : await deps.operations.order(order.id)
    if (!current) return 'unknown_order'
    const recorded =
      change === 'disputed'
        ? current.disputeStatus === 'open'
        : current.status === 'refunded' && current.refundedBy === PROVIDER_ACTOR
    if (recorded) {
      await alertAdmin(deps, current, change)
      return outcome
    }
    // A dispute that closed before its opening arrived (a lost one recorded its opening then).
    if (change === 'disputed' && current.disputeStatus !== null) {
      return `dispute_${current.disputeStatus}`
    }
    if (
      change === 'refunded' &&
      current.status === 'refunding' &&
      !siteRefundRunning(deps, current)
    ) {
      return finishRefundAtProvider(deps, current, requestKey === `refund:${current.id}`)
    }
    // The site's own refund: its finish records it.
    if (change === 'refunded' && current.status !== 'paid') return `already_${current.status}`
    const now = nowIso(deps)
    // A refund that failed before the dispute arrived (#485's lead decision); the dispute's
    // record compares and swaps on the flag, so a `refund.failed` racing it is never missed.
    const refundFailed = current.attention === 'refund_failed'
    const takedown = await takedownPlans(deps, current, change, refundFailed)
    const submission = takedown.submission
    const plans =
      change === 'disputed'
        ? buildRecordDisputePlans({ now, orderId: current.id, refundFailed })
        : [
            ...(submission &&
            REFUNDABLE_AT_PROVIDER.has(submission.status) &&
            submission.plan === 'paid' &&
            submission.paidAt !== null &&
            submission.refundedAt === null
              ? buildRefundSubmissionPlans({
                  actor: PROVIDER_ACTOR,
                  mode: 'at_provider',
                  now,
                  submissionId: submission.id
                })
              : []),
            ...buildRecordProviderRefundPlans({
              listingAction: takedown.listingAction,
              now,
              orderId: current.id,
              outcome: current.outcome
            })
          ]
    if (await deps.operations.apply([...takedown.plans, ...plans])) {
      log(change === 'disputed' ? 'billing_order_disputed' : 'billing_order_refunded_at_provider', {
        listing: takedown.listingAction,
        order: current.id
      })
      await alertAdmin(deps, current, change)
      return outcome
    }
  }
  throw new CodedError(
    'billing_payment_change_not_recorded',
    `The ${change} payment of order ${order.id} could not be recorded yet.`
  )
}

/**
 * Whether the site's own refund of a `refunding` order may still be running: claimed less than
 * `RECONCILE_AFTER_MS` ago (the sweep takes it over after that) and never failed at the
 * provider. Its `charge.refunded` is then its own, and its finish records it.
 */
function siteRefundRunning(deps: BillingDependencies, order: OrderRecord): boolean {
  return (
    order.refundAttempts === 0 &&
    order.attention !== 'refund_failed' &&
    order.refundRequestedAt !== null &&
    Date.parse(order.refundRequestedAt) > deps.now().getTime() - RECONCILE_AFTER_MS
  )
}

/**
 * The whole payment refunded at the provider while the site's own refund of it had failed
 * (`refunding`, retrying or `refund_failed`): the money is back, so the claimed refund is
 * recorded as the site's would be (its listing change, then `refunded`), credited to the refund
 * that sent the money back (#486): one made outside the site is recorded as that
 * (`PROVIDER_ACTOR`), and the admin is told. The site's retry would only be refused (the charge
 * is refunded already). The provider's record of the payment's refunds says which refund it was;
 * when it can't, the report's request key does: the site's own (`siteRefund`) is a call whose
 * answer never came back (a timeout after the provider refunded), recorded as the site's refund
 * with no "refunded outside the site" alert (#484). When the provider's record says its refunds
 * that haven't failed don't send the payment back (the reported refund failed since: a retried
 * report, delivered after its failure, #498's review), nothing went back: the order stays
 * `refunding`, flagged `refund_failed` (the sweep stops retrying it, and never tells the owner it
 * was refunded). When the provider can't say for now (down, a timeout, a rate limit, a 5xx, a
 * partial list), the report alone can't show the money went back, so nothing is recorded and the
 * error answers the delivery 500: the order stays as it was, and the provider's retry decides with
 * its record (#504). A read the key is refused, or nothing to ask about (no error to retry), still
 * decides by the report.
 */
async function finishRefundAtProvider(
  deps: BillingDependencies,
  order: OrderRecord,
  siteRefund: boolean
): Promise<string> {
  const atProvider = await refundsAtProvider(deps, order)
  if (!atProvider.checked && atProvider.error) throw atProvider.error
  if (atProvider.checked && !atProvider.returned) {
    logWarning('billing_refund_not_returned', { order: order.id })
    if (order.attention === 'refund_failed') return 'refund_failed'
    return flagRefundFailedNow(deps, order, null)
  }
  const refund = refundOf(atProvider, order, { outside: !siteRefund, refundId: null })
  await recordClaimedRefund(deps, order.id, refund, false)
  if (!refund.outside) return 'refunded'
  log('billing_order_refunded_at_provider', { claimed: order.refundReason, order: order.id })
  await alertAdmin(deps, order, 'refunded')
  return 'refunded_at_provider'
}

/**
 * A `refunded` order's `refund_failed` flag, after a report of the whole payment refunded: the
 * flag follows the provider's record of the payment's refunds (#486), whatever order their
 * events arrive in. Its refunds that haven't failed send it all back: a flag clears (a later
 * refund, in the provider's dashboard say, sent the money back, #485) and records that refund.
 * They don't: the refund that sent it back has failed since, so the order is flagged as its
 * `refund.failed` would, recording the same refund (a retried report landing after its failure
 * never clears it, and the admin is emailed once for that failure, #503). When the
 * provider can't say for now (down, a timeout, a rate limit, a 5xx, a partial list), nothing is
 * recorded: a flag stays, and the error answers the delivery 500, so the provider's retry decides
 * with its record (#513). When its key is refused the read (401, 403), or there is nothing to ask
 * about, the report decides as before: any but the site's own refund's (its request key, the
 * refund that failed, delivered late) clears the flag. A clear the order changed under while the
 * provider was asked (`clearRefundFailed`) reads both again; when that keeps losing, the flag
 * stays and the delivery answers 500.
 */
async function settleRefundFlag(
  deps: BillingDependencies,
  orderId: string,
  requestKey: string | null
): Promise<void> {
  for (let decision = 0; decision < REFUND_FLAG_DECISIONS; decision += 1) {
    const order = await deps.operations.order(orderId)
    if (order?.status !== 'refunded') return
    const flagged = order.attention === 'refund_failed'
    const atProvider = await refundsAtProvider(deps, order)
    if (!atProvider.checked) {
      if (atProvider.error) throw atProvider.error
      const clears = flagged && requestKey !== `refund:${order.id}`
      if (!clears || (await clearRefundFailed(deps, order, null))) return
    } else if (atProvider.returned && flagged) {
      if (await clearRefundFailed(deps, order, atProvider.refund?.id ?? null)) return
    } else {
      if (!atProvider.returned && !flagged) {
        await flagRefundFailedNow(deps, order, null, atProvider.failed?.id ?? null)
      }
      return
    }
  }
  throw new CodedError(
    'billing_payment_change_not_recorded',
    `The refund_failed flag of order ${orderId} could not be settled yet.`
  )
}

/**
 * Clears a `refunded` order's flag: the money went back, by `refundId` when known (#485, #486).
 * False when the order changed since it was read (its `updated_at`), while the provider was asked:
 * a refund's failure recorded meanwhile, say (#498's review), so the caller reads and decides again.
 */
async function clearRefundFailed(
  deps: BillingDependencies,
  order: OrderRecord,
  refundId: string | null
): Promise<boolean> {
  const cleared = await deps.operations.apply(
    buildClearRefundFailedPlans({
      now: nowIso(deps),
      orderId: order.id,
      refundId,
      updatedAt: order.updatedAt
    })
  )
  if (cleared) log('billing_refund_failed_cleared', { order: order.id })
  return cleared
}

/**
 * A dispute's outcome: the listing stays down until an admin republishes it. A lost dispute
 * whose opening was never recorded (it opened before the events were ticked, or its report is
 * still to come) is recorded as opened first, with its takedown and the admin's alert: the money
 * went back to the buyer. A won one is recorded only, unless a rejection asked no refund while it
 * was open (`DISPUTE_DECIDES_REFUND_NOTE`, #483): the payment is the site's again, so the sweep
 * now refunds it, as the Terms promise for a rejection (`selectRefundPendingSubmissionsPlan`),
 * and the admin is told.
 */
async function closeDispute(
  deps: BillingDependencies,
  order: OrderRecord,
  outcome: 'lost' | 'won'
): Promise<string> {
  const unrecorded = outcome === 'lost' && order.disputeStatus === null
  if (unrecorded) await recordPaymentChange(deps, order, 'disputed')
  await deps.operations.apply(
    buildCloseDisputePlans({ now: nowIso(deps), orderId: order.id, outcome })
  )
  log('billing_dispute_closed', { order: order.id, outcome })
  if (unrecorded) return 'disputed_lost'
  const current = outcome === 'won' ? await deps.operations.order(order.id) : null
  if (
    current?.disputeStatus === 'won' &&
    current.status === 'paid' &&
    current.refundNote === DISPUTE_DECIDES_REFUND_NOTE
  ) {
    await alertAdmin(deps, current, 'dispute_won_refund')
    return 'dispute_won_refund'
  }
  return `dispute_${outcome}`
}

/**
 * Part of a payment refunded outside the site: the order's status and the listing stay as they
 * are (a partial refund isn't the refund of the listing), the amount refunded so far is recorded
 * for admin Orders (#484), and the admin is told. A payment not recorded yet (found by the order
 * it names) is recorded the same way.
 */
async function alertPartialRefund(
  deps: BillingDependencies,
  order: OrderRecord,
  payment: PaymentChange
): Promise<string> {
  if (order.status === 'refunding' || order.status === 'refunded') {
    return `already_${order.status}`
  }
  const refundedCents = payment.refundedCents
  if (typeof refundedCents === 'number' && refundedCents > 0) {
    await deps.operations.apply(
      buildRecordPartialRefundPlans({ now: nowIso(deps), orderId: order.id, refundedCents })
    )
  }
  log('billing_order_partially_refunded', { order: order.id })
  await alertAdmin(deps, order, 'partially_refunded')
  return 'partially_refunded'
}

/**
 * A refund that failed after the provider accepted it. The provider's record of the payment's
 * refunds decides (#486), whatever order their events arrive in: when its refunds that haven't
 * failed still send all of it back (a later refund did, its report delivered first), nothing is
 * flagged, and a flag set while the provider couldn't say is cleared. Otherwise the money never
 * went back (`flagRefundFailedNow`). A `refunded` order not flagged yet records the refund the
 * report names, so its own email goes even when an older or newer refund's failure emailed under
 * another (#514: a refund cleared that flag since). One flagged already keeps the refund it records
 * when the report names that one, so a report processed again retries its email under the same
 * key, as the sweep's resend does (#516's review). A report of another refund records the newest
 * refund the provider's record says failed (#503), as a `charge.refunded` that flagged it did, so
 * the `refund.failed` of that refund, landing after it, sends no second email. When the provider
 * can't say, the report decides as before: a failure of a refund other than the one the order
 * records (`provider_refund_id`: an earlier one, reported after a newer one succeeded, #485) flags
 * nothing; the error then answers the delivery 500, so the provider's retry checks again. A clear
 * or a flag the order changed under while the provider was asked (both compare and swap on its
 * `updated_at`) reads both again, as `settleRefundFlag`'s clear does: a refund decided on a stale
 * read is never recorded over one a concurrent report recorded meanwhile, whose email would then
 * never be sent again (#516's review). When that keeps losing, nothing is recorded and the delivery
 * answers 500.
 */
async function flagRefundFailed(
  deps: BillingDependencies,
  order: OrderRecord,
  /** The refund that failed (`PaymentChange.refundId`), when the provider reports it. */
  refundId: string | null
): Promise<string> {
  let current: OrderRecord | null = order
  for (let decision = 0; decision < REFUND_FLAG_DECISIONS; decision += 1) {
    if (decision > 0) current = await deps.operations.order(order.id)
    if (!current) return 'unknown_order'
    const atProvider = await refundsAtProvider(deps, current)
    if (atProvider.checked && atProvider.returned) {
      const flagged = current.status === 'refunded' && current.attention === 'refund_failed'
      if (flagged && !(await clearRefundFailed(deps, current, atProvider.refund?.id ?? null))) {
        continue
      }
      log('billing_refund_failed_superseded', { order: current.id })
      return 'refund_failed_superseded'
    }
    // The refund that failed: the one the report names while the order isn't flagged, or when it
    // names the refund the flagged order records (#514), else the provider's record's newest failed
    // one, as the flag recorded it (#503).
    const flaggedOther =
      current.attention === 'refund_failed' && refundId !== current.providerRefundId
    let failedRefundId = refundId
    if (atProvider.checked && (refundId === null || flaggedOther)) {
      failedRefundId = atProvider.failed?.id ?? refundId
    }
    const outcome = await flagRefundFailedNow(
      deps,
      current,
      atProvider.checked ? null : refundId,
      failedRefundId,
      true
    )
    // The order changed while the provider was asked: read both again and decide again.
    if (outcome === null) continue
    if (!atProvider.checked && atProvider.error) throw atProvider.error
    return outcome
  }
  throw new CodedError(
    'billing_payment_change_not_recorded',
    `The failed refund of order ${order.id} could not be recorded yet.`
  )
}

/**
 * Flags a refund the site made `refund_failed`: the money never went back (the sweep stops
 * retrying it); the admin is told either way. On a `refunded` order whose dispute is open or lost
 * (it arrived while the refund looked done), the listing comes down now, by the dispute's rules
 * (`takedownPlans`, #484), in the same batch; one with no such dispute is flagged only if none was
 * recorded meanwhile, so the dispute's own takedown reads the flag. `unlessSupersededBy`: when the
 * provider couldn't say (#486), a failure of a refund other than the one the order records flags
 * nothing; one with no recorded refund (blanked when a refund outside the site cleared the flag)
 * always flags. `failedRefundId`: the refund that failed (`flagRefundFailed`'s: the one its report
 * names while the order isn't flagged or records that one, #514, else the newest failed one in the
 * provider's record; `settleRefundFlag`'s: that newest one), which a `refunded` order then records
 * as its refund, so the admin's email is keyed on that refund (`alertKey`, #503). `asRead`
 * (`flagRefundFailed`'s, #516's review): that refund was decided on `order` as read before the
 * provider was asked, so a `refunded` order's write compares and swaps on its `updated_at`. Once
 * the order changed (a newer refund's failure recorded meanwhile, say), it records and sends
 * nothing and returns null, and the caller decides again; a write lost on an unchanged order (the
 * catalog publication race) is tried again. Three lost writes throw, so the provider's retry runs
 * it again.
 */
function flagRefundFailedNow(
  deps: BillingDependencies,
  order: OrderRecord,
  unlessSupersededBy: string | null,
  failedRefundId?: string | null
): Promise<string>
function flagRefundFailedNow(
  deps: BillingDependencies,
  order: OrderRecord,
  unlessSupersededBy: string | null,
  failedRefundId: string | null,
  asRead: true
): Promise<string | null>
async function flagRefundFailedNow(
  deps: BillingDependencies,
  order: OrderRecord,
  unlessSupersededBy: string | null,
  failedRefundId: string | null = null,
  asRead = false
): Promise<string | null> {
  for (let attempt = 0; attempt < PUBLICATION_ATTEMPTS; attempt += 1) {
    const current = attempt === 0 ? order : await deps.operations.order(order.id)
    if (!current) return 'unknown_order'
    if (asRead && current.updatedAt !== order.updatedAt) return null
    // An earlier refund's failure, reported after a newer one (the site's retry once its request
    // key expired) succeeded and was recorded (#485): the money went back, so it flags nothing.
    if (
      unlessSupersededBy !== null &&
      current.providerRefundId !== null &&
      unlessSupersededBy !== current.providerRefundId
    ) {
      log('billing_refund_failed_superseded', { order: current.id })
      return 'refund_failed_superseded'
    }
    const refunded = current.status === 'refunded'
    const disputed = refunded && disputeBlocksRefund(current)
    const takedown = disputed ? await takedownPlans(deps, current, 'disputed', true) : null
    const flagged = await deps.operations.apply([
      ...(takedown?.plans ?? []),
      ...buildFlagRefundFailedPlans({
        disputed,
        now: nowIso(deps),
        orderId: current.id,
        refunded,
        refundId: failedRefundId,
        updatedAt: asRead ? order.updatedAt : null
      })
    ])
    if (flagged) {
      logWarning('billing_refund_failed_at_provider', {
        listing: takedown?.listingAction ?? 'none',
        order: current.id
      })
      // The order as flagged: a `refunded` one records the refund that failed, when reported.
      const providerRefundId = refunded
        ? (failedRefundId ?? current.providerRefundId)
        : current.providerRefundId
      await alertAdmin(deps, { ...current, providerRefundId }, 'refund_failed')
      return 'refund_failed'
    }
  }
  throw new CodedError(
    'billing_payment_change_not_recorded',
    `The failed refund of order ${order.id} could not be recorded yet.`
  )
}

/**
 * Emails the admin about a payment change, once per order and kind, and a failed refund once per
 * refund (`alertKey`, the email ledger's key): the order, its product, and whether its listing is
 * live now. `recover`: the sweep's resend.
 */
async function alertAdmin(
  deps: BillingDependencies,
  order: OrderRecord,
  kind: PaymentAlertKind,
  recover = false
): Promise<void> {
  const row = await deps.operations.adminOrder(order.id)
  await deps.notify('admin-payment-alert', {
    eventKey: await alertKey(deps, order, kind),
    input: {
      kind,
      listingLive: row?.listingSlug ? row.listingLive : null,
      orderNumber: order.number,
      productName: row?.productName ?? null
    },
    ...(recover ? { recover: true } : {}),
    to: deps.adminRecipient
  })
}

/**
 * An admin alert's event key: the order and the kind, and for a failed refund the refund the
 * flagged order records (`provider_refund_id`, #503). That is the refund that failed: the flag
 * records it (`flagRefundFailedNow`), and a clear records the refund that sent the money back, so
 * that refund's own failure emails the admin again, while a retried report of the same failure
 * doesn't. A `refunding` order records none until its refund finishes (which clears the flag), so
 * its failure is keyed on the order alone, as before. The id is hashed: a Stripe id has capitals,
 * which an event key can't.
 */
async function alertKey(
  deps: BillingDependencies,
  order: Pick<OrderRecord, 'id' | 'providerRefundId'>,
  kind: PaymentAlertKind
): Promise<string> {
  const refundId = kind === 'refund_failed' ? order.providerRefundId : null
  if (refundId === null) return deps.eventKey('payment-alert', kind, order.id)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refundId))
  const refund = [...new Uint8Array(digest).slice(0, 16)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return deps.eventKey('payment-alert', kind, order.id, refund)
}

/**
 * Sends again the emails of payments applied, or changed outside the site, in the recovery
 * window (#481): the webhook answers before its fulfilment, so an apply late in `waitUntil`'s
 * 30 seconds, or a Worker stopped after it, may never send them. So too the "rejected and
 * refunded" of rejections whose refund was recorded in it (#514). The email ledger sends each
 * once, and re-claims an attempt cut off mid-send while the provider's idempotency key makes a
 * repeat harmless.
 */
async function recoverEmails(
  deps: BillingDependencies,
  input: { limit: number; now: number }
): Promise<{ emails: number; errors: number }> {
  const counts = { emails: 0, errors: 0 }
  const window = {
    before: new Date(input.now - RECONCILE_AFTER_MS).toISOString(),
    limit: input.limit,
    since: new Date(input.now - EMAIL_RECOVERY_MS).toISOString()
  }
  for (const order of await deps.operations.recentlyAppliedOrders(window)) {
    try {
      const submission = order.submissionId
        ? await deps.operations.checkoutSubmission(order.submissionId)
        : null
      if (!submission) continue
      await emailPaidSubmission(
        deps,
        submission,
        order,
        order.outcome === 'published'
          ? { live: true }
          : { live: false, problem: guardrailProblem(order.checkProblem ?? '') },
        true
      )
      counts.emails += 1
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_email_failed', error, { order: order.id })
    }
  }
  const alerts = await deps.operations.recentBillingEvents({
    ...window,
    outcomes: Object.keys(PAYMENT_ALERTS)
  })
  for (const { orderId, outcome } of alerts) {
    const kind = PAYMENT_ALERTS[outcome]
    try {
      const order = await deps.operations.order(orderId)
      if (!order || !kind) continue
      // A failed refund's email names the refund the flagged order records (`alertKey`, #503).
      // Once the flag cleared, a refund sent the money back: nothing is left to act on, and the
      // refund the order records is that one, whose own failure the key must stay free for.
      if (kind === 'refund_failed' && order.attention !== 'refund_failed') continue
      await alertAdmin(deps, order, kind, true)
      counts.emails += 1
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_email_failed', error, { order: orderId })
    }
  }
  // A rejection's refund recorded in the window (#514): once recorded, nothing lists it again, so
  // a "rejected and refunded" whose send failed (the sweep's, or a decision's no one retried) goes
  // again here.
  for (const submissionId of await deps.operations.recentlyRefundedRejections(window)) {
    try {
      if (await emailRefundedRejection(deps, submissionId, true)) counts.emails += 1
    } catch (error) {
      counts.errors += 1
      logError('billing_sweep_email_failed', error, { submission: submissionId })
    }
  }
  return counts
}

// ---------------------------------------------------------------------------------------------
// Sweep

/**
 * The hourly sweep: retries refunds still owed after an `other` rejection, finishes claimed
 * refunds a failure left (a rejection's with its "rejected and refunded", #514), asks the
 * provider about pending orders whose checkout has closed (paid → applied; otherwise failed) and
 * about failed orders still inside the provider's retry window (a superseded checkout paid late),
 * and applies paid orders left unapplied: usually by a webhook fulfilment that failed or ran out
 * of time after its answer (#468), or a Worker stopped before applying. It then sends again the
 * recent emails that may not have gone (`recoverEmails`, #481). Each item is independent; a
 * failure is logged and retried on the next run.
 */
export async function runBillingSweep(
  deps: BillingDependencies,
  input: { limit: number; providerCalls?: number }
): Promise<Record<string, number>> {
  const counts = { applied: 0, emails: 0, errors: 0, failed: 0, refunds: 0, skipped: 0 }
  // Each item may call the provider once; the run stops calling it after this many.
  let calls = input.providerCalls ?? SWEEP_PROVIDER_CALLS
  const now = deps.now().getTime()
  const orders = await deps.operations.ordersToReconcile({
    before: new Date(now - RECONCILE_AFTER_MS).toISOString(),
    failedSince: new Date(now - FAILED_RECONCILE_MS).toISOString(),
    limit: input.limit,
    now: new Date(now).toISOString()
  })
  // Most urgent first: paid orders never applied, then claimed refunds (at most half the
  // calls, so refunds the provider keeps refusing can't starve the rest), then checkouts.
  let refundCalls = Math.ceil(calls / 2)
  for (const order of orders) {
    if (calls <= 0 || (order.status === 'refunding' && refundCalls <= 0)) {
      counts.skipped += 1
      continue
    }
    calls -= 1
    if (order.status === 'refunding') refundCalls -= 1
    try {
      if (order.status === 'refunding') {
        await finishRefund(deps, order.id)
        counts.refunds += 1
        await emailFinishedRejection(deps, order)
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
  const recovered = await recoverEmails(deps, { limit: input.limit, now })
  counts.emails += recovered.emails
  counts.errors += recovered.errors
  return counts
}
