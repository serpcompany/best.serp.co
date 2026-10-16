/**
 * The Stripe provider's payment events (#473): refunds and disputes, made in the dashboard or by
 * the buyer's bank, verified like every event and found by their PaymentIntent.
 */

import { describe, expect, it } from 'vitest'
import { createStripeProvider, stripeSignature } from './stripe'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const SECRET = 'whsec_test_events'

const stripe = createStripeProvider({
  accountId: 'acct_serp',
  live: false,
  now: () => NOW,
  prices: { paid_claim: 'price_claim', paid_listing: 'price_listing' },
  secretKey: 'sk_test_x',
  webhookSecret: SECRET
})

async function event(type: string, object: Record<string, unknown>, extra = {}) {
  const body = JSON.stringify({
    data: { object },
    id: `evt_${type}`,
    livemode: false,
    type,
    ...extra
  })
  const timestamp = Math.floor(NOW.getTime() / 1000)
  const signature = await stripeSignature(SECRET, timestamp, body)
  return stripe.verifyWebhook({
    body,
    headers: new Headers({ 'stripe-signature': `t=${timestamp},v1=${signature}` })
  })
}

const charge = (extra: Record<string, unknown>) => ({
  amount: 4900,
  amount_refunded: 4900,
  currency: 'usd',
  id: 'ch_1',
  object: 'charge',
  payment_intent: 'pi_1',
  refunded: true,
  ...extra
})
const dispute = (extra: Record<string, unknown>) => ({
  charge: 'ch_1',
  id: 'dp_1',
  object: 'dispute',
  payment_intent: 'pi_1',
  status: 'needs_response',
  ...extra
})

describe('Stripe payment events (#473)', () => {
  it('maps a full or partial refund, a failed refund, and a dispute to the payment', async () => {
    await expect(event('charge.refunded', charge({}))).resolves.toEqual({
      checkout: null,
      id: 'evt_charge.refunded',
      payment: {
        amountCents: 4900,
        currency: 'usd',
        disputeOutcome: null,
        orderId: null,
        partial: false,
        paymentId: 'pi_1',
        refundedCents: 4900,
        requestKey: null
      },
      providerType: 'charge.refunded',
      type: 'payment_refunded'
    })
    await expect(
      event('charge.refunded', charge({ amount_refunded: 1000, refunded: false }))
    ).resolves.toMatchObject({ payment: { partial: true }, type: 'payment_refunded' })
    await expect(
      event('refund.failed', {
        id: 're_1',
        object: 'refund',
        payment_intent: { id: 'pi_1' },
        status: 'failed'
      })
    ).resolves.toMatchObject({
      payment: { paymentId: 'pi_1', refundId: 're_1' },
      type: 'payment_refund_failed'
    })
    await expect(event('charge.dispute.created', dispute({}))).resolves.toMatchObject({
      payment: { disputeOutcome: null, paymentId: 'pi_1' },
      type: 'payment_disputed'
    })
  })

  it('carries the order a refund names, what it charged, its running total and request key (#484)', async () => {
    await expect(
      event(
        'charge.refunded',
        charge({ amount_refunded: 1000, metadata: { order_id: 'ord_1' }, refunded: false }),
        { request: { id: 'req_1', idempotency_key: 'refund:ord_1' } }
      )
    ).resolves.toMatchObject({
      payment: {
        amountCents: 4900,
        currency: 'usd',
        orderId: 'ord_1',
        partial: true,
        paymentId: 'pi_1',
        refundedCents: 1000,
        requestKey: 'refund:ord_1'
      },
      type: 'payment_refunded'
    })
    // A dispute carries no copy of the PaymentIntent's metadata: it names no order.
    await expect(
      event('charge.dispute.created', dispute({ metadata: {} }), {
        request: { id: null, idempotency_key: null }
      })
    ).resolves.toMatchObject({
      payment: { disputeOutcome: null, partial: false, paymentId: 'pi_1' },
      type: 'payment_disputed'
    })
    const disputed = await event('charge.dispute.created', dispute({}))
    expect(disputed.payment).toEqual({ disputeOutcome: null, partial: false, paymentId: 'pi_1' })
  })

  it('maps a closed dispute’s outcome: an inquiry that closed stands as won', async () => {
    for (const [status, outcome] of [
      ['won', 'won'],
      ['warning_closed', 'won'],
      ['lost', 'lost']
    ] as const) {
      await expect(event('charge.dispute.closed', dispute({ status }))).resolves.toMatchObject({
        payment: { disputeOutcome: outcome, paymentId: 'pi_1' },
        type: 'dispute_closed'
      })
    }
    await expect(
      event('charge.dispute.closed', dispute({ status: 'under_review' }))
    ).resolves.toEqual({
      checkout: null,
      id: 'evt_charge.dispute.closed',
      providerType: 'charge.dispute.closed',
      type: 'ignored'
    })
  })

  it('ignores a payment event of another mode or account, or with nothing to find it by', async () => {
    const ignored = { checkout: null, type: 'ignored' }
    await expect(event('charge.refunded', charge({}), { livemode: true })).resolves.toMatchObject(
      ignored
    )
    await expect(
      event('charge.dispute.created', dispute({}), { account: 'acct_other' })
    ).resolves.toMatchObject(ignored)
    await expect(event('charge.refunded', charge({ payment_intent: null }))).resolves.toMatchObject(
      ignored
    )
    // The object must be the event's own kind.
    await expect(event('charge.dispute.created', charge({}))).resolves.toMatchObject(ignored)
  })
})
