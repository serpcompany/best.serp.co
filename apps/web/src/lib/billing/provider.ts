/**
 * The billing provider interface (serpcompany/best.serp.co#68). The providers in `providers/`
 * implement it; SERP's self-hosted Lago is the planned replacement. Everything provider-specific
 * (API calls, webhook signatures, event names, ids, its name) stays behind this interface: the
 * billing service, the routes, D1, and everything people see only ever use these
 * provider-neutral shapes.
 */

export interface CheckoutRequest {
  /**
   * The order's price. The provider charges its own catalog price for `kind` and refuses (503)
   * when that price differs from this, so the site's price and the charge can't drift apart.
   */
  amountCents: number
  /** Where the provider sends the buyer when they leave checkout without paying. */
  cancelUrl: string
  /** Lowercase ISO 4217, e.g. `usd`. */
  currency: string
  customerEmail: string
  /**
   * The order's neutral description (`Paid listing: <name>`), on the provider's record of the
   * payment. The checkout page shows the catalog product's own name.
   */
  description: string
  /** When the checkout stops accepting payment (the provider may round it). */
  expiresAt: Date
  /** The provider's idempotency key: retrying the same order never opens a second checkout. */
  idempotencyKey: string
  /** What is sold: picks the provider's catalog price. */
  kind: 'paid_claim' | 'paid_listing'
  orderId: string
  /** Where the provider sends the buyer after paying. */
  successUrl: string
}

export interface CheckoutSession {
  checkoutId: string
  expiresAt: string
  url: string
}

/**
 * A checkout as the provider reports it. `paid`: the payment succeeded; `processing`: completed
 * but not paid yet (a delayed payment method); `open`: the buyer can still pay; `expired`: it
 * can no longer be paid; `failed`: the payment failed.
 */
export interface CheckoutState {
  /** What the buyer was charged: the price less any discount (0 for a 100%-off code). */
  amountCents: number | null
  checkoutId: string
  currency: string | null
  /** The discount a promotion code took off the price, in cents (0 without one). */
  discountCents: number | null
  /** The order id the checkout was opened for (from its reference), if the provider echoes it. */
  orderId: string | null
  paymentId: string | null
  state: 'expired' | 'failed' | 'open' | 'paid' | 'processing'
  /** The price before any discount. */
  subtotalCents: number | null
}

/**
 * A change to a payment that can happen outside the site (#473): a refund (from the provider's
 * dashboard, or the site's own), a refund that failed after it was accepted, or a dispute the
 * buyer opened with their bank, and its outcome.
 */
export interface PaymentChange {
  /**
   * What the payment charged and in which currency, when the event carries it (a refund's), so a
   * payment the site hasn't recorded yet can be (#484).
   */
  amountCents?: number | null
  currency?: string | null
  /** A closed dispute: the payment stands (`won`), or the money went back to the buyer (`lost`). */
  disputeOutcome: 'lost' | 'won' | null
  /**
   * The order the payment names (the order id the checkout put on it), when the event carries
   * it: it finds a payment the site hasn't recorded yet (#484).
   */
  orderId?: string | null
  /** A refund of only part of the payment. */
  partial: boolean
  /** The provider's payment reference, as the order recorded it (`orders.provider_payment_id`). */
  paymentId: string
  /** How much of the payment is refunded so far, in all (a refund's). */
  refundedCents?: number | null
  /**
   * The refund a failed refund's report is about, when the provider reports it: compared with the
   * refund the order recorded (`orders.provider_refund_id`), so an earlier one's failure, reported
   * after a newer refund succeeded, flags nothing (#485).
   */
  refundId?: string | null
  /**
   * The idempotency key of the request that made the change, when the provider reports it: the
   * site's own refund carries its `refund:<order>` (#484).
   */
  requestKey?: string | null
}

/**
 * A verified webhook event. `checkout` is set for the checkout events the service acts on, and
 * `payment` for the payment events (refunds and disputes, #473); any other event is recorded as
 * `ignored`.
 */
export interface BillingEvent {
  checkout: CheckoutState | null
  id: string
  payment?: PaymentChange | null
  /** The provider's own event type, recorded in `billing_events`. */
  providerType: string
  type:
    | 'checkout_expired'
    | 'checkout_failed'
    | 'checkout_paid'
    | 'checkout_processing'
    | 'dispute_closed'
    | 'ignored'
    | 'payment_disputed'
    | 'payment_refund_failed'
    | 'payment_refunded'
}

export interface RefundRequest {
  amountCents: number
  /** The provider's idempotency key: a retried refund never refunds twice. */
  idempotencyKey: string
  orderId: string
  paymentId: string
}

/**
 * A refund of a payment as the provider records it now (#486). A `pending` or `succeeded` refund
 * sends the money back; a `failed` or `canceled` one never will.
 */
export interface ProviderRefund {
  amountCents: number
  id: string
  /** The order the site's own refund named (`RefundRequest.orderId`); null outside the site. */
  orderId: string | null
  status: 'canceled' | 'failed' | 'pending' | 'succeeded'
}

export interface BillingProvider {
  /** Stored in `orders.provider` and `billing_events.provider`. */
  readonly name: string
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>
  /** The provider's dashboard page for a payment or checkout id, for the admin Orders menu. */
  dashboardUrl(reference: string): string | null
  /**
   * Stops a checkout from accepting payment (a superseded one). True when the provider expired
   * it; false when it was already closed (it may have been paid).
   */
  expireCheckout(checkoutId: string): Promise<boolean>
  getCheckout(checkoutId: string): Promise<CheckoutState>
  /**
   * The checkout that took a payment, by the payment's reference, or null when none did (a charge
   * made outside checkout). It finds the order of a dispute reported before the site recorded its
   * payment, which names no order itself (#484).
   */
  checkoutForPayment(paymentId: string): Promise<CheckoutState | null>
  /**
   * The payment's refunds as the provider records them now, newest first (#486): which refund
   * sent the money back, and whether any still does, whatever order their events arrive in.
   */
  paymentRefunds(paymentId: string): Promise<ProviderRefund[]>
  /** The provider's refund id, or null when the payment had already been refunded. */
  refund(request: RefundRequest): Promise<{ refundId: string | null }>
  /**
   * Verifies the signature (raw body, timestamp tolerance) and reads the event. An event from
   * another mode (test vs live) or account than this Worker's is answered as `ignored`.
   */
  verifyWebhook(input: { body: string; headers: Headers }): Promise<BillingEvent>
}

/** A provider call that failed: the service turns it into a 503 or a retry, never a 500. */
export class BillingProviderError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'BillingProviderError'
    this.code = code
    this.status = status
  }
}

/** A webhook whose signature, timestamp, or body is not acceptable: answered 400. */
export class BillingWebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingWebhookError'
  }
}
