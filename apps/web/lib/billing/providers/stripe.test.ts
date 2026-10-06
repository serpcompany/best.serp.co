/**
 * The Stripe provider (#68) on a recorded `fetch`: Checkout Sessions are created form-encoded
 * with the order's reference, amount, card-only payment, expiry, and idempotency key; refunds
 * carry their own key; and webhooks verify the raw body's signature within the timestamp
 * tolerance before anything is read.
 */
import { describe, expect, it } from 'vitest'
import { BillingProviderError, BillingWebhookError } from '../provider'
import { createStripeProvider, stripeSignature, verifyStripeSignature } from './stripe'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const SECRET = 'whsec_unit'

function recorder(responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{
    body: string | null
    headers: Record<string, string>
    method: string
    url: string
  }> = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({
      body: (init.body as string | undefined) ?? null,
      headers: init.headers as Record<string, string>,
      method: init.method ?? 'GET',
      url
    })
    const next = responses.shift() ?? { body: {} }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }) as typeof fetch
  return { calls, fetcher }
}

async function signed(body: string, at = NOW): Promise<Headers> {
  const t = Math.floor(at.getTime() / 1000)
  return new Headers({ 'stripe-signature': `t=${t},v1=${await stripeSignature(SECRET, t, body)}` })
}

describe('Stripe provider', () => {
  it('opens a card-only Checkout Session for the order, under its idempotency key', async () => {
    const { calls, fetcher } = recorder([
      { body: { expires_at: 1791295200, id: 'cs_test_1', url: 'https://checkout.stripe.com/c/1' } }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    const session = await stripe.createCheckout({
      amountCents: 4900,
      cancelUrl: 'https://best.serp.co/submit/s/choose/',
      currency: 'usd',
      customerEmail: 'maya@example.com',
      description: 'Paid listing: Tablesmith',
      expiresAt: new Date('2026-10-06T13:00:00.000Z'),
      idempotencyKey: 'checkout:order-1',
      orderId: 'order-1',
      successUrl: 'https://best.serp.co/submit/s/checkout/success/?order=order-1'
    })
    expect(session).toEqual({
      checkoutId: 'cs_test_1',
      expiresAt: new Date(1791295200 * 1000).toISOString(),
      url: 'https://checkout.stripe.com/c/1'
    })
    const call = calls[0]
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(call?.headers).toMatchObject({
      authorization: 'Bearer sk_test_x',
      'idempotency-key': 'checkout:order-1',
      'stripe-version': '2024-06-20'
    })
    const form = new URLSearchParams(call?.body ?? '')
    expect(Object.fromEntries(form)).toMatchObject({
      client_reference_id: 'order-1',
      expires_at: String(Math.floor(Date.parse('2026-10-06T13:00:00.000Z') / 1000)),
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '4900',
      'metadata[order_id]': 'order-1',
      mode: 'payment',
      'payment_method_types[0]': 'card'
    })
    // Stripe Tax stays off unless the site switches it on.
    expect(form.has('automatic_tax[enabled]')).toBe(false)
  })

  it('reads a session as a provider-neutral state', async () => {
    const { fetcher } = recorder([
      {
        body: {
          amount_total: 4900,
          client_reference_id: 'order-1',
          currency: 'usd',
          id: 'cs_test_1',
          livemode: false,
          payment_intent: 'pi_1',
          payment_status: 'paid',
          status: 'complete'
        }
      }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await expect(stripe.getCheckout('cs_test_1')).resolves.toEqual({
      amountCents: 4900,
      checkoutId: 'cs_test_1',
      currency: 'usd',
      orderId: 'order-1',
      paymentId: 'pi_1',
      state: 'paid'
    })
    await expect(stripe.getCheckout('../v1/customers')).rejects.toBeInstanceOf(BillingProviderError)
  })

  it('refunds under the key, and treats an already refunded charge as refunded', async () => {
    const { calls, fetcher } = recorder([
      { body: { id: 're_1', status: 'succeeded' } },
      { body: { error: { code: 'charge_already_refunded' } }, status: 400 },
      { body: { error: { code: 'resource_missing' } }, status: 404 }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    const request = {
      amountCents: 4900,
      idempotencyKey: 'refund:order-1',
      orderId: 'order-1',
      paymentId: 'pi_1'
    }
    await expect(stripe.refund(request)).resolves.toEqual({ refundId: 're_1' })
    expect(calls[0]?.headers['idempotency-key']).toBe('refund:order-1')
    expect(new URLSearchParams(calls[0]?.body ?? '').get('payment_intent')).toBe('pi_1')
    await expect(stripe.refund(request)).resolves.toEqual({ refundId: null })
    await expect(stripe.refund(request)).rejects.toMatchObject({ code: 'resource_missing' })
  })

  it('verifies the signature over the raw body, within the tolerance', async () => {
    const body = '{"id":"evt_1"}'
    const ok = await signed(body)
    await expect(
      verifyStripeSignature({ body, header: ok.get('stripe-signature'), now: NOW, secret: SECRET })
    ).resolves.toBeUndefined()
    const refused = [
      // Another body, another secret, no signature, a stale or future timestamp.
      { body: '{"id":"evt_2"}', header: ok.get('stripe-signature'), secret: SECRET },
      { body, header: ok.get('stripe-signature'), secret: 'whsec_other' },
      { body, header: null, secret: SECRET },
      { body, header: 't=1,v1=00', secret: SECRET },
      {
        body,
        header: (await signed(body, new Date(NOW.getTime() - 301_000))).get('stripe-signature'),
        secret: SECRET
      },
      {
        body,
        header: (await signed(body, new Date(NOW.getTime() + 301_000))).get('stripe-signature'),
        secret: SECRET
      }
    ]
    for (const input of refused) {
      await expect(verifyStripeSignature({ ...input, now: NOW })).rejects.toBeInstanceOf(
        BillingWebhookError
      )
    }
  })

  it('maps checkout events and ignores everything else', async () => {
    const stripe = createStripeProvider({
      accountId: 'acct_serp',
      live: false,
      now: () => NOW,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    const session = (extra: Record<string, unknown>) => ({
      amount_total: 4900,
      client_reference_id: 'order-1',
      currency: 'usd',
      id: 'cs_1',
      object: 'checkout.session',
      payment_intent: 'pi_1',
      ...extra
    })
    const event = async (type: string, object: unknown, extra: Record<string, unknown> = {}) => {
      const body = JSON.stringify({
        data: { object },
        id: `evt_${type}`,
        livemode: false,
        type,
        ...extra
      })
      return stripe.verifyWebhook({ body, headers: await signed(body) })
    }
    await expect(
      event('checkout.session.completed', session({ payment_status: 'paid', status: 'complete' }))
    ).resolves.toMatchObject({
      checkout: { orderId: 'order-1', state: 'paid' },
      type: 'checkout_paid'
    })
    await expect(
      event('checkout.session.completed', session({ payment_status: 'unpaid', status: 'complete' }))
    ).resolves.toMatchObject({ type: 'checkout_processing' })
    await expect(
      event('checkout.session.expired', session({ payment_status: 'unpaid', status: 'expired' }))
    ).resolves.toMatchObject({ type: 'checkout_expired' })
    await expect(
      event('checkout.session.async_payment_failed', session({ status: 'complete' }))
    ).resolves.toMatchObject({ checkout: { state: 'failed' }, type: 'checkout_failed' })
    // Another mode's or another account's checkout is never acted on.
    const paid = session({ payment_status: 'paid', status: 'complete' })
    await expect(
      event('checkout.session.completed', paid, { livemode: true })
    ).resolves.toMatchObject({ checkout: null, type: 'ignored' })
    await expect(
      event('checkout.session.completed', paid, { account: 'acct_other' })
    ).resolves.toMatchObject({ checkout: null, type: 'ignored' })
    await expect(event('charge.refunded', { id: 'ch_1', object: 'charge' })).resolves.toMatchObject(
      { checkout: null, providerType: 'charge.refunded', type: 'ignored' }
    )
  })

  it('refuses a session of the other mode, and expires open sessions', async () => {
    const { calls, fetcher } = recorder([
      { body: { id: 'cs_test_1', livemode: true, status: 'complete' } },
      { body: { id: 'cs_test_2', status: 'expired' } },
      { body: { error: { code: 'checkout_session_not_open' } }, status: 400 }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await expect(stripe.getCheckout('cs_test_1')).rejects.toMatchObject({ code: 'mode_mismatch' })
    await expect(stripe.expireCheckout('cs_test_2')).resolves.toBe(true)
    await expect(stripe.expireCheckout('cs_test_3')).resolves.toBe(false)
    expect(calls.slice(1).map(call => call.url)).toEqual([
      'https://api.stripe.com/v1/checkout/sessions/cs_test_2/expire',
      'https://api.stripe.com/v1/checkout/sessions/cs_test_3/expire'
    ])
  })
})
