/**
 * The Stripe provider (#68) on a recorded `fetch`: Checkout Sessions are created form-encoded
 * with the order's reference, catalog price (#250), card-only payment, expiry, and idempotency
 * key, and refused when that price isn't the site's; refunds
 * carry their own key; webhooks verify the raw body's signature within the timestamp
 * tolerance before anything is read; and no URL the provider builds or hands back carries its
 * key, its webhook secret, a client secret, or a signature (#469).
 */
import { describe, expect, it } from 'vitest'
import { BillingProviderError, BillingWebhookError } from '../provider'
import {
  createStripeProvider,
  STRIPE_REFUND_PAGES,
  stripeCheckoutState,
  stripeSignature,
  verifyStripeSignature
} from './stripe'
import { providerSecretsIn } from './test-support'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const SECRET = 'whsec_unit'
const PRICES = { paid_claim: 'price_claim', paid_listing: 'price_listing' }

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
  const checkoutRequest = {
    amountCents: 4900,
    cancelUrl: 'https://best.serp.co/submit/s/choose/',
    currency: 'usd',
    customerEmail: 'maya@example.com',
    description: 'Paid listing: Tablesmith',
    expiresAt: new Date('2026-10-06T13:00:00.000Z'),
    idempotencyKey: 'checkout:order-1',
    kind: 'paid_listing' as const,
    orderId: 'order-1',
    successUrl: 'https://best.serp.co/submit/s/checkout/success/?order=order-1'
  }

  it('opens a card-only Checkout Session for the catalog price, with promotion codes (#250)', async () => {
    const { calls, fetcher } = recorder([
      {
        body: {
          amount_subtotal: 4900,
          currency: 'usd',
          expires_at: 1791295200,
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/1'
        }
      }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    const session = await stripe.createCheckout(checkoutRequest)
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
      allow_promotion_codes: 'true',
      client_reference_id: 'order-1',
      expires_at: String(Math.floor(Date.parse('2026-10-06T13:00:00.000Z') / 1000)),
      'line_items[0][price]': 'price_listing',
      'metadata[order_id]': 'order-1',
      mode: 'payment',
      'payment_intent_data[description]': 'Paid listing: Tablesmith',
      'payment_method_types[0]': 'card'
    })
    // The catalog price, never an inline one.
    expect([...form.keys()].some(key => key.includes('price_data'))).toBe(false)
    // Stripe Tax stays off.
    expect(form.has('automatic_tax[enabled]')).toBe(false)
    // Nothing sent names the provider (owner decision on #70).
    for (const [key, value] of form) expect(`${key}=${value}`).not.toMatch(/stripe/iu)
  })

  it('sells the claim price for a paid claim', async () => {
    const { calls, fetcher } = recorder([
      { body: { amount_subtotal: 4900, currency: 'usd', id: 'cs_test_2', url: 'https://c/2' } }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await stripe.createCheckout({ ...checkoutRequest, kind: 'paid_claim' })
    expect(new URLSearchParams(calls[0]?.body ?? '').get('line_items[0][price]')).toBe(
      'price_claim'
    )
  })

  it('refuses and expires a checkout whose catalog price is not the site price', async () => {
    for (const changed of [
      { amount_subtotal: 9900, currency: 'usd' },
      { amount_subtotal: 4900, currency: 'eur' }
    ]) {
      const { calls, fetcher } = recorder([
        { body: { ...changed, id: 'cs_test_3', url: 'https://c/3' } },
        { body: { id: 'cs_test_3', status: 'expired' } }
      ])
      const stripe = createStripeProvider({
        fetcher,
        live: false,
        prices: PRICES,
        secretKey: 'sk_test_x',
        webhookSecret: SECRET
      })
      await expect(stripe.createCheckout(checkoutRequest)).rejects.toMatchObject({
        code: 'price_mismatch',
        status: 503
      })
      expect(calls[1]?.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_3/expire')
    }
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
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await expect(stripe.getCheckout('cs_test_1')).resolves.toEqual({
      amountCents: 4900,
      checkoutId: 'cs_test_1',
      currency: 'usd',
      discountCents: 0,
      orderId: 'order-1',
      paymentId: 'pi_1',
      state: 'paid',
      subtotalCents: null
    })
    await expect(stripe.getCheckout('../v1/customers')).rejects.toBeInstanceOf(BillingProviderError)
  })

  it('finds the checkout that took a payment, for a dispute that names no order (#484)', async () => {
    const session = {
      amount_total: 4900,
      client_reference_id: 'order-1',
      currency: 'usd',
      id: 'cs_test_1',
      livemode: false,
      payment_intent: 'pi_1',
      payment_status: 'paid',
      status: 'complete'
    }
    const { calls, fetcher } = recorder([
      { body: { data: [session], object: 'list' } },
      { body: { data: [], object: 'list' } },
      { body: { data: [{ ...session, livemode: true }], object: 'list' } }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await expect(stripe.checkoutForPayment('pi_1')).resolves.toMatchObject({
      checkoutId: 'cs_test_1',
      orderId: 'order-1',
      paymentId: 'pi_1',
      state: 'paid'
    })
    // The Checkout Sessions read `getCheckout` makes, filtered by the PaymentIntent.
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.stripe.com/v1/checkout/sessions?limit=1&payment_intent=pi_1'
    })
    await expect(stripe.checkoutForPayment('pi_2')).resolves.toBeNull()
    // Another mode's session is never this Worker's.
    await expect(stripe.checkoutForPayment('pi_1')).resolves.toBeNull()
    // Anything but a PaymentIntent id is never sent.
    await expect(stripe.checkoutForPayment('../v1/customers')).resolves.toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('reads a promotion code’s discount, and a 100%-off checkout as paid with no payment', () => {
    expect(
      stripeCheckoutState({
        amount_subtotal: 4900,
        amount_total: 2450,
        currency: 'usd',
        id: 'cs_1',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        status: 'complete',
        total_details: { amount_discount: 2450, amount_tax: 0 }
      })
    ).toMatchObject({ amountCents: 2450, discountCents: 2450, state: 'paid', subtotalCents: 4900 })
    expect(
      stripeCheckoutState({
        amount_subtotal: 4900,
        amount_total: 0,
        currency: 'usd',
        id: 'cs_2',
        payment_intent: null,
        payment_status: 'no_payment_required',
        status: 'complete',
        total_details: { amount_discount: 4900, amount_tax: 0 }
      })
    ).toMatchObject({ amountCents: 0, discountCents: 4900, paymentId: null, state: 'paid' })
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
      prices: PRICES,
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

  it('reads a payment’s refunds, the site’s by the order they name (#486)', async () => {
    const { calls, fetcher } = recorder([
      {
        body: {
          data: [
            { amount: 4900, id: 're_dashboard', metadata: {}, status: 'requires_action' },
            { amount: 4900, id: 're_site', metadata: { order_id: 'order-1' }, status: 'failed' },
            { amount: 1000, id: 're_part', status: 'canceled' },
            { id: 're_no_amount', status: 'succeeded' }
          ],
          object: 'list'
        }
      },
      { body: { error: { type: 'api_error' } }, status: 503 }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    await expect(stripe.paymentRefunds('pi_1')).resolves.toEqual([
      // One that still needs the buyer's action may yet send the money back.
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'pending' },
      { amountCents: 4900, id: 're_site', orderId: 'order-1', status: 'failed' },
      { amountCents: 1000, id: 're_part', orderId: null, status: 'canceled' }
    ])
    // The Refunds read, filtered by the PaymentIntent.
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.stripe.com/v1/refunds?limit=100&payment_intent=pi_1'
    })
    // Stripe down: the provider's error, so the webhook answers 500 and is delivered again.
    await expect(stripe.paymentRefunds('pi_1')).rejects.toBeInstanceOf(BillingProviderError)
    // Anything but a PaymentIntent id is never sent, and is an error, never "no refunds".
    await expect(stripe.paymentRefunds('cs_test_1')).rejects.toMatchObject({
      code: 'invalid_payment',
      name: 'BillingProviderError'
    })
    expect(calls).toHaveLength(2)
  })

  // Codex on #498: Stripe lists 100 refunds a page, newest first. A payment refunded in more
  // parts than that is read to its last page, so the service's total is the whole record.
  it('reads every page of a payment’s refunds, older ones after the last it read (#486)', async () => {
    const newest = Array.from({ length: 100 }, (_, index) => ({
      amount: 45,
      id: `re_part_${index}`,
      status: 'succeeded'
    }))
    const { calls, fetcher } = recorder([
      { body: { data: newest, has_more: true, object: 'list' } },
      {
        body: {
          data: [
            { amount: 400, id: 're_older', status: 'succeeded' },
            { amount: 4900, id: 're_site', metadata: { order_id: 'order-1' }, status: 'failed' }
          ],
          has_more: false,
          object: 'list'
        }
      }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    })
    const refunds = await stripe.paymentRefunds('pi_1')
    expect(refunds).toHaveLength(102)
    expect(refunds.at(-1)).toEqual({
      amountCents: 4900,
      id: 're_site',
      orderId: 'order-1',
      status: 'failed'
    })
    // 100 × 45 on the first page and 400 on the second: all 4,900 of the charge went back.
    const sent = refunds
      .filter(refund => refund.status === 'succeeded')
      .reduce((sum, refund) => sum + refund.amountCents, 0)
    expect(sent).toBe(4900)
    expect(calls.map(call => call.url)).toEqual([
      'https://api.stripe.com/v1/refunds?limit=100&payment_intent=pi_1',
      'https://api.stripe.com/v1/refunds?limit=100&payment_intent=pi_1&starting_after=re_part_99'
    ])
  })

  // More pages than it reads, or a page with no last id to read on from: an error, as when
  // Stripe is down, so the service falls back and the webhook is delivered again, never a short
  // total read as a partial refund.
  it('answers a refund list it can’t read to the end as an error, never a short list (#486)', async () => {
    const endless = recorder(
      Array.from({ length: STRIPE_REFUND_PAGES + 1 }, (_, page) => ({
        body: {
          data: [{ amount: 1, id: `re_page_${page}`, status: 'succeeded' }],
          has_more: true,
          object: 'list'
        }
      }))
    )
    const config = {
      live: false,
      prices: PRICES,
      secretKey: 'sk_test_x',
      webhookSecret: SECRET
    }
    await expect(
      createStripeProvider({ ...config, fetcher: endless.fetcher }).paymentRefunds('pi_1')
    ).rejects.toMatchObject({ code: 'refunds_incomplete', status: 502 })
    expect(endless.calls).toHaveLength(STRIPE_REFUND_PAGES)
    expect(endless.calls.at(-1)?.url).toContain(`starting_after=re_page_${STRIPE_REFUND_PAGES - 2}`)
    const stuck = recorder([{ body: { data: [], has_more: true, object: 'list' } }])
    await expect(
      createStripeProvider({ ...config, fetcher: stuck.fetcher }).paymentRefunds('pi_1')
    ).rejects.toMatchObject({ code: 'refunds_incomplete' })
    expect(stuck.calls).toHaveLength(1)
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
      prices: PRICES,
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
      prices: PRICES,
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

describe('provider secrets in URLs (#469)', () => {
  const KEY = 'sk_test_469key'
  const WEBHOOK_SECRET = 'whsec_469secret'
  // A configured value with no recognisable shape: found because a test named it.
  const OPAQUE = 'opaque-469-value'
  const KNOWN = [KEY, WEBHOOK_SECRET, OPAQUE]
  const RETURN_URL =
    'https://best.serp.co/submit/11111111-1111-4111-8111-111111111111/checkout/return/?order=22222222-2222-4222-8222-222222222222'

  it('finds each kind of provider secret anywhere in a URL, as written or encoded', async () => {
    const at = Math.floor(NOW.getTime() / 1000)
    const signature = `t=${at},v1=${await stripeSignature(WEBHOOK_SECRET, at, '{}')}`
    const leaks: Record<string, string> = {
      'a configured secret, encoded': `${RETURN_URL}&x=${encodeURIComponent(OPAQUE)}`,
      'a live secret key in the path': 'https://best.serp.co/r/sk_live_abc123/',
      'a restricted key in the query': `${RETURN_URL}&k=rk_test_abc123`,
      'a webhook secret in the fragment': 'https://best.serp.co/products/example.com/#whsec_abc123',
      'an ephemeral key': `${RETURN_URL}&e=ek_test_abc123`,
      'a client secret': `${RETURN_URL}&c=cs_test_a1b2_secret_c3d4`,
      'a client_secret parameter': `${RETURN_URL}&client_secret=anything`,
      'a session token parameter': 'https://best.serp.co/thanks/?customer_session_token=abc',
      'a signature, encoded': `${RETURN_URL}&s=${encodeURIComponent(signature)}`,
      'a signature, encoded twice': `${RETURN_URL}&s=${encodeURIComponent(encodeURIComponent(signature))}`,
      'a signature parameter': `${RETURN_URL}&signature=abc`,
      'an api key parameter': `${RETURN_URL}&apiKey=abc`,
      'a clientSecret parameter': `${RETURN_URL}&clientSecret=abc`,
      'a webhookSecret parameter': `${RETURN_URL}&webhookSecret=abc`,
      'a secretKey parameter': `${RETURN_URL}&secretKey=abc`,
      'a sessionToken parameter': `${RETURN_URL}&sessionToken=abc`,
      'an accessToken parameter': 'https://best.serp.co/thanks/?accessToken=abc',
      'the configured key': `https://best.serp.co/?k=${KEY}`,
      // A Checkout Session id belongs only on the provider's own hosts.
      'a session id on a site return URL': `${RETURN_URL}&session_id=cs_live_a1B2c3`,
      'a session id in a site path': 'https://best.serp.co/thanks/cs_test_a1B2c3/',
      'a session id in a sign-in return, encoded': `/login/?callbackUrl=${encodeURIComponent('/thanks/?session_id=cs_test_a1B2c3')}`,
      'a session id on a lookalike host':
        'https://checkout.stripe.com.evil.example/c/pay/cs_test_a1B2c3'
    }
    for (const [name, url] of Object.entries(leaks)) {
      expect(providerSecretsIn(url, KNOWN), name).not.toEqual([])
    }
    const clean = [
      RETURN_URL,
      'https://best.serp.co/account/listings/example.com/',
      'https://best.serp.co/products/example.com/#claim',
      `/login/?callbackUrl=${encodeURIComponent(new URL(RETURN_URL).pathname + new URL(RETURN_URL).search)}`,
      // Parameters the site uses.
      'https://best.serp.co/products/?q=crm&category=a&page=2&sort=name&tab=b&view=c&ref=d&utm_source=e&next=f',
      // Public identifiers: a Checkout Session id on the provider's own hosts (API, checkout
      // page, dashboard), a payment id in the admin's dashboard link, and a publishable key.
      'https://api.stripe.com/v1/checkout/sessions/cs_live_a1B2c3/expire',
      'https://checkout.stripe.com/c/pay/cs_test_a1B2c3',
      'https://dashboard.stripe.com/test/checkout/sessions/cs_test_a1B2c3',
      'https://dashboard.stripe.com/test/payments/pi_3Abc',
      'https://best.serp.co/?pk=pk_live_abc123'
    ]
    for (const url of clean) expect(providerSecretsIn(url, KNOWN), url).toEqual([])
  })

  it('builds no URL that carries its key, its webhook secret, a client secret or a signature', async () => {
    const at = Math.floor(NOW.getTime() / 1000)
    const signature = await stripeSignature(WEBHOOK_SECRET, at, '{}')
    // Stripe answers with a client secret on a session; it must never reach a URL either.
    const clientSecret = 'cs_test_469_secret_abc123'
    const { calls, fetcher } = recorder([
      {
        body: {
          amount_subtotal: 4900,
          client_secret: clientSecret,
          currency: 'usd',
          expires_at: 1791295200,
          id: 'cs_test_469',
          url: 'https://checkout.stripe.com/c/pay/cs_test_469'
        }
      },
      { body: { client_secret: clientSecret, id: 'cs_test_469', livemode: false, status: 'open' } },
      { body: { id: 'cs_test_469', status: 'expired' } },
      { body: { id: 're_469', status: 'succeeded' } },
      {
        body: {
          data: [{ client_secret: clientSecret, id: 'cs_test_469', livemode: false }],
          object: 'list'
        }
      }
    ])
    const stripe = createStripeProvider({
      fetcher,
      live: false,
      prices: PRICES,
      secretKey: KEY,
      webhookSecret: WEBHOOK_SECRET
    })
    const request = {
      amountCents: 4900,
      cancelUrl: 'https://best.serp.co/submit/s/checkout/cancelled/',
      currency: 'usd',
      customerEmail: 'maya@example.com',
      description: 'Paid listing: Tablesmith',
      expiresAt: new Date('2026-10-06T13:00:00.000Z'),
      idempotencyKey: 'checkout:order-1',
      kind: 'paid_listing' as const,
      orderId: 'order-1',
      successUrl: 'https://best.serp.co/submit/s/checkout/return/?order=order-1'
    }
    const session = await stripe.createCheckout(request)
    await stripe.getCheckout('cs_test_469')
    await stripe.expireCheckout('cs_test_469')
    await stripe.refund({
      amountCents: 4900,
      idempotencyKey: 'refund:order-1',
      orderId: 'order-1',
      paymentId: 'pi_469'
    })
    await stripe.checkoutForPayment('pi_469')
    const form = new URLSearchParams(calls[0]?.body ?? '')
    // The return URLs go to the provider exactly as the site built them, with nothing added.
    expect(form.get('success_url')).toBe(request.successUrl)
    expect(form.get('cancel_url')).toBe(request.cancelUrl)
    // The buyer goes to the provider's own checkout page, as the provider gave it.
    expect(session.url).toBe('https://checkout.stripe.com/c/pay/cs_test_469')
    const urls = [
      ...calls.map(call => call.url),
      form.get('success_url') ?? '',
      form.get('cancel_url') ?? '',
      session.url,
      stripe.dashboardUrl('pi_469') ?? '',
      stripe.dashboardUrl('cs_test_469') ?? ''
    ]
    expect(calls).toHaveLength(5)
    for (const url of urls) {
      expect(providerSecretsIn(url, [...KNOWN, clientSecret, signature]), url).toEqual([])
    }
    // The key travels only in the authorization header.
    for (const call of calls) expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
  })
})
