/**
 * The billing provider interface (serpcompany/best.serp.co#68). Stripe implements it today
 * (`stripe.ts`); SERP's self-hosted Lago is the planned replacement. Everything provider-specific
 * (API calls, webhook signatures, event names, ids) stays behind this interface: the billing
 * service, the routes, and D1 only ever see these provider-neutral shapes.
 */

export interface CheckoutRequest {
  amountCents: number
  /** Where the provider sends the buyer when they leave checkout without paying. */
  cancelUrl: string
  /** Lowercase ISO 4217, e.g. `usd`. */
  currency: string
  customerEmail: string
  /** The item's name on the provider's checkout page. */
  description: string
  /** When the checkout stops accepting payment (the provider may round it). */
  expiresAt: Date
  /** The provider's idempotency key: retrying the same order never opens a second checkout. */
  idempotencyKey: string
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
  amountCents: number | null
  checkoutId: string
  currency: string | null
  /** The order id the checkout was opened for (from its reference), if the provider echoes it. */
  orderId: string | null
  paymentId: string | null
  state: 'expired' | 'failed' | 'open' | 'paid' | 'processing'
}

/**
 * A verified webhook event. `checkout` is set for the checkout events the service acts on; any
 * other event is recorded as `ignored`.
 */
export interface BillingEvent {
  checkout: CheckoutState | null
  id: string
  /** The provider's own event type, recorded in `billing_events`. */
  providerType: string
  type: 'checkout_expired' | 'checkout_failed' | 'checkout_paid' | 'checkout_processing' | 'ignored'
}

export interface RefundRequest {
  amountCents: number
  /** The provider's idempotency key: a retried refund never refunds twice. */
  idempotencyKey: string
  orderId: string
  paymentId: string
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
