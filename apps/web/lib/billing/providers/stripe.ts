import {
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookError,
  type CheckoutState
} from '../provider'

/**
 * Stripe Checkout behind the billing interface (serpcompany/best.serp.co#68), on the Worker's
 * `fetch` and Web Crypto: no Node SDK. Stripe account `acct_1RiT0QCp8si97z5s`, test mode on
 * staging and live mode in production; the keys are the Worker secrets `STRIPE_SECRET_KEY` and
 * `STRIPE_WEBHOOK_SECRET`, which only the owner sets. This is the only file that knows Stripe's
 * API, event names, or signature scheme.
 */

export const STRIPE_API_BASE = 'https://api.stripe.com'
/** The API version every request pins, so a dashboard upgrade never changes these shapes. */
export const STRIPE_API_VERSION = '2024-06-20'
/** Stripe's own default tolerance for a webhook's signed timestamp. */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300

export interface StripeConfig {
  /** `https://api.stripe.com`; a local Worker may point it at the end-to-end mock. */
  apiBase?: string
  /**
   * The Stripe account events must come from (`acct_1RiT0QCp8si97z5s`): an event that names
   * another account is ignored.
   */
  accountId?: string
  fetcher?: typeof fetch
  /** Live mode (production) or test mode: an event or session of the other mode is refused. */
  live: boolean
  now?: () => Date
  secretKey: string
  webhookSecret: string
}

type StripeObject = Record<string, unknown>

function form(values: Record<string, string | number | boolean | undefined>): string {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.append(key, String(value))
  }
  return body.toString()
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  if (value && typeof value === 'object' && 'id' in value) return text(value.id)
  return null
}

/** A Checkout Session as the provider-neutral state. */
export function stripeCheckoutState(session: StripeObject): CheckoutState {
  const status = session.status
  const paymentStatus = session.payment_status
  const metadata = (session.metadata ?? {}) as Record<string, unknown>
  const state: CheckoutState['state'] =
    status === 'expired'
      ? 'expired'
      : status === 'complete'
        ? paymentStatus === 'paid'
          ? 'paid'
          : 'processing'
        : 'open'
  return {
    amountCents: typeof session.amount_total === 'number' ? session.amount_total : null,
    checkoutId: String(session.id ?? ''),
    currency: text(session.currency),
    orderId: text(session.client_reference_id) ?? text(metadata.order_id),
    paymentId: idOf(session.payment_intent),
    state
  }
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

/** Compares two strings in time that depends only on their length. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/** Stripe's v1 signature: HMAC-SHA256 of `<timestamp>.<raw body>` with the endpoint secret. */
export async function stripeSignature(
  secret: string,
  timestamp: number,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
  return hex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
  )
}

/**
 * Verifies a `Stripe-Signature` header against the raw body: some `v1` must match, and its
 * timestamp must be within the tolerance of now (both ways), so a captured request cannot be
 * replayed later. Throws `BillingWebhookError`.
 */
export async function verifyStripeSignature(input: {
  body: string
  header: string | null
  now: Date
  secret: string
  toleranceSeconds?: number
}): Promise<void> {
  if (!input.header) throw new BillingWebhookError('Missing signature.')
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of input.header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't' && value && /^\d+$/u.test(value)) timestamp = Number(value)
    if (key === 'v1' && value) signatures.push(value)
  }
  if (timestamp === null || signatures.length === 0) {
    throw new BillingWebhookError('Malformed signature.')
  }
  const tolerance = input.toleranceSeconds ?? STRIPE_WEBHOOK_TOLERANCE_SECONDS
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - timestamp) > tolerance) {
    throw new BillingWebhookError('Signature timestamp is outside the tolerance.')
  }
  const expected = await stripeSignature(input.secret, timestamp, input.body)
  if (!signatures.some(signature => constantTimeEqual(signature, expected))) {
    throw new BillingWebhookError('Signature mismatch.')
  }
}

const CHECKOUT_EVENTS: Readonly<Record<string, BillingEvent['type']>> = {
  'checkout.session.async_payment_failed': 'checkout_failed',
  'checkout.session.async_payment_succeeded': 'checkout_paid',
  'checkout.session.completed': 'checkout_paid',
  'checkout.session.expired': 'checkout_expired'
}

export function createStripeProvider(config: StripeConfig): BillingProvider {
  const apiBase = (config.apiBase ?? STRIPE_API_BASE).replace(/\/+$/u, '')
  const fetcher = config.fetcher ?? fetch
  const now = config.now ?? (() => new Date())

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    idempotencyKey?: string
  ): Promise<StripeObject> {
    let response: Response
    try {
      response = await fetcher(`${apiBase}${path}`, {
        body,
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        method,
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      throw new BillingProviderError('Stripe is unreachable.', 'provider_unreachable', 503)
    }
    const data = (await response.json().catch(() => null)) as StripeObject | null
    if (!response.ok || !data) {
      const error = (data?.error ?? {}) as Record<string, unknown>
      throw new BillingProviderError(
        `Stripe answered ${response.status}.`,
        text(error.code) ?? text(error.type) ?? 'provider_error',
        response.status
      )
    }
    return data
  }

  return {
    name: 'stripe',

    async createCheckout(request) {
      const session = await call(
        'POST',
        '/v1/checkout/sessions',
        form({
          cancel_url: request.cancelUrl,
          client_reference_id: request.orderId,
          customer_email: request.customerEmail,
          expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          'line_items[0][price_data][currency]': request.currency,
          'line_items[0][price_data][product_data][name]': request.description,
          'line_items[0][price_data][unit_amount]': request.amountCents,
          'line_items[0][quantity]': 1,
          'metadata[order_id]': request.orderId,
          mode: 'payment',
          'payment_intent_data[metadata][order_id]': request.orderId,
          // Stripe emails the receipt (#70 screen 4: "Emailed to … by Stripe").
          'payment_intent_data[receipt_email]': request.customerEmail,
          // Cards only: a paid listing goes live at payment, so no delayed payment methods.
          'payment_method_types[0]': 'card',
          success_url: request.successUrl
        }),
        request.idempotencyKey
      )
      const url = text(session.url)
      const checkoutId = text(session.id)
      if (!url || !checkoutId) {
        throw new BillingProviderError('Stripe returned no checkout URL.', 'provider_error', 502)
      }
      const expires = typeof session.expires_at === 'number' ? session.expires_at * 1000 : null
      return {
        checkoutId,
        expiresAt: new Date(expires ?? request.expiresAt.getTime()).toISOString(),
        url
      }
    },

    async getCheckout(checkoutId) {
      if (!/^cs_[A-Za-z0-9_]+$/u.test(checkoutId)) {
        throw new BillingProviderError('Not a Checkout Session id.', 'invalid_checkout', 400)
      }
      const session = await call('GET', `/v1/checkout/sessions/${checkoutId}`)
      if (session.livemode !== config.live) {
        throw new BillingProviderError('The session is from the other mode.', 'mode_mismatch', 409)
      }
      return stripeCheckoutState(session)
    },

    dashboardUrl(reference) {
      const mode = config.live ? '' : '/test'
      if (/^pi_[A-Za-z0-9_]+$/u.test(reference)) {
        return `https://dashboard.stripe.com${mode}/payments/${reference}`
      }
      if (/^cs_[A-Za-z0-9_]+$/u.test(reference)) {
        return `https://dashboard.stripe.com${mode}/checkout/sessions/${reference}`
      }
      return null
    },

    async expireCheckout(checkoutId) {
      if (!/^cs_[A-Za-z0-9_]+$/u.test(checkoutId)) return false
      try {
        await call('POST', `/v1/checkout/sessions/${checkoutId}/expire`, form({}))
        return true
      } catch (error) {
        // Already complete or expired: nothing left to stop, but it may have been paid.
        if (error instanceof BillingProviderError && error.status === 400) return false
        throw error
      }
    },

    async refund(request) {
      try {
        const refund = await call(
          'POST',
          '/v1/refunds',
          form({
            amount: request.amountCents,
            'metadata[order_id]': request.orderId,
            payment_intent: request.paymentId
          }),
          request.idempotencyKey
        )
        if (refund.status === 'failed' || refund.status === 'canceled') {
          throw new BillingProviderError('Stripe could not refund it.', 'refund_failed', 502)
        }
        return { refundId: text(refund.id) }
      } catch (error) {
        // Refunded already (by an earlier attempt whose idempotency key has expired).
        if (error instanceof BillingProviderError && error.code === 'charge_already_refunded') {
          return { refundId: null }
        }
        throw error
      }
    },

    async verifyWebhook({ body, headers }) {
      await verifyStripeSignature({
        body,
        header: headers.get('stripe-signature'),
        now: now(),
        secret: config.webhookSecret
      })
      let event: StripeObject
      try {
        event = JSON.parse(body) as StripeObject
      } catch {
        throw new BillingWebhookError('The event is not JSON.')
      }
      const id = text(event.id)
      const providerType = text(event.type)
      if (!id || !providerType) throw new BillingWebhookError('The event has no id or type.')
      // Another mode's or account's event is never acted on, whatever it names.
      const foreign =
        event.livemode !== config.live ||
        (typeof event.account === 'string' && event.account !== config.accountId)
      const type = foreign ? 'ignored' : (CHECKOUT_EVENTS[providerType] ?? 'ignored')
      const object = ((event.data as StripeObject | undefined)?.object ??
        null) as StripeObject | null
      if (type === 'ignored' || !object || object.object !== 'checkout.session') {
        return { checkout: null, id, providerType, type: 'ignored' }
      }
      const checkout = stripeCheckoutState(object)
      // `completed` with an unpaid status is a delayed payment: wait for its own event.
      const settled =
        type === 'checkout_paid' && checkout.state !== 'paid'
          ? 'checkout_processing'
          : type === 'checkout_failed'
            ? 'checkout_failed'
            : type
      return {
        checkout: settled === 'checkout_failed' ? { ...checkout, state: 'failed' } : checkout,
        id,
        providerType,
        type: settled
      }
    }
  }
}
