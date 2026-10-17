/**
 * The billing service (#68) on node:sqlite with the checked-in migrations and a fake provider:
 * a checkout opens once per target; a payment is recorded and applied once however it arrives
 * (webhook, replay, return, sweep); guardrails publish or hold a paid submission; a payment its
 * target can't accept is refunded; upgrades and relists apply to the listing; and refunds follow
 * the rejection or the badge check at refund.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminReadOperations, selectAdminListingPlans } from '@/db/admin-queries'
import { createBadgeProgramOperations } from '@/db/badge-program'
import { createBillingOperations } from '@/db/billing'
import { createDatabase } from '@/db/client'
import { createEmailDeliveryLedger } from '@/db/email-deliveries'
import { executePlans } from '@/db/plan-runner'
import { prepareCatalogPublication } from '@/db/plan-support'
import { buildRejectSubmissionPlans, DISPUTE_DECIDES_REFUND_NOTE } from '@/db/submission-plans'
import { insertPublishedListing, SqliteD1 } from '@/db/test-support'
import {
  type AdminContext,
  approveSubmission,
  rejectSubmission,
  republishListing
} from '../admin/decisions'
import { planLabel } from '../admin/listing-labels'
import { listingDetailView } from '../admin/listing-view'
import { submissionView } from '../admin/review-view'
import { checkBadgeAtRefund } from '../badge-program/refund'
import { resolveEmailPolicy } from '../email/config'
import { appEmailTemplates } from '../email/registry'
import { createCapturingEmailSender } from '../email/senders'
import { createEmailService, emailEventKey } from '../email/service'
import { features, type SiteFeatures } from '../features'
import { CONFIRM_AGAIN_HASH, SHORTEST_CHECKOUT_MS } from './checkout-window'
import type { GuardrailResult } from './guardrails'
import { createPaidClaims } from './paid-claims'
import {
  type BillingEvent,
  type BillingProvider,
  BillingProviderError,
  BillingWebhookError,
  type CheckoutState,
  type PaymentChange,
  type ProviderRefund,
  type RefundRequest
} from './provider'
import {
  type BillingDependencies,
  confirmReturn,
  fulfilOrder,
  handleWebhook,
  orderDiscountCents,
  previewRefund,
  refundOrder,
  refundRejectedSubmission,
  runBillingSweep,
  startClaimCheckout,
  startListingCheckout,
  startSubmissionCheckout
} from './service'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const ORIGIN = 'https://best.serp.co'

function fakeProvider() {
  const sessions = new Map<string, CheckoutState>()
  const refunds: RefundRequest[] = []
  const expired: string[] = []
  const refundSeen = { count: 0 }
  /** Throws on the next refund (the provider was down). */
  const failNextRefund = { value: false }
  /** The provider refuses every refund (a disputed charge, say). */
  const refuseRefunds = { value: false }
  /** The provider can't confirm expiring a checkout (it may have been paid). */
  const expireFails = { value: false }
  /**
   * The provider's record of each payment's refunds (`paymentRefunds`, #486), newest first. It
   * follows the refunds the site makes and the refund events delivered (each event once), as the
   * provider's own record would; a payment a test set (`setRefunds`) keeps exactly that.
   */
  const refundsAt = new Map<string, ProviderRefund[]>()
  const pinned = new Set<string>()
  const mirrored = new Set<string>()
  /** The provider can't be reached for its record of a payment's refunds (#486). */
  const refundsUnreachable = { value: false }
  let refundIds = 0
  const record = (paymentId: string, refund: Omit<ProviderRefund, 'id'> & { id?: string }) => {
    refundIds += 1
    const recorded = { ...refund, id: refund.id ?? `re_${refundIds}` }
    if (!pinned.has(paymentId)) {
      refundsAt.set(paymentId, [recorded, ...(refundsAt.get(paymentId) ?? [])])
    }
    return recorded.id
  }
  const sending = (paymentId: string) =>
    (refundsAt.get(paymentId) ?? []).filter(
      refund => refund.status === 'pending' || refund.status === 'succeeded'
    )
  /** What a delivered event says happened at the provider, on its record of the refunds. */
  const mirror = (event: BillingEvent) => {
    const payment = event.payment
    if (!payment || pinned.has(payment.paymentId) || mirrored.has(event.id)) return
    mirrored.add(event.id)
    if (event.type === 'payment_refunded' && !payment.partial) {
      // The site's own refund (its request key) is on the record already.
      if (payment.requestKey?.startsWith('refund:') || sending(payment.paymentId).length > 0) {
        return
      }
      record(payment.paymentId, {
        amountCents: payment.amountCents ?? 4900,
        orderId: null,
        status: 'succeeded'
      })
    }
    if (event.type === 'payment_refund_failed') {
      const refunds = refundsAt.get(payment.paymentId) ?? []
      const failed = payment.refundId
        ? refunds.find(refund => refund.id === payment.refundId)
        : sending(payment.paymentId)[0]
      if (failed) failed.status = 'failed'
      else if (payment.refundId) {
        refundsAt.set(payment.paymentId, [
          ...refunds,
          { amountCents: 4900, id: payment.refundId, orderId: null, status: 'failed' }
        ])
      }
    }
  }
  let created = 0
  const provider: BillingProvider & {
    /**
     * Pays the checkout: `charged` overrides what was charged; `discount` is a promotion code's
     * (#250), charging the price less it, and nothing to pay at 100% off.
     */
    pay(checkoutId: string, charged?: number, discount?: number): CheckoutState
    /** Sets the provider's record of a payment's refunds (newest first); events no longer change it. */
    setRefunds(paymentId: string, refunds: ProviderRefund[]): void
  } = {
    async checkoutForPayment(paymentId) {
      return [...sessions.values()].find(session => session.paymentId === paymentId) ?? null
    },
    async createCheckout(request) {
      created += 1
      const checkoutId = `cs_${created}`
      sessions.set(checkoutId, {
        amountCents: request.amountCents,
        checkoutId,
        currency: request.currency,
        discountCents: 0,
        orderId: request.orderId,
        paymentId: null,
        state: 'open',
        subtotalCents: request.amountCents
      })
      return {
        checkoutId,
        expiresAt: request.expiresAt.toISOString(),
        url: `https://pay.example/${checkoutId}`
      }
    },
    dashboardUrl: reference => `https://pay.example/dashboard/${reference}`,
    async expireCheckout(checkoutId) {
      expired.push(checkoutId)
      const session = sessions.get(checkoutId)
      if (expireFails.value || session?.state !== 'open') return false
      sessions.set(checkoutId, { ...session, state: 'expired' })
      return true
    },
    async getCheckout(checkoutId) {
      const session = sessions.get(checkoutId)
      if (!session) throw new Error('unknown session')
      return session
    },
    name: 'fake',
    pay(checkoutId, charged, discount = 0) {
      const session = sessions.get(checkoutId)
      if (!session) throw new Error('unknown session')
      const price = session.subtotalCents ?? session.amountCents ?? 0
      const amountCents = charged ?? price - discount
      const paid = {
        ...session,
        amountCents,
        discountCents: discount,
        // A 100%-off checkout completes with no payment.
        paymentId: amountCents === 0 ? null : `pi_${checkoutId}`,
        state: 'paid' as const,
        // An override with no discount stands for a changed price (the subtotal moved too).
        subtotalCents: charged !== undefined && discount === 0 ? charged : price
      }
      sessions.set(checkoutId, paid)
      return paid
    },
    async paymentRefunds(paymentId) {
      if (refundsUnreachable.value) {
        throw new BillingProviderError('unreachable', 'provider_unreachable', 503)
      }
      return (refundsAt.get(paymentId) ?? []).map(refund => ({ ...refund }))
    },
    async refund(request) {
      refundSeen.count += 1
      if (refuseRefunds.value) throw new Error('charge_disputed')
      if (failNextRefund.value) {
        failNextRefund.value = false
        throw new Error('provider down')
      }
      refunds.push(request)
      return {
        refundId: record(request.paymentId, {
          amountCents: request.amountCents,
          orderId: request.orderId,
          status: 'succeeded'
        })
      }
    },
    setRefunds(paymentId, refunds) {
      pinned.add(paymentId)
      refundsAt.set(paymentId, refunds)
    },
    async verifyWebhook({ body }) {
      const event = JSON.parse(body) as BillingEvent & { forged?: boolean }
      if (event.forged) throw new BillingWebhookError('bad signature')
      mirror(event)
      return event
    }
  }
  return {
    expired,
    expireFails,
    failNextRefund,
    provider,
    refundSeen,
    refunds,
    refundsUnreachable,
    refuseRefunds,
    sessions
  }
}

function fixture(options: { guardrails?: GuardrailResult; badge?: 'missing' | 'pass' } = {}) {
  const sqlite = new SqliteD1()
  const db = sqlite.database
  db.exec(`
    INSERT INTO categories (slug, name, sort_order) VALUES ('tools', 'Tools', 0);
    INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'before');
    INSERT INTO users (id, name, email, email_verified)
      VALUES ('user_maya', 'Maya', 'maya@example.com', 1),
        ('user_priya', 'Priya', 'priya@example.com', 1);
  `)
  const client = createDatabase(sqlite.asD1Database())
  const operations = createBillingOperations({ client })
  const {
    expired,
    expireFails,
    failNextRefund,
    provider,
    refundSeen,
    refunds,
    refundsUnreachable,
    refuseRefunds
  } = fakeProvider()
  const clock = { now: NOW }
  const badgeChecks = { count: 0 }
  const emails: Array<{
    eventKey: string
    input: unknown
    recover?: true
    template: string
    to: string
  }> = []
  let ids = 0
  const deps: BillingDependencies = {
    adminRecipient: 'devin@serp.co',
    badgeAtRefund: listingId => {
      badgeChecks.count += 1
      return checkBadgeAtRefund({
        listingId,
        now: clock.now,
        operations: createBadgeProgramOperations({ client }),
        verify: async () =>
          options.badge === 'missing' ? { code: 'badge_missing', ok: false } : { ok: true }
      })
    },
    currency: 'usd',
    eventKey: (event, ...parts) => [event, ...parts].join(':'),
    guardrails: async () => options.guardrails ?? { ok: true },
    newId: () => {
      ids += 1
      return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
    },
    notify: async (template, request) => {
      emails.push({
        eventKey: request.eventKey,
        input: request.input,
        ...(request.recover ? { recover: true as const } : {}),
        template,
        to: request.to
      })
    },
    now: () => clock.now,
    operations,
    priceCents: 4900,
    provider
  }
  const submission = (id: string, status: string, plan: string | null, extra = '') =>
    db.exec(`
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, owner_user_id, draft_saved_at, block_key,
        block_covers_subdomains ${extra ? ',badge_verified_at' : ''})
      VALUES ('${id}', '${id}.example', 'Name ${id}', 'Short', 'https://${id}.example/', 'Long',
        'tools', 'https://${id}.example/logo.png', '${status}', ${plan ? `'${plan}'` : 'NULL'},
        'user_maya', '2026-10-06T09:00:00.000Z', '${id}.example', 1
        ${extra ? `,'${extra}'` : ''})`)
  /** An approved submission's live listing on `plan`, owned by Maya. */
  const listing = (id: string, plan: 'free' | 'paid') => {
    insertPublishedListing(db, {
      categoryIds: [1],
      content: 'Content',
      description: 'Description',
      displayOrder: 0,
      id: `lst_${id}`,
      isFeatured: false,
      name: `Listing ${id}`,
      publishedAt: '2026-05-16',
      slug: `${id}.example`,
      website: `https://${id}.example/`
    })
    db.exec(`
      UPDATE listings SET source='submission' WHERE id='lst_${id}';
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, paid_at, listing_id, owner_user_id, block_key,
        block_covers_subdomains)
      VALUES ('sub_${id}', '${id}.example', 'Listing ${id}', 'Short', 'https://${id}.example/',
        'Long', 'tools', 'https://${id}.example/logo.png', 'approved', '${plan}',
        ${plan === 'paid' ? "'2026-10-01T00:00:00.000Z'" : 'NULL'}, 'lst_${id}', 'user_maya',
        '${id}.example', 1);
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('lst_${id}', 'user_maya', 'submission', '2026-05-16T00:00:00.000Z');
    `)
  }
  const row = <T>(sql: string) => db.prepare(sql).get() as T
  const rows = <T>(sql: string) => db.prepare(sql).all() as T[]
  return {
    badgeChecks,
    client,
    clock,
    db,
    deps,
    emails,
    expired,
    expireFails,
    failNextRefund,
    listing,
    provider,
    refundSeen,
    refunds,
    refundsUnreachable,
    refuseRefunds,
    row,
    rows,
    submission
  }
}

type Fixture = ReturnType<typeof fixture>

async function checkout(f: Fixture, submissionId: string): Promise<string> {
  const start = await startSubmissionCheckout(f.deps, {
    email: 'maya@example.com',
    origin: ORIGIN,
    submissionId,
    userId: 'user_maya'
  })
  if (!start.ok || !('url' in start)) throw new Error(`no checkout: ${JSON.stringify(start)}`)
  return start.url.split('/').pop() ?? ''
}

function paidEvent(f: Fixture, checkoutId: string, id = `evt_${checkoutId}`): string {
  return JSON.stringify({
    checkout: f.provider.pay(checkoutId),
    id,
    providerType: 'fake.checkout.paid',
    type: 'checkout_paid'
  } satisfies BillingEvent)
}

/**
 * One delivery and the work it handed to `waitUntil` (the payment's fulfilment, #468), run to
 * the end as the Worker runs it after the answer.
 */
async function webhook(f: Fixture, body: string) {
  const { answer, settled } = deliver(f, body)
  const result = await answer
  await settled()
  return result
}

/** One delivery: its answer, and the background work it handed over, still running. */
function deliver(f: Fixture, body: string) {
  const background: Promise<unknown>[] = []
  const answer = handleWebhook(f.deps, {
    body,
    headers: new Headers(),
    waitUntil: task => {
      background.push(task)
    }
  })
  return {
    answer,
    background,
    settled: () => Promise.all(background)
  }
}

describe('checkout', () => {
  it('chooses paid on a draft and opens one checkout per submission, for its owner only', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const first = await checkout(f, 's1')
    expect(await checkout(f, 's1')).toBe(first)
    expect(
      f.row<{ plan: string; status: string }>(
        `SELECT status, plan FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ plan: 'paid', status: 'draft' })
    expect(f.rows(`SELECT status FROM orders`)).toEqual([{ status: 'pending' }])
    await expect(
      startSubmissionCheckout(f.deps, {
        email: 'priya@example.com',
        origin: ORIGIN,
        submissionId: 's1',
        userId: 'user_priya'
      })
    ).resolves.toMatchObject({ ok: false, status: 404 })
  })

  it('sends a submission that can no longer be paid for to its account page', async () => {
    const f = fixture()
    f.submission('s1', 'rejected', 'free')
    await expect(
      startSubmissionCheckout(f.deps, {
        email: 'maya@example.com',
        origin: ORIGIN,
        submissionId: 's1',
        userId: 'user_maya'
      })
    ).resolves.toEqual({ ok: true, redirect: '/account/submissions/s1/' })
    expect(f.rows('SELECT id FROM orders')).toEqual([])
  })
})

describe('payment', () => {
  it('publishes a paid submission once, however often the payment is reported', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const body = paidEvent(f, await checkout(f, 's1'))
    await expect(webhook(f, body)).resolves.toEqual({ body: { received: true }, status: 200 })
    await expect(webhook(f, body)).resolves.toEqual({
      body: { received: true, replayed: true },
      status: 200
    })
    const order = f.row<{ id: string; outcome: string; status: string }>(
      'SELECT id, status, outcome FROM orders'
    )
    expect(order).toMatchObject({ outcome: 'published', status: 'paid' })
    // The buyer's return after the webhook changes nothing.
    await confirmReturn(f.deps, { orderId: order.id, userId: 'user_maya' })
    expect(
      f.row(
        `SELECT status, plan, listing_id IS NOT NULL AS listed FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ listed: 1, plan: 'paid', status: 'paid_pending_review' })
    expect(f.rows(`SELECT slug FROM listings WHERE is_active=1`)).toEqual([{ slug: 's1.example' }])
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(f.emails.map(email => email.template).sort()).toEqual([
      'admin-review-ready',
      'listing-live-paid'
    ])
    // Recorded as paid before the answer; the fulfilment after it published the listing.
    expect(f.rows('SELECT outcome, processed_at IS NOT NULL AS done FROM billing_events')).toEqual([
      { done: 1, outcome: 'paid' }
    ])
  })

  it('refuses a forged webhook', async () => {
    const f = fixture()
    await expect(webhook(f, JSON.stringify({ forged: true }))).resolves.toMatchObject({
      status: 400
    })
    expect(f.rows('SELECT * FROM billing_events')).toEqual([])
  })

  it('applies a payment on the buyer’s return before the webhook arrives', async () => {
    const f = fixture()
    f.submission('s1', 'pending_badge', 'free')
    const checkoutId = await checkout(f, 's1')
    f.provider.pay(checkoutId)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    await expect(
      confirmReturn(f.deps, { orderId: order.id, userId: 'user_maya' })
    ).resolves.toMatchObject({
      outcome: 'published',
      status: 'paid'
    })
    expect(f.row(`SELECT status FROM listing_submissions WHERE id='s1'`)).toEqual({
      status: 'paid_pending_review'
    })
  })

  it('holds a paid submission for review when a guardrail check fails', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    expect(f.row(`SELECT status, plan, listing_id FROM listing_submissions WHERE id='s1'`)).toEqual(
      {
        listing_id: null,
        plan: 'paid',
        status: 'verified'
      }
    )
    expect(f.row('SELECT outcome FROM orders')).toEqual({ outcome: 'held' })
    expect(f.emails.map(email => email.template).sort()).toEqual([
      'admin-review-ready',
      'payment-received-in-review'
    ])
  })

  it('refunds a payment the submission can no longer accept', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const first = await checkout(f, 's1')
    // Withdrawn while the checkout was open: recorded on the submission and refunded.
    f.db.exec(
      `UPDATE listing_submissions SET status='withdrawn', withdrawal_reason='owner' WHERE id='s1'`
    )
    await webhook(f, paidEvent(f, first))
    expect(f.row('SELECT status, outcome, refund_reason FROM orders')).toEqual({
      outcome: 'unapplied',
      refund_reason: 'unapplied',
      status: 'refunded'
    })
    expect(
      f.row(
        `SELECT paid_at IS NOT NULL AS paid, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ paid: 1, refunded: 1 })
    expect(f.refunds).toEqual([
      expect.objectContaining({
        amountCents: 4900,
        idempotencyKey: expect.stringMatching(/^refund:/u)
      })
    ])
  })

  it('refunds a second checkout paid after the first one applied', async () => {
    const f = fixture()
    f.submission('s1', 'pending_badge', 'free')
    const first = await checkout(f, 's1')
    // The first checkout closes unpaid, a second opens, and then both are paid.
    f.db.exec(`UPDATE orders SET checkout_expires_at='2026-10-06T12:01:00.000Z'`)
    const second = await checkout(f, 's1')
    expect(second).not.toBe(first)
    await webhook(f, paidEvent(f, second))
    // The superseded checkout was expired at the provider; a payment that still lands on it
    // is refunded.
    expect(f.expired).toEqual([first])
    await webhook(f, paidEvent(f, first))
    expect(f.rows('SELECT status, outcome FROM orders ORDER BY created_at, id')).toEqual(
      expect.arrayContaining([
        { outcome: 'published', status: 'paid' },
        { outcome: 'unapplied', status: 'refunded' }
      ])
    )
    expect(f.refunds).toHaveLength(1)
  })
})

describe('the webhook answers before fulfilment (#468)', () => {
  /** Guardrails that wait for `release()`, as a slow buyer site does; `calls` counts them. */
  function slowGuardrails(f: Fixture) {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const calls = { count: 0 }
    f.deps.guardrails = async () => {
      calls.count += 1
      await gate
      return { ok: true }
    }
    return { calls, release: () => release() }
  }

  it('answers once the payment is recorded, and publishes after the answer', async () => {
    const f = fixture()
    const slow = slowGuardrails(f)
    f.submission('s1', 'draft', null)
    const delivery = deliver(f, paidEvent(f, await checkout(f, 's1')))
    // Answered while the buyer's site still hasn't: the fulfilment runs on in `waitUntil`.
    await expect(delivery.answer).resolves.toEqual({ body: { received: true }, status: 200 })
    expect(delivery.background).toHaveLength(1)
    expect(f.row('SELECT status, applied_at, outcome FROM orders')).toEqual({
      applied_at: null,
      outcome: null,
      status: 'paid'
    })
    expect(f.rows('SELECT outcome, processed_at IS NOT NULL AS done FROM billing_events')).toEqual([
      { done: 1, outcome: 'paid' }
    ])
    expect(f.rows('SELECT slug FROM listings')).toEqual([])
    expect(f.emails).toEqual([])
    slow.release()
    await delivery.settled()
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'published',
      status: 'paid'
    })
    expect(f.rows('SELECT slug FROM listings WHERE is_active=1')).toEqual([{ slug: 's1.example' }])
    expect(f.emails.map(email => email.template).sort()).toEqual([
      'admin-review-ready',
      'listing-live-paid'
    ])
    expect(slow.calls.count).toBe(1)
  })

  it('leaves a fulfilment that fails after the answer to the sweep, which applies it once', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const body = paidEvent(f, await checkout(f, 's1'))
    let calls = 0
    f.deps.guardrails = async () => {
      calls += 1
      if (calls === 1) throw new Error('the buyer site hung up')
      return { ok: true }
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // The failure never reaches the answer, nor rejects the work handed to `waitUntil`.
      await expect(webhook(f, body)).resolves.toEqual({ body: { received: true }, status: 200 })
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('"event":"billing_webhook_fulfilment_failed"')
      )
    } finally {
      errors.mockRestore()
    }
    // Paid and unapplied: what the sweep looks for.
    expect(f.row('SELECT status, applied_at FROM orders')).toEqual({
      applied_at: null,
      status: 'paid'
    })
    // The provider's retry of the delivery is a replay, and runs nothing again.
    await expect(webhook(f, body)).resolves.toEqual({
      body: { received: true, replayed: true },
      status: 200
    })
    expect(calls).toBe(1)
    // The sweep takes it once it has waited ten minutes, and applies it.
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    f.clock.now = new Date(NOW.getTime() + 11 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({
      applied: 1,
      errors: 0
    })
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'published',
      status: 'paid'
    })
    expect(f.rows('SELECT slug FROM listings WHERE is_active=1')).toEqual([{ slug: 's1.example' }])
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    // Applied: the next run leaves it alone.
    f.clock.now = new Date(NOW.getTime() + 71 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    expect(calls).toBe(2)
  })

  it('leaves a refund the provider refused after the answer to the sweep', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const first = await checkout(f, 's1')
    // Withdrawn while the checkout was open: the payment is refunded, after the answer.
    f.db.exec(
      `UPDATE listing_submissions SET status='withdrawn', withdrawal_reason='owner' WHERE id='s1'`
    )
    f.failNextRefund.value = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(webhook(f, paidEvent(f, first))).resolves.toEqual({
        body: { received: true },
        status: 200
      })
    } finally {
      errors.mockRestore()
    }
    expect(f.row('SELECT status, refund_reason FROM orders')).toEqual({
      refund_reason: 'unapplied',
      status: 'refunding'
    })
    expect(f.refunds).toEqual([])
    // Backed off an hour, then the sweep finishes the same refund.
    f.clock.now = new Date(NOW.getTime() + 61 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({
      errors: 0,
      refunds: 1
    })
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'unapplied',
      status: 'refunded'
    })
    expect(f.refunds).toHaveLength(1)
  })

  it('fulfils a payment once when its deliveries overlap, or one is retried', async () => {
    const f = fixture()
    const slow = slowGuardrails(f)
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const completed = paidEvent(f, checkoutId, 'evt_completed')
    // The first delivery answers, but its fulfilment is still waiting on the buyer's site.
    const first = deliver(f, completed)
    await first.answer
    // The provider sends the same event again, and a second event for the same payment.
    const replay = deliver(f, completed)
    await expect(replay.answer).resolves.toEqual({
      body: { received: true, replayed: true },
      status: 200
    })
    expect(replay.background).toEqual([])
    const succeeded = deliver(f, paidEvent(f, checkoutId, 'evt_async_succeeded'))
    await expect(succeeded.answer).resolves.toEqual({ body: { received: true }, status: 200 })
    slow.release()
    await Promise.all([first.settled(), succeeded.settled()])
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'published',
      status: 'paid'
    })
    expect(f.rows('SELECT slug FROM listings')).toEqual([{ slug: 's1.example' }])
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(f.emails.map(email => email.template).sort()).toEqual([
      'admin-review-ready',
      'listing-live-paid'
    ])
    expect(f.refunds).toEqual([])
    // A delivery after it applied answers the recorded outcome and hands nothing over.
    const late = deliver(f, paidEvent(f, checkoutId, 'evt_late'))
    await expect(late.answer).resolves.toEqual({ body: { received: true }, status: 200 })
    expect(late.background).toEqual([])
    expect(f.rows('SELECT event_id, outcome FROM billing_events ORDER BY event_id')).toEqual([
      { event_id: 'evt_async_succeeded', outcome: 'paid' },
      { event_id: 'evt_completed', outcome: 'paid' },
      { event_id: 'evt_late', outcome: 'published' }
    ])
  })

  it('applies a payment once when marking its event processed fails and the delivery is retried', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const body = paidEvent(f, await checkout(f, 's1'))
    const finishEvent = f.deps.operations.finishEvent
    f.deps.operations.finishEvent = async () => {
      f.deps.operations.finishEvent = finishEvent
      throw new Error('D1 unavailable')
    }
    // The route answers 500 and the provider retries; the fulfilment handed over still runs.
    const failed = deliver(f, body)
    await expect(failed.answer).rejects.toThrow('D1 unavailable')
    await failed.settled()
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'published',
      status: 'paid'
    })
    await expect(webhook(f, body)).resolves.toEqual({ body: { received: true }, status: 200 })
    expect(f.rows('SELECT outcome, processed_at IS NOT NULL AS done FROM billing_events')).toEqual([
      { done: 1, outcome: 'published' }
    ])
    expect(f.rows('SELECT slug FROM listings')).toEqual([{ slug: 's1.example' }])
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(f.emails).toHaveLength(2)
  })
})

describe('races and mismatches (#111 review round 1)', () => {
  it('never refunds an order a racing delivery applied between its two reads', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const body = paidEvent(f, checkoutId)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    // The payment is recorded but not applied yet (a delivery is in flight).
    f.db.exec(`UPDATE orders SET status='paid', provider_payment_id='pi_${checkoutId}',
      charged_cents=4900, charged_currency='usd', paid_at='${NOW.toISOString()}'`)
    // The return reads the order (paid, unapplied); the webhook applies it before the return
    // reads the submission, which then looks already paid.
    const read = f.deps.operations.checkoutSubmission
    let raced = false
    f.deps.operations.checkoutSubmission = async id => {
      if (!raced) {
        raced = true
        await webhook(f, body)
      }
      return read(id)
    }
    await confirmReturn(f.deps, { orderId: order.id, userId: 'user_maya' })
    expect(raced).toBe(true)
    expect(f.refunds).toEqual([])
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'published',
      status: 'paid'
    })
    expect(f.row(`SELECT status FROM listing_submissions WHERE id='s1'`)).toEqual({
      status: 'paid_pending_review'
    })
  })

  it('never applies an order whose unapplied refund was claimed first', async () => {
    const f = fixture()
    f.submission('s1', 'pending_badge', 'free')
    const checkoutId = await checkout(f, 's1')
    await webhook(f, paidEvent(f, checkoutId))
    // A second, unapplied order for the same submission is refunded by an admin while a
    // fulfilment of it is in flight: the fulfilment's apply then loses.
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    f.db.exec(`UPDATE orders SET applied_at=NULL, outcome=NULL`)
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toMatchObject({ listing: 'unchanged', ok: true })
    expect(f.row('SELECT status, outcome, refund_reason FROM orders')).toEqual({
      outcome: 'unapplied',
      refund_reason: 'admin',
      status: 'refunded'
    })
  })

  it('applies a payment a promotion code discounted, recording what was charged (#250)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(checkoutId, undefined, 2450),
        id: 'evt_discounted',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    expect(f.row('SELECT status, outcome, attention, charged_cents FROM orders')).toEqual({
      attention: null,
      charged_cents: 2450,
      outcome: 'published',
      status: 'paid'
    })
    expect(f.refunds).toEqual([])
    // The receipt email says what was paid, not the list price.
    expect(f.emails.find(email => email.template === 'listing-live-paid')).toMatchObject({
      input: { paidCents: 2450 }
    })
  })

  it('applies a 100%-off checkout, with no payment, its checkout standing as the reference', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(checkoutId, undefined, 4900),
        id: 'evt_free',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    expect(
      f.row('SELECT status, outcome, attention, charged_cents, provider_payment_id FROM orders')
    ).toEqual({
      attention: null,
      charged_cents: 0,
      outcome: 'published',
      provider_payment_id: checkoutId,
      status: 'paid'
    })
  })

  it('flags a discount that does not add up to the price, and refunds what was charged', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const paid = f.provider.pay(checkoutId, undefined, 1000)
    await webhook(
      f,
      JSON.stringify({
        checkout: { ...paid, amountCents: 3000 },
        id: 'evt_odd',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    expect(f.row('SELECT attention, charged_cents, status FROM orders')).toEqual({
      attention: 'amount_mismatch',
      charged_cents: 3000,
      status: 'refunded'
    })
    expect(f.refunds).toEqual([expect.objectContaining({ amountCents: 3000 })])
  })

  it('shows a discount only for an applied order, never a mismatch, even after a failed refund', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(await checkout(f, 's1'), undefined, 2450),
        id: 'evt_half',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    const discounted = await f.deps.operations.order(
      f.row<{ id: string }>('SELECT id FROM orders').id
    )
    expect(discounted && orderDiscountCents(discounted)).toBe(2450)
    // A $20.00 charge that didn't match: claimed for refund as `unapplied` before the provider
    // is asked. Its flag then becomes `refund_failed`, as after five refused attempts.
    f.submission('s2', 'draft', null)
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(await checkout(f, 's2'), 2000),
        id: 'evt_short',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    const short = f.row<{ id: string }>(`SELECT id FROM orders WHERE submission_id='s2'`).id
    f.db.exec(`UPDATE orders SET attention='refund_failed' WHERE id='${short}'`)
    const mismatched = await f.deps.operations.order(short)
    expect(mismatched?.chargedCents).toBe(2000)
    expect(mismatched && orderDiscountCents(mismatched)).toBe(0)
  })

  it('flags a charge that does not match its order and refunds exactly what was charged', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(checkoutId, 5390),
        id: 'evt_taxed',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    expect(f.row('SELECT status, outcome, attention, charged_cents FROM orders')).toEqual({
      attention: 'amount_mismatch',
      charged_cents: 5390,
      outcome: 'unapplied',
      status: 'refunded'
    })
    expect(f.refunds).toEqual([expect.objectContaining({ amountCents: 5390 })])
    expect(f.row(`SELECT status, paid_at FROM listing_submissions WHERE id='s1'`)).toEqual({
      paid_at: null,
      status: 'draft'
    })
  })

  it('refuses a checkout for a website now blocked or already listed', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    f.listing('taken', 'free')
    f.db.exec(`UPDATE listing_submissions SET website='https://taken.example/' WHERE id='s1'`)
    await expect(
      startSubmissionCheckout(f.deps, {
        email: 'maya@example.com',
        origin: ORIGIN,
        submissionId: 's1',
        userId: 'user_maya'
      })
    ).resolves.toMatchObject({ error: 'website_listed', ok: false, status: 409 })
    expect(f.rows('SELECT id FROM orders')).toEqual([])
  })

  it('acts only on the order that owns the event’s checkout', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    const forged = {
      ...f.provider.pay(checkoutId),
      checkoutId: 'cs_someone_else',
      orderId: order.id
    }
    await webhook(
      f,
      JSON.stringify({
        checkout: forged,
        id: 'evt_other',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    expect(f.row('SELECT status FROM orders')).toEqual({ status: 'pending' })
    expect(f.row('SELECT outcome FROM billing_events')).toEqual({ outcome: 'unknown_order' })
  })

  it('finishes an admin refund after a lost write without checking the badge again', async () => {
    const f = fixture({ badge: 'missing' })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    f.failNextRefund.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).rejects.toThrow('provider down')
    expect(f.row('SELECT status, refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'unpublish',
      status: 'refunding'
    })
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual({
      listing: 'unpublished',
      ok: true,
      replayed: false
    })
    expect(f.badgeChecks.count).toBe(1)
    expect(f.refunds).toHaveLength(1)
    expect(
      f.row(`SELECT l.is_active FROM listing_submissions s JOIN listings l ON l.id=s.listing_id`)
    ).toEqual({ is_active: 0 })
  })

  for (const [badge, listing, live, plan] of [
    ['pass', 'kept_free', 1, 'free'],
    ['missing', 'unpublished', 0, 'paid']
  ] as const) {
    it(`applies the recorded decision (${listing}) when the sweep finishes it over an hour later`, async () => {
      const f = fixture({ badge })
      f.submission('s1', 'draft', null)
      await webhook(f, paidEvent(f, await checkout(f, 's1')))
      f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
      const order = f.row<{ id: string }>('SELECT id FROM orders')
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
      ).rejects.toThrow()
      // A newer refund check (another dialog) must not change the recorded decision either.
      f.clock.now = new Date(NOW.getTime() + 65 * 60 * 1000)
      await previewRefund(f.deps, { orderId: order.id })
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.row('SELECT status, refund_listing_action FROM orders')).toEqual({
        refund_listing_action: badge === 'pass' ? 'keep_free' : 'unpublish',
        status: 'refunded'
      })
      expect(
        f.row(
          `SELECT l.is_active AS live, s.plan, s.refunded_at IS NOT NULL AS refunded
            FROM listing_submissions s JOIN listings l ON l.id=s.listing_id`
        )
      ).toEqual({ live, plan, refunded: 1 })
      expect(f.badgeChecks.count).toBe(1)
      expect(f.refunds).toHaveLength(1)
    })

    it(`refuses a dialog a newer one replaced (409) and refunds as the fresh one shows (badge ${badge})`, async () => {
      const f = fixture({ badge })
      f.submission('s1', 'draft', null)
      await webhook(f, paidEvent(f, await checkout(f, 's1')))
      f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
      const order = f.row<{ id: string }>('SELECT id FROM orders')
      // Two tabs: the first dialog's check is no longer the listing's latest.
      const first = await previewRefund(f.deps, { orderId: order.id })
      const second = await previewRefund(f.deps, { orderId: order.id })
      const shown = (preview: typeof first) =>
        'badgeCheckId' in preview
          ? { badgeCheckId: preview.badgeCheckId, listingAction: preview.listingAction }
          : {}
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', ...shown(first), orderId: order.id })
      ).resolves.toMatchObject({ error: 'conflict', ok: false, status: 409 })
      expect(f.refunds).toEqual([])
      expect(f.row('SELECT status FROM orders')).toEqual({ status: 'paid' })
      // Nothing is checked behind the admin's back: only the two dialogs checked.
      expect(f.badgeChecks.count).toBe(2)
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', ...shown(second), orderId: order.id })
      ).resolves.toEqual({ listing, ok: true, replayed: false })
      expect(
        f.row(
          `SELECT l.is_active AS live, s.plan FROM listing_submissions s
            JOIN listings l ON l.id=s.listing_id`
        )
      ).toEqual({ live, plan })
    })
  }
})

describe('refund dialog', () => {
  it('refuses a refund whose decision differs from what the dialog said (409)', async () => {
    const f = fixture({ badge: 'pass' })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    const preview = await previewRefund(f.deps, { orderId: order.id })
    const badgeCheckId = 'badgeCheckId' in preview ? preview.badgeCheckId : null
    // The dialog showed "keep live as free"; a request saying "unpublish" is not that dialog.
    await expect(
      refundOrder(f.deps, {
        actor: 'devin@serp.co',
        badgeCheckId,
        listingAction: 'unpublish',
        orderId: order.id
      })
    ).resolves.toMatchObject({ error: 'conflict', status: 409 })
    // A dialog left open over an hour: previewed again, never refunded on the old check.
    f.clock.now = new Date(NOW.getTime() + 61 * 60 * 1000)
    await expect(
      refundOrder(f.deps, {
        actor: 'devin@serp.co',
        badgeCheckId,
        listingAction: 'keep_free',
        orderId: order.id
      })
    ).resolves.toMatchObject({ error: 'conflict', status: 409 })
    expect(f.refunds).toEqual([])
  })

  it('previews the refund with the badge checked once, and refunds with that check', async () => {
    const f = fixture({ badge: 'pass' })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    const preview = await previewRefund(f.deps, { orderId: order.id })
    expect(preview).toMatchObject({
      kind: 'refund',
      listingAction: 'keep_free',
      listingNow: { live: true, paid: true },
      ok: true
    })
    const badgeCheckId = 'badgeCheckId' in preview ? preview.badgeCheckId : null
    await expect(
      refundOrder(f.deps, {
        actor: 'devin@serp.co',
        badgeCheckId,
        note: 'Duplicate charge.',
        orderId: order.id
      })
    ).resolves.toEqual({ listing: 'kept_free', ok: true, replayed: false })
    expect(f.badgeChecks.count).toBe(1)
    expect(f.row('SELECT refund_note, refund_badge_check_id FROM orders')).toEqual({
      refund_badge_check_id: badgeCheckId,
      refund_note: 'Duplicate charge.'
    })
  })
})

describe('paid claims (#67)', () => {
  const localBoth = {
    D1_RUNTIME_ENV: 'local',
    LOCAL_CLAIMS: 'on',
    LOCAL_ORDERS: 'on',
    SITE_ENVIRONMENT: 'local'
  }

  function claimFixture(
    env: Record<string, string> = localBoth,
    siteFeatures: SiteFeatures = features
  ) {
    const f = fixture()
    insertPublishedListing(f.db, {
      categoryIds: [1],
      content: 'Content',
      description: 'Description',
      displayOrder: 0,
      id: 'lst_claim',
      isFeatured: false,
      name: 'Claimable',
      publishedAt: '2026-05-16',
      slug: 'claimable.example',
      website: 'https://claimable.example/'
    })
    f.db.exec(`
      INSERT INTO listing_claims (id, listing_id, user_id, method, status, email, email_domain,
        product_url, listing_website, code_sent_at, code_expires_at, email_verified_at)
      VALUES ('00000000-0000-4000-8000-00000000c1a1', 'lst_claim', 'user_maya', 'paid',
        'email_verified', 'maya@claimable.example', 'claimable.example',
        'https://claimable.example/', 'https://claimable.example/',
        '2026-10-06T11:00:00.000Z', '2026-10-06T11:15:00.000Z', '2026-10-06T11:05:00.000Z')
    `)
    f.deps.paidClaims = createPaidClaims({
      client: f.client,
      env,
      features: siteFeatures,
      now: () => f.clock.now
    })
    return f
  }
  const claim = { claimId: '00000000-0000-4000-8000-00000000c1a1', userId: 'user_maya' }
  const CONFIRM_AGAIN = `/products/claimable.example/${CONFIRM_AGAIN_HASH}`

  it('pays for a confirmed paid claim, and the payment makes the claimer the owner', async () => {
    const f = claimFixture()
    const start = await startClaimCheckout(f.deps, {
      ...claim,
      email: 'maya@example.com',
      origin: ORIGIN
    })
    if (!start.ok || !('url' in start)) throw new Error(`no checkout: ${JSON.stringify(start)}`)
    await webhook(f, paidEvent(f, start.url.split('/').pop() ?? ''))
    expect(f.row('SELECT purpose, status, outcome FROM orders')).toEqual({
      outcome: 'claimed',
      purpose: 'claim',
      status: 'paid'
    })
    expect(
      f.row(`SELECT user_id, verified_via FROM listing_owners WHERE listing_id='lst_claim'`)
    ).toEqual({ user_id: 'user_maya', verified_via: 'paid_claim' })
    // Owned now: nothing more to pay; the route goes back to the claim dialog.
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toEqual({ ok: true, redirect: '/products/claimable.example/#claim' })
  })

  it('refunds a claim payment the claim can no longer accept', async () => {
    const f = claimFixture()
    const start = await startClaimCheckout(f.deps, {
      ...claim,
      email: 'maya@example.com',
      origin: ORIGIN
    })
    if (!start.ok || !('url' in start)) throw new Error('no checkout')
    // Someone else became the owner while the checkout was open.
    f.db.exec(`INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES ('lst_claim', 'user_priya', 'badge_claim', '2026-10-06T11:30:00.000Z')`)
    await webhook(f, paidEvent(f, start.url.split('/').pop() ?? ''))
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'unapplied',
      status: 'refunded'
    })
    expect(f.refunds).toHaveLength(1)
  })

  async function openClaimCheckout(f: Fixture): Promise<string> {
    const start = await startClaimCheckout(f.deps, {
      ...claim,
      email: 'maya@example.com',
      origin: ORIGIN
    })
    if (!start.ok || !('url' in start)) throw new Error(`no checkout: ${JSON.stringify(start)}`)
    return start.url.split('/').pop() ?? ''
  }

  it('refunds the second payment when two tabs both pay for one claim', async () => {
    const f = claimFixture()
    const first = await openClaimCheckout(f)
    // The first checkout is about to close and couldn't be expired; a second tab opens another.
    f.db.exec(`UPDATE orders SET checkout_expires_at='2026-10-06T12:01:00.000Z'`)
    f.expireFails.value = true
    const second = await openClaimCheckout(f)
    expect(second).not.toBe(first)
    await webhook(f, paidEvent(f, second))
    await webhook(f, paidEvent(f, first))
    expect(f.rows('SELECT status, outcome FROM orders ORDER BY number')).toEqual([
      { outcome: 'unapplied', status: 'refunded' },
      { outcome: 'claimed', status: 'paid' }
    ])
    expect(f.refunds).toHaveLength(1)
    expect(
      f.rows(
        `SELECT user_id FROM listing_owners WHERE listing_id='lst_claim' AND revoked_at IS NULL`
      )
    ).toEqual([{ user_id: 'user_maya' }])
  })

  it('never completes a claim whose payment an admin refunded meanwhile', async () => {
    const f = claimFixture()
    const checkoutId = await openClaimCheckout(f)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    const paidClaims = f.deps.paidClaims
    if (!paidClaims) throw new Error('paid claims are on')
    // The admin refunds the order between the payment being recorded and it being applied.
    f.deps.paidClaims = {
      ...paidClaims,
      async complete(input) {
        await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
        return paidClaims.complete(input)
      }
    }
    await webhook(f, paidEvent(f, checkoutId))
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'unapplied',
      status: 'refunded'
    })
    expect(f.refunds).toHaveLength(1)
    expect(f.rows(`SELECT user_id FROM listing_owners WHERE listing_id='lst_claim'`)).toEqual([])
    expect(f.row(`SELECT status FROM listing_claims`)).toEqual({ status: 'email_verified' })
  })

  it('closes the checkout with the confirmation, and opens none in its last half hour', async () => {
    const f = claimFixture()
    // Confirmed 23 h 20 min ago: 40 minutes left, so the checkout closes then, not in an hour.
    f.db.exec(`UPDATE listing_claims SET email_verified_at='2026-10-05T12:40:00.000Z'`)
    await openClaimCheckout(f)
    expect(f.row('SELECT checkout_expires_at FROM orders')).toEqual({
      checkout_expires_at: '2026-10-06T12:40:00.000Z'
    })
    f.db.exec(`DELETE FROM orders`)
    // 20 minutes left: shorter than the shortest checkout, so back to the dialog for a new code.
    f.db.exec(`UPDATE listing_claims SET email_verified_at='2026-10-05T12:20:00.000Z'`)
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toEqual({ ok: true, redirect: CONFIRM_AGAIN })
    expect(f.rows('SELECT id FROM orders')).toEqual([])
  })

  it('opens a checkout just over the shortest checkout before the confirmation ends, and none just under (#128)', async () => {
    const f = claimFixture()
    // Confirmed at 11:05 the day before NOW's: the confirmation ends at 11:05 on NOW's day.
    f.db.exec(`UPDATE listing_claims SET email_verified_at='2026-10-05T11:05:00.000Z'`)
    const confirmedUntil = Date.parse('2026-10-06T11:05:00.000Z')
    f.clock.now = new Date(confirmedUntil - SHORTEST_CHECKOUT_MS - 1000)
    await openClaimCheckout(f)
    expect(f.row('SELECT checkout_expires_at FROM orders')).toEqual({
      checkout_expires_at: '2026-10-06T11:05:00.000Z'
    })
    f.db.exec(`DELETE FROM orders`)
    f.clock.now = new Date(confirmedUntil - SHORTEST_CHECKOUT_MS + 1000)
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toEqual({ ok: true, redirect: CONFIRM_AGAIN })
    expect(f.rows('SELECT id FROM orders')).toEqual([])
  })

  it('sends a claim whose confirmation ran out back to the dialog for a new code, an owned one as it stands (#476)', async () => {
    const f = claimFixture()
    // Confirmed 25 hours before NOW: the confirmation ended an hour ago.
    f.db.exec(`UPDATE listing_claims SET email_verified_at='2026-10-05T11:00:00.000Z'`)
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toEqual({ ok: true, redirect: CONFIRM_AGAIN })
    // Owned meanwhile: nothing to confirm again; the dialog shows where the claim stands.
    f.db.exec(`INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES ('lst_claim', 'user_priya', 'badge_claim', '2026-10-06T11:30:00.000Z')`)
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toEqual({ ok: true, redirect: '/products/claimable.example/#claim' })
    expect(f.rows('SELECT id FROM orders')).toEqual([])
  })

  it('offers no paid claim unless claims are on as well as orders', async () => {
    // Claims on and orders off (as #130 shipped): the badge is the only method.
    const ordersOff = claimFixture(
      { ...localBoth, LOCAL_ORDERS: 'off' },
      { ...features, claims: true, orders: false }
    )
    // Orders on while claims are off.
    const claimsOff = claimFixture(
      { ...localBoth, LOCAL_CLAIMS: 'off' },
      { ...features, claims: false, orders: true }
    )
    for (const f of [ordersOff, claimsOff]) {
      expect(f.deps.paidClaims).toBeUndefined()
      await expect(
        startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
      ).resolves.toMatchObject({ ok: false, status: 404 })
    }
  })
})

describe('upgrade and relist', () => {
  it('upgrades a live free listing to paid', async () => {
    const f = fixture()
    f.listing('free1', 'free')
    const start = await startListingCheckout(f.deps, {
      email: 'maya@example.com',
      origin: ORIGIN,
      slug: 'free1.example',
      userId: 'user_maya'
    })
    if (!start.ok || !('url' in start)) throw new Error('no checkout')
    await webhook(f, paidEvent(f, start.url.split('/').pop() ?? ''))
    expect(
      f.row(
        `SELECT plan, paid_at IS NOT NULL AS paid FROM listing_submissions WHERE id='sub_free1'`
      )
    ).toEqual({ paid: 1, plan: 'paid' })
    expect(f.row('SELECT purpose, outcome FROM orders')).toEqual({
      outcome: 'upgraded',
      purpose: 'upgrade'
    })
  })

  it('relists a listing the badge program unlisted, and nothing an admin took down', async () => {
    const f = fixture()
    f.listing('gone1', 'free')
    f.listing('admin1', 'free')
    f.db.exec(`
      UPDATE listings SET is_active=0 WHERE id IN ('lst_gone1','lst_admin1');
      INSERT INTO listing_submission_events (submission_id, event_type, detail, actor)
        VALUES ('sub_gone1', 'unpublished', 'badge_missing', 'badge-program'),
          ('sub_admin1', 'unpublished', 'admin', 'devin@serp.co');
    `)
    const start = (slug: string) =>
      startListingCheckout(f.deps, {
        email: 'maya@example.com',
        origin: ORIGIN,
        slug,
        userId: 'user_maya'
      })
    await expect(start('admin1.example')).resolves.toEqual({
      ok: true,
      redirect: '/account/listings/admin1.example/'
    })
    const relist = await start('gone1.example')
    if (!relist.ok || !('url' in relist)) throw new Error('no checkout')
    await webhook(f, paidEvent(f, relist.url.split('/').pop() ?? ''))
    expect(f.row(`SELECT is_active FROM listings WHERE id='lst_gone1'`)).toEqual({ is_active: 1 })
    expect(f.row(`SELECT plan FROM listing_submissions WHERE id='sub_gone1'`)).toEqual({
      plan: 'paid'
    })
    expect(f.row('SELECT outcome FROM orders')).toEqual({ outcome: 'relisted' })
  })

  it('never relists a listing filed under a retired category, and refunds a relist paid as it retired (#260)', async () => {
    const f = fixture()
    f.listing('gone2', 'free')
    f.db.exec(`
      UPDATE listings SET is_active=0 WHERE id='lst_gone2';
      INSERT INTO listing_submission_events (submission_id, event_type, detail, actor)
        VALUES ('sub_gone2', 'unpublished', 'badge_missing', 'badge-program');
    `)
    const start = () =>
      startListingCheckout(f.deps, {
        email: 'maya@example.com',
        origin: ORIGIN,
        slug: 'gone2.example',
        userId: 'user_maya'
      })
    const relist = await start()
    if (!relist.ok || !('url' in relist)) throw new Error('no checkout')
    // The category retires while the checkout is open.
    f.db.exec(`
      INSERT INTO categories (slug, name) VALUES ('adult', 'Adult');
      INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
        SELECT 'lst_gone2', id, 9, 0 FROM categories WHERE slug = 'adult';
      UPDATE categories SET is_active = 0 WHERE slug = 'adult';
    `)
    await webhook(f, paidEvent(f, relist.url.split('/').pop() ?? ''))
    expect(f.row(`SELECT is_active FROM listings WHERE id='lst_gone2'`)).toEqual({ is_active: 0 })
    expect(f.row('SELECT status, outcome FROM orders')).toEqual({
      outcome: 'unapplied',
      status: 'refunded'
    })
    // And no relist is offered any more.
    await expect(start()).resolves.toEqual({
      ok: true,
      redirect: '/account/listings/gone2.example/'
    })
  })
})

describe('refunds', () => {
  async function paidLive(f: Fixture): Promise<string> {
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    return f.row<{ id: string }>('SELECT id FROM orders').id
  }

  async function rejectLiveAsOther(f: Fixture): Promise<void> {
    const listingId = f.row<{ listing_id: string }>(
      `SELECT listing_id FROM listing_submissions WHERE id='s1'`
    ).listing_id
    const state = f.row<{ checksum: string; version: number }>(
      'SELECT version, checksum FROM publication_state'
    )
    await executePlans(
      f.client,
      buildRejectSubmissionPlans({
        category: 'other',
        live: {
          listingId,
          publication: await prepareCatalogPublication({
            action: 'reject',
            actor: 'devin@serp.co',
            affectedRoutes: '/products/s1.example/',
            checksum: state.checksum,
            entityId: 's1',
            now: NOW.toISOString(),
            version: state.version,
            workflow: 'app/admin'
          })
        },
        now: NOW.toISOString(),
        reason: 'Not a fit.',
        reviewer: 'devin@serp.co',
        submissionId: 's1'
      })
    )
  }

  it('throws a coded error a log line can name, not only a message (#211)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    await expect(
      refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    ).rejects.toMatchObject({
      code: 'refund_submission_not_rejected',
      message: 'Only a rejected submission is refunded this way.'
    })
  })

  it('refunds a paid submission rejected as other, once, with its email', async () => {
    const f = fixture()
    await paidLive(f)
    await rejectLiveAsOther(f)
    await refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    await refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    expect(f.refunds).toHaveLength(1)
    expect(f.row('SELECT status, refund_reason FROM orders')).toEqual({
      refund_reason: 'rejected',
      status: 'refunded'
    })
    expect(
      f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
    ).toEqual({ refunded: 1 })
    expect(
      f.emails.filter(email => email.template === 'submission-rejected-refunded')
    ).toHaveLength(2)
  })

  it('records a rejection’s failed refund made in the dashboard; its own refund emails the owner', async () => {
    const f = fixture()
    await paidLive(f)
    await rejectLiveAsOther(f)
    f.failNextRefund.value = true
    await expect(
      refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    ).rejects.toThrow('provider down')
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('payment_refunded', payment))
    // Credited to the refund that sent the money back, made outside the site (#486).
    expect(f.row('SELECT status, refund_reason, refunded_by FROM orders')).toEqual({
      refund_reason: 'rejected',
      refunded_by: 'provider',
      status: 'refunded'
    })
    // The order only: the rejection's refund (the sweep's) records the submission and emails.
    const refunded = `SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
    expect(f.row(refunded)).toEqual({ refunded: 0 })
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.row(refunded)).toEqual({ refunded: 1 })
    expect(f.refunds).toEqual([])
    expect(f.emails.map(email => email.template)).toEqual(
      expect.arrayContaining(['admin-payment-alert', 'submission-rejected-refunded'])
    )
  })

  // #498's review: after the rejection's refund failed, a refund in the dashboard failed too, and
  // its report (retried by Stripe) lands after that failure's report, or before it. Stripe's
  // record says no refund sends the money back, so the order stays `refunding`, flagged, and the
  // sweep tells the owner the rejection was refunded only once its own retry of the refund
  // succeeds (Stripe refuses it here).
  it.each(['after', 'before'] as const)(
    'leaves a rejection’s refund flagged when a failed dashboard refund is reported %s its failure (#498)',
    async when => {
      const f = fixture()
      await paidLive(f)
      await rejectLiveAsOther(f)
      f.failNextRefund.value = true
      await expect(
        refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
      ).rejects.toThrow('provider down')
      const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
      f.provider.setRefunds(payment, [
        { amountCents: 4900, id: 're_dash', orderId: null, status: 'failed' }
      ])
      const failed = paymentEvent('payment_refund_failed', payment, {
        id: 'evt_dash_failed',
        refundId: 're_dash'
      })
      if (when === 'after') await webhook(f, failed)
      await webhook(
        f,
        paymentEvent('payment_refunded', payment, {
          id: 'evt_dash_refunded',
          requestKey: 'dashboard-request'
        })
      )
      expect(
        f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_dash_refunded'`)
      ).toEqual({ outcome: 'refund_failed' })
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: 'refund_failed',
        status: 'refunding'
      })
      if (when === 'before') await webhook(f, failed)
      f.refuseRefunds.value = true
      f.clock.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: 'refund_failed',
        status: 'refunding'
      })
      expect(
        f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
      ).toEqual({ refunded: 0 })
      expect(f.refunds).toEqual([])
      expect(f.emails.map(email => email.template)).not.toContain('submission-rejected-refunded')
      expect(f.emails).toContainEqual(
        expect.objectContaining({ input: expect.objectContaining({ kind: 'refund_failed' }) })
      )
    }
  )

  // #504: the same retried report while Stripe's refunds can't be read for now. Nothing shows the
  // money went back, so the delivery answers 500 before anything is recorded: the order stays
  // `refunding`, the sweep never tells the owner the rejection was refunded, and Stripe's retry
  // decides with its record.
  it.each([
    ['unreachable', 'provider_unreachable', 503],
    ['rate-limited', 'provider_error', 429],
    ['more than it reads', 'refunds_incomplete', 502]
  ] as const)(
    'leaves a rejection’s refund unfinished while Stripe’s refunds are %s, then decides by Stripe on the retry (#504)',
    async (why, code, status) => {
      const f = fixture()
      await paidLive(f)
      await rejectLiveAsOther(f)
      f.failNextRefund.value = true
      await expect(
        refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
      ).rejects.toThrow('provider down')
      const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
      f.provider.setRefunds(payment, [
        { amountCents: 4900, id: 're_dash', orderId: null, status: 'failed' }
      ])
      const read = f.provider.paymentRefunds
      f.provider.paymentRefunds = async () => {
        throw new BillingProviderError(why, code, status)
      }
      const before = f.row('SELECT * FROM orders')
      const refunded = paymentEvent('payment_refunded', payment, {
        id: 'evt_dash_refunded',
        requestKey: 'dashboard-request'
      })
      await expect(webhook(f, refunded)).rejects.toMatchObject({ code, status })
      expect(f.row('SELECT * FROM orders')).toEqual(before)
      expect(
        f.row(
          `SELECT processed_at IS NULL AS unprocessed FROM billing_events WHERE event_id='evt_dash_refunded'`
        )
      ).toEqual({ unprocessed: 1 })
      // The sweep meanwhile retries the rejection's refund (Stripe refuses it), and tells no one.
      f.refuseRefunds.value = true
      f.clock.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.row('SELECT status FROM orders')).toEqual({ status: 'refunding' })
      expect(
        f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
      ).toEqual({ refunded: 0 })
      expect(f.emails.map(email => email.template)).not.toContain('submission-rejected-refunded')
      expect(f.emails).not.toContainEqual(
        expect.objectContaining({ input: expect.objectContaining({ kind: 'refunded' }) })
      )
      // Stripe's retry, once it answers: no refund sends the money back, so the order is flagged.
      f.provider.paymentRefunds = read
      await expect(webhook(f, refunded)).resolves.toEqual({ body: { received: true }, status: 200 })
      expect(
        f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_dash_refunded'`)
      ).toEqual({ outcome: 'refund_failed' })
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: 'refund_failed',
        status: 'refunding'
      })
      expect(f.emails.map(email => email.template)).not.toContain('submission-rejected-refunded')
    }
  )

  it('leaves a rejected listing down when a dispute opens while its refund is pending (#473)', async () => {
    const f = fixture()
    await paidLive(f)
    await rejectLiveAsOther(f)
    f.failNextRefund.value = true
    await expect(
      refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    ).rejects.toThrow('provider down')
    const version = f.row('SELECT version FROM publication_state')
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('payment_disputed', payment))
    expect(f.row('SELECT status, dispute_status FROM orders')).toEqual({
      dispute_status: 'open',
      status: 'refunding'
    })
    // The rejection took it down: nothing more is published.
    expect(f.row('SELECT version FROM publication_state')).toEqual(version)
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_payment_d%'`)
    ).toEqual({ outcome: 'disputed' })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ kind: 'disputed' }) })
    ])
  })

  it('closes a 100%-off order rejected as other without a provider refund (#250)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    await webhook(
      f,
      JSON.stringify({
        checkout: f.provider.pay(checkoutId, undefined, 4900),
        id: 'evt_free',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      })
    )
    await rejectLiveAsOther(f)
    await refundRejectedSubmission(f.deps, { actor: 'devin@serp.co', submissionId: 's1' })
    expect(f.refundSeen.count).toBe(0)
    expect(f.row('SELECT status, refund_reason, provider_refund_id FROM orders')).toEqual({
      provider_refund_id: null,
      refund_reason: 'rejected',
      status: 'refunded'
    })
    // The plain rejection: there was no payment to announce a refund of.
    const sent = f.emails.map(email => email.template)
    expect(sent).toContain('submission-rejected')
    expect(sent).not.toContain('submission-rejected-refunded')
  })

  it('sends a refund of a submission in review to its rejection instead', async () => {
    const f = fixture()
    const orderId = await paidLive(f)
    await expect(refundOrder(f.deps, { actor: 'devin@serp.co', orderId })).resolves.toMatchObject({
      error: 'submission_in_review',
      ok: false,
      status: 409
    })
    expect(f.refunds).toEqual([])
  })

  for (const [badge, listing, live] of [
    ['pass', 'kept_free', 1],
    ['missing', 'unpublished', 0]
  ] as const) {
    it(`checks the badge at refund: a ${badge} leaves the listing ${listing}`, async () => {
      const f = fixture({ badge })
      const orderId = await paidLive(f)
      f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
      await expect(refundOrder(f.deps, { actor: 'devin@serp.co', orderId })).resolves.toEqual({
        listing,
        ok: true,
        replayed: false
      })
      await expect(refundOrder(f.deps, { actor: 'devin@serp.co', orderId })).resolves.toEqual({
        listing,
        ok: true,
        replayed: true
      })
      expect(f.refunds).toHaveLength(1)
      expect(
        f.row(
          `SELECT l.is_active AS live, s.plan FROM listing_submissions s JOIN listings l ON l.id=s.listing_id WHERE s.id='s1'`
        )
      ).toEqual({
        live,
        plan: badge === 'pass' ? 'free' : 'paid'
      })
      expect(f.row(`SELECT kind, outcome FROM badge_checks`)).toEqual({
        kind: 'refund',
        outcome: badge === 'pass' ? 'pass' : 'fail'
      })
      expect(f.row('SELECT status, refund_reason, refunded_by FROM orders')).toEqual({
        refund_reason: 'admin',
        refunded_by: 'devin@serp.co',
        status: 'refunded'
      })
    })
  }
})

describe('sweep', () => {
  it('backs off a refund the provider keeps refusing, flags it, and still applies paid orders', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const refundOrderId = f.row<{ id: string }>('SELECT id FROM orders').id
    f.refuseRefunds.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: refundOrderId })
    ).rejects.toThrow()
    // Hourly runs over days: each retry waits out its backoff, five failures flag it.
    for (let hour = 1; hour <= 72; hour += 1) {
      f.clock.now = new Date(NOW.getTime() + hour * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
    }
    expect(
      f.row(`SELECT status, attention, refund_attempts FROM orders WHERE id='${refundOrderId}'`)
    ).toEqual({ attention: 'refund_failed', refund_attempts: 5, status: 'refunding' })
    expect(f.refundSeen.count).toBe(5)
    // Flagged: the sweep leaves it to an admin, and a paid order still gets applied.
    f.submission('s2', 'draft', null)
    const paid = await checkout(f, 's2')
    f.provider.pay(paid)
    f.db.exec(`UPDATE orders SET status='paid', provider_payment_id='pi_y', charged_cents=4900,
      charged_currency='usd', paid_at='2026-10-06T12:00:00.000Z' WHERE target_key='submission:s2'`)
    await runBillingSweep(f.deps, { limit: 10, providerCalls: 1 })
    expect(f.refundSeen.count).toBe(5)
    expect(f.row(`SELECT outcome FROM orders WHERE target_key='submission:s2'`)).toEqual({
      outcome: 'published'
    })
  })

  it('records a payment that reached a superseded checkout it could not expire', async () => {
    const f = fixture()
    f.submission('s1', 'pending_badge', 'free')
    const first = await checkout(f, 's1')
    f.db.exec(`UPDATE orders SET checkout_expires_at='2026-10-06T12:01:00.000Z'`)
    f.expireFails.value = true
    await checkout(f, 's1')
    expect(
      f.row(`SELECT failure_reason FROM orders WHERE provider_checkout_id='${first}'`)
    ).toEqual({ failure_reason: 'superseded_unconfirmed' })
    // The superseded checkout was paid anyway and its webhook never arrived.
    f.provider.pay(first)
    f.db.exec(`UPDATE orders SET failed_at='2026-10-06T11:00:00.000Z' WHERE status='failed'`)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(
      f.rows(`SELECT status, outcome FROM orders WHERE provider_checkout_id='${first}'`)
    ).toEqual([{ outcome: 'published', status: 'paid' }])
  })

  it('leaves checkouts it expired alone, and puts paid orders before abandoned ones', async () => {
    const f = fixture()
    for (let index = 0; index < 30; index += 1) {
      f.submission(`a${index}`, 'draft', null)
      await checkout(f, `a${index}`)
    }
    // Every abandoned checkout failed a day ago without a confirmed expiry.
    f.db.exec(`UPDATE orders SET status='failed', failure_reason='superseded_unconfirmed',
      failed_at='2026-10-05T12:00:00.000Z', created_at='2026-10-05T11:00:00.000Z'`)
    f.submission('s1', 'draft', null)
    const paid = await checkout(f, 's1')
    f.provider.pay(paid)
    // Paid, recorded, never applied.
    f.db.exec(`UPDATE orders SET status='paid', provider_payment_id='pi_x', charged_cents=4900,
      charged_currency='usd', paid_at='2026-10-06T11:00:00.000Z' WHERE target_key='submission:s1'`)
    const counts = await runBillingSweep(f.deps, { limit: 50, providerCalls: 5 })
    expect(counts).toMatchObject({ applied: 1, skipped: 26 })
    expect(f.row(`SELECT outcome FROM orders WHERE target_key='submission:s1'`)).toEqual({
      outcome: 'published'
    })
    // Asked once, the abandoned (open) checkouts are expired and stop being reconciled.
    expect(
      f.row<{ n: number }>(
        `SELECT COUNT(*) AS n FROM orders WHERE failure_reason='superseded_unconfirmed'`
      ).n
    ).toBe(26)
  })

  it('fails pending orders whose checkout closed unpaid and applies paid ones', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    f.submission('s2', 'draft', null)
    await checkout(f, 's1')
    const paid = await checkout(f, 's2')
    f.provider.pay(paid)
    f.db.exec(`UPDATE orders SET checkout_expires_at='2026-10-06T10:00:00.000Z'`)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toEqual({
      applied: 1,
      emails: 0,
      errors: 0,
      failed: 1,
      refunds: 0,
      skipped: 0
    })
    expect(f.rows(`SELECT target_key, status, outcome FROM orders ORDER BY target_key`)).toEqual([
      { outcome: null, status: 'failed', target_key: 'submission:s1' },
      { outcome: 'published', status: 'paid', target_key: 'submission:s2' }
    ])
  })
})

/**
 * The admin's "refund failed" email key (#503): the order's, and the failed refund's id hashed, as
 * the email ledger's key can't hold a Stripe id's capitals; a `refunding` order's is the order's.
 */
async function refundFailedKey(orderId: string, refundId?: string): Promise<string> {
  if (!refundId) return `payment-alert:refund_failed:${orderId}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refundId))
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return `payment-alert:refund_failed:${orderId}:${hex}`
}

/**
 * A payment event (#473): a refund, a failed refund, or a dispute, of `paymentId`; a refund may
 * carry what the payment names and charged, its running total, and its request key (#484).
 */
function paymentEvent(
  type: 'dispute_closed' | 'payment_disputed' | 'payment_refund_failed' | 'payment_refunded',
  paymentId: string,
  options: {
    disputeOutcome?: 'lost' | 'won'
    id?: string
    partial?: boolean
  } & Pick<
    PaymentChange,
    'amountCents' | 'currency' | 'orderId' | 'refundedCents' | 'refundId' | 'requestKey'
  > = {}
): string {
  const { disputeOutcome, id: _id, partial, ...reported } = options
  const payment: PaymentChange = {
    disputeOutcome: disputeOutcome ?? null,
    partial: partial ?? false,
    paymentId,
    ...reported
  }
  return JSON.stringify({
    checkout: null,
    id: options.id ?? `evt_${type}_${paymentId}`,
    payment,
    providerType: `fake.${type}`,
    type
  } satisfies BillingEvent)
}

/** A paid submission, published and in review (`paid_pending_review`): its order and listing. */
async function publishedOrder(f: Fixture, submissionId = 's1') {
  f.submission(submissionId, 'draft', null)
  await webhook(f, paidEvent(f, await checkout(f, submissionId)))
  f.emails.length = 0
  return f.row<{ id: string; listing: string; payment: string }>(
    `SELECT o.id, o.provider_payment_id AS payment, s.listing_id AS listing
      FROM orders o JOIN listing_submissions s ON s.id=o.submission_id
      WHERE o.submission_id='${submissionId}'`
  )
}

/** An order inserted as paid and applied (or not): for a claim, or a payment never applied. */
function insertPaidOrder(
  f: Fixture,
  input: {
    claimId?: string
    id: string
    listingId?: string
    outcome: 'claimed' | 'published' | null
    paymentId: string
    submissionId?: string
  }
) {
  const claim = input.claimId !== undefined
  f.db
    .prepare(
      `INSERT INTO orders (id, number, user_id, kind, purpose, target_key, submission_id,
        listing_id, claim_id, amount_cents, currency, provider, provider_payment_id, charged_cents,
        charged_currency, status, outcome, paid_at, applied_at, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(number), 1000) + 1 FROM orders), 'user_maya', ?, ?, ?, ?, ?,
        ?, 4900, 'usd', 'fake', ?, 4900, 'usd', 'paid', ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      claim ? 'paid_claim' : 'paid_listing',
      claim ? 'claim' : 'submission',
      claim ? `claim:${input.claimId}` : `submission:${input.submissionId}`,
      input.submissionId ?? null,
      input.listingId ?? null,
      input.claimId ?? null,
      input.paymentId,
      input.outcome,
      '2026-10-06T09:00:00.000Z',
      input.outcome ? '2026-10-06T09:00:00.000Z' : null,
      '2026-10-06T09:00:00.000Z',
      '2026-10-06T09:00:00.000Z'
    )
}

const liveOf = (f: Fixture, listingId: string) =>
  f.row<{ is_active: number }>(`SELECT is_active FROM listings WHERE id='${listingId}'`).is_active

/** A live listing a paid claim made `user_maya`'s (`ord_claim`, paid by `pi_claim`), no submission. */
function claimedListing(f: Fixture) {
  insertPublishedListing(f.db, {
    categoryIds: [1],
    content: 'Content',
    description: 'Description',
    displayOrder: 0,
    id: 'lst_claimed',
    isFeatured: false,
    name: 'Claimed',
    publishedAt: '2026-05-16',
    slug: 'claimed.example',
    website: 'https://claimed.example/'
  })
  f.db.exec(`INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
    VALUES ('lst_claimed', 'user_maya', 'paid_claim', '2026-10-06T09:00:00.000Z')`)
  insertPaidOrder(f, {
    claimId: 'claim_a',
    id: 'ord_claim',
    listingId: 'lst_claimed',
    outcome: 'claimed',
    paymentId: 'pi_claim'
  })
}

const claimOwner = (f: Fixture) =>
  f.row(
    `SELECT user_id, verified_via, revoked_at FROM listing_owners WHERE listing_id='lst_claimed'`
  )

/** The claimed listing's plan as /admin reads it, and its plan column. */
function claimPlan(f: Fixture): { label: string; plan: string } {
  const [query] = selectAdminListingPlans('claimed.example')
  if (!query) throw new Error('no admin listing plan')
  const plan = f.db.prepare(query.sql).get(...(query.params as string[]))?.plan as 'free' | 'paid'
  return { label: planLabel({ ownerVerifiedVia: 'paid_claim', plan }), plan }
}

/**
 * The listing's plan as /admin reads it once the submission is approved and its listing live
 * (republished, or published by the approval of a held one): `paid` or `free`.
 */
function planOnceApproved(f: Fixture, submissionId = 's1'): string {
  const { listing_id: listingId, slug } = f.row<{ listing_id: string | null; slug: string }>(
    `SELECT listing_id, slug FROM listing_submissions WHERE id='${submissionId}'`
  )
  const id = listingId ?? `lst_${submissionId}`
  if (!listingId) {
    insertPublishedListing(f.db, {
      categoryIds: [1],
      content: 'Content',
      description: 'Description',
      displayOrder: 0,
      id,
      isFeatured: false,
      name: `Name ${submissionId}`,
      publishedAt: '2026-10-06',
      slug,
      website: `https://${slug}/`
    })
  }
  f.db.exec(`
    UPDATE listings SET is_active=1, source='submission' WHERE id='${id}';
    UPDATE listing_submissions SET status='approved', listing_id='${id}' WHERE id='${submissionId}';
  `)
  const [plan] = selectAdminListingPlans(slug)
  if (!plan) throw new Error('no admin listing plan')
  return f.db.prepare(plan.sql).get(...(plan.params as string[]))?.plan as string
}

/** /admin as the reviewer uses it, on the fixture's database and clock. */
function adminContext(f: Fixture): AdminContext {
  return {
    actor: 'devin@serp.co',
    client: f.client,
    eventKey: (event, ...ids) => [event, ...ids].join(':'),
    notify: (async () => undefined) as AdminContext['notify'],
    now: () => f.clock.now
  }
}

/** The reviewer's Approve of a submission in the review queue, as its screen sends it. */
async function approve(f: Fixture, submissionId = 's1') {
  const { content_version: version } = f.row<{ content_version: number }>(
    `SELECT content_version FROM listing_submissions WHERE id='${submissionId}'`
  )
  return approveSubmission(adminContext(f), { expectedContentVersion: version, submissionId })
}

/** What the review queue and the review screen show of a submission's payment. */
async function reviewPayment(f: Fixture, submissionId = 's1') {
  const reads = createAdminReadOperations({ client: f.client })
  const queued = (await reads.listReviewQueue('all')).find(item => item.id === submissionId)
  const review = await reads.getSubmissionReview(submissionId)
  if (!queued || !review) throw new Error(`${submissionId} is not in review`)
  const view = submissionView(review, 'https://media.example')
  return {
    queue: { paymentLoss: queued.paymentLoss },
    screen: { paidAmountCents: view.paidAmountCents, paymentLoss: view.paymentLoss }
  }
}

const REFUSED_REFUNDED = {
  error: 'payment_refunded',
  message: 'This payment was refunded, so it can’t be approved. Reject it instead.',
  ok: false,
  status: 409
}
const REFUSED_DISPUTED = {
  error: 'payment_disputed',
  message: 'This payment is disputed, so it can’t be approved unless the dispute is won.',
  ok: false,
  status: 409
}

describe('refunds and disputes made outside the site (#473)', () => {
  it('takes a disputed paid listing down while in review, once, and alerts the admin', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    const body = paymentEvent('payment_disputed', order.payment)
    await expect(webhook(f, body)).resolves.toEqual({ body: { received: true }, status: 200 })
    expect(f.row('SELECT status, dispute_status, disputed_at FROM orders')).toEqual({
      dispute_status: 'open',
      disputed_at: NOW.toISOString(),
      status: 'paid'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(f.row(`SELECT status FROM listing_submissions WHERE id='s1'`)).toEqual({
      status: 'paid_pending_review'
    })
    expect(f.row(`SELECT detail FROM listing_events WHERE event_type='unpublished'`)).toEqual({
      detail: expect.stringContaining('"reason":"disputed"')
    })
    expect(f.emails).toEqual([
      {
        eventKey: `payment-alert:disputed:${order.id}`,
        input: { kind: 'disputed', listingLive: false, orderNumber: 1001, productName: 'Name s1' },
        template: 'admin-payment-alert',
        to: 'devin@serp.co'
      }
    ])
    // A duplicate delivery is a replay; a second report of the same dispute changes nothing.
    await expect(webhook(f, body)).resolves.toMatchObject({ body: { replayed: true } })
    await webhook(f, paymentEvent('payment_disputed', order.payment, { id: 'evt_again' }))
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 3 })
    expect(new Set(f.emails.map(email => email.eventKey)).size).toBe(1)
    expect(f.rows('SELECT outcome FROM billing_events ORDER BY received_at, event_id')).toEqual(
      expect.arrayContaining([{ outcome: 'disputed' }, { outcome: 'disputed' }])
    )
    // A disputed payment can't be refunded here: the provider refuses.
    await expect(previewRefund(f.deps, { orderId: order.id })).resolves.toMatchObject({
      error: 'disputed',
      status: 409
    })
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toMatchObject({ error: 'disputed', status: 409 })
  })

  it('records a closed dispute’s outcome only: the listing stays down', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('payment_disputed', order.payment))
    f.emails.length = 0
    const closed = paymentEvent('dispute_closed', order.payment, { disputeOutcome: 'won' })
    await webhook(f, closed)
    await expect(webhook(f, closed)).resolves.toMatchObject({ body: { replayed: true } })
    expect(f.row('SELECT status, dispute_status FROM orders')).toEqual({
      dispute_status: 'won',
      status: 'paid'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(f.emails).toEqual([])
    expect(f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE '%closed%'`)).toEqual({
      outcome: 'dispute_won'
    })
    // A won dispute can be refunded again.
    await expect(previewRefund(f.deps, { orderId: order.id })).resolves.not.toMatchObject({
      error: 'disputed'
    })
  })

  it('takes down and records a paid listing refunded outside the site', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const body = paymentEvent('payment_refunded', order.payment)
    await webhook(f, body)
    expect(
      f.row(
        'SELECT status, outcome, refund_reason, refunded_by, refund_listing_action, refunded_at FROM orders'
      )
    ).toEqual({
      outcome: 'published',
      refund_listing_action: 'unpublish',
      refund_reason: 'admin',
      refunded_at: NOW.toISOString(),
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    // Recorded on the submission as an admin's refund is, so the listing reads as free.
    expect(
      f.row(
        `SELECT plan, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ plan: 'paid', refunded: 1 })
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: false, orderNumber: 1001, productName: 'Name s1' },
        template: 'admin-payment-alert'
      })
    ])
    expect(f.refunds).toEqual([])
    await expect(webhook(f, body)).resolves.toMatchObject({ body: { replayed: true } })
    expect(f.rows('SELECT outcome FROM billing_events WHERE order_id IS NOT NULL')).toEqual(
      expect.arrayContaining([{ outcome: 'refunded_at_provider' }])
    )
  })

  it('answers the site’s own refund as it stands while it runs', async () => {
    const f = fixture({ badge: 'missing' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    // The provider reports the refund before the site's refund records it.
    const refund = f.provider.refund
    f.provider.refund = async request => {
      const result = await refund(request)
      await webhook(f, paymentEvent('payment_refunded', order.payment, { id: 'evt_refunding' }))
      return result
    }
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    await webhook(f, paymentEvent('payment_refunded', order.payment, { id: 'evt_refunded' }))
    expect(
      f.rows(`SELECT event_id, outcome FROM billing_events WHERE event_id LIKE 'evt_refund%'`)
    ).toEqual(
      expect.arrayContaining([
        { event_id: 'evt_refunding', outcome: 'already_refunding' },
        { event_id: 'evt_refunded', outcome: 'already_refunded' }
      ])
    )
    expect(
      f.row('SELECT refunded_by, refund_listing_action, provider_refund_id FROM orders')
    ).toEqual({
      provider_refund_id: 're_1',
      refund_listing_action: 'unpublish',
      refunded_by: 'devin@serp.co'
    })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([])
  })

  it('finishes the site’s failed refund once it is made in the dashboard, and alerts the admin', async () => {
    const f = fixture({ badge: 'missing' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    // Claimed and asked of the provider, which failed: the refund is still `refunding`.
    f.failNextRefund.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).rejects.toThrow('provider down')
    expect(liveOf(f, order.listing)).toBe(1)
    await webhook(f, paymentEvent('payment_refunded', order.payment))
    // The claimed refund, as the site's would have recorded it: its listing change, `refunded`,
    // credited to the dashboard's refund that sent the money back (#486).
    expect(
      f.row('SELECT status, refunded_by, refund_listing_action, provider_refund_id FROM orders')
    ).toEqual({
      provider_refund_id: 're_1',
      refund_listing_action: 'unpublish',
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(
      f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
    ).toEqual({ refunded: 1 })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: false, orderNumber: 1001, productName: 'Name s1' }
      })
    ])
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_payment_refunded%'`)
    ).toEqual({ outcome: 'refunded_at_provider' })
    // "Refund…" again finds it refunded outside the site: nothing more is asked of the provider.
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toMatchObject({ error: 'refunded_outside', status: 409 })
    expect(f.refunds).toEqual([])
  })

  it('alerts the admin to a partial refund without changing the order or the listing', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('payment_refunded', order.payment, { partial: true }))
    expect(f.row('SELECT status, refunded_at FROM orders')).toEqual({
      refunded_at: null,
      status: 'paid'
    })
    expect(liveOf(f, order.listing)).toBe(1)
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ kind: 'partially_refunded', listingLive: true })
      })
    ])
  })

  it('flags the site’s refund that failed at the provider and alerts the admin', async () => {
    const f = fixture({ badge: 'missing' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    f.emails.length = 0
    const failed = paymentEvent('payment_refund_failed', order.payment)
    await webhook(f, failed)
    await expect(webhook(f, failed)).resolves.toMatchObject({ body: { replayed: true } })
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: 'refund_failed',
      status: 'refunded'
    })
    expect(f.emails).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ kind: 'refund_failed' }) })
    ])
  })

  it('takes a disputed claim’s listing down, keeps its owner, and reads it free until won', async () => {
    const f = fixture()
    claimedListing(f)
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(f.row('SELECT status, dispute_status FROM orders')).toEqual({
      dispute_status: 'open',
      status: 'paid'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(0)
    expect(f.row(`SELECT detail FROM listing_events WHERE event_type='unpublished'`)).toEqual({
      detail: expect.stringContaining('"reason":"disputed"')
    })
    expect(claimOwner(f)).toEqual({
      revoked_at: null,
      user_id: 'user_maya',
      verified_via: 'paid_claim'
    })
    expect(claimPlan(f)).toEqual({ label: 'Free', plan: 'free' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        eventKey: 'payment-alert:disputed:ord_claim',
        input: { kind: 'disputed', listingLive: false, orderNumber: 1001, productName: 'Claimed' }
      })
    ])
    // Won: recorded only. The listing stays down for an admin to republish; the claim is paid again.
    f.emails.length = 0
    await webhook(f, paymentEvent('dispute_closed', 'pi_claim', { disputeOutcome: 'won' }))
    expect(f.row('SELECT dispute_status FROM orders')).toEqual({ dispute_status: 'won' })
    expect(liveOf(f, 'lst_claimed')).toBe(0)
    expect(f.emails).toEqual([])
    expect(claimPlan(f)).toEqual({ label: 'Paid claim', plan: 'paid' })
  })

  it('takes down a claim’s listing on a lost dispute whose opening never arrived', async () => {
    const f = fixture()
    claimedListing(f)
    await webhook(f, paymentEvent('dispute_closed', 'pi_claim', { disputeOutcome: 'lost' }))
    expect(f.row('SELECT dispute_status FROM orders')).toEqual({ dispute_status: 'lost' })
    expect(liveOf(f, 'lst_claimed')).toBe(0)
    expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
    expect(claimPlan(f)).toEqual({ label: 'Free', plan: 'free' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ kind: 'disputed', listingLive: false })
      })
    ])
    expect(f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_dispute%'`)).toEqual({
      outcome: 'disputed_lost'
    })
  })

  it('takes down a claim’s listing refunded outside the site and keeps its owner', async () => {
    const f = fixture()
    claimedListing(f)
    await webhook(f, paymentEvent('payment_refunded', 'pi_claim'))
    expect(
      f.row('SELECT status, outcome, refund_reason, refunded_by, refund_listing_action FROM orders')
    ).toEqual({
      outcome: 'claimed',
      refund_listing_action: 'unpublish',
      refund_reason: 'admin',
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(0)
    expect(f.row(`SELECT detail FROM listing_events WHERE event_type='unpublished'`)).toEqual({
      detail: expect.stringContaining('"reason":"refunded"')
    })
    expect(claimOwner(f)).toEqual({
      revoked_at: null,
      user_id: 'user_maya',
      verified_via: 'paid_claim'
    })
    expect(claimPlan(f)).toEqual({ label: 'Free', plan: 'free' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: false, orderNumber: 1001, productName: 'Claimed' }
      })
    ])
    expect(f.refunds).toEqual([])
  })

  it('leaves up a claimed listing an admin took from its payer before a dispute, and alerts the admin', async () => {
    const f = fixture()
    claimedListing(f)
    f.db.exec(`UPDATE listing_owners SET revoked_at='2026-10-06T10:00:00.000Z',
      revoked_reason='admin' WHERE listing_id='lst_claimed'`)
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(f.row('SELECT status, dispute_status FROM orders')).toEqual({
      dispute_status: 'open',
      status: 'paid'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    expect(f.rows(`SELECT id FROM listing_events WHERE event_type='unpublished'`)).toEqual([])
    expect(f.emails).toEqual([
      expect.objectContaining({
        eventKey: 'payment-alert:disputed:ord_claim',
        input: { kind: 'disputed', listingLive: true, orderNumber: 1001, productName: 'Claimed' }
      })
    ])
  })

  it('leaves up a claimed listing transferred to a new owner before a refund outside the site', async () => {
    const f = fixture()
    claimedListing(f)
    f.db.exec(`
      UPDATE listing_owners SET revoked_at='2026-10-06T10:00:00.000Z', revoked_reason='transferred'
        WHERE listing_id='lst_claimed';
      INSERT INTO users (id, name, email, email_verified)
        VALUES ('user_ines', 'Ines', 'ines@example.com', 1);
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('lst_claimed', 'user_ines', 'admin', '2026-10-06T10:00:00.000Z');
    `)
    await webhook(f, paymentEvent('payment_refunded', 'pi_claim'))
    expect(f.row('SELECT status, refunded_by, refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'none',
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    expect(
      f.row(
        `SELECT user_id FROM listing_owners WHERE listing_id='lst_claimed' AND revoked_at IS NULL`
      )
    ).toEqual({ user_id: 'user_ines' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: true, orderNumber: 1001, productName: 'Claimed' }
      })
    ])
  })

  it('leaves the site’s own claim refund as it was: the listing stays up', async () => {
    const f = fixture()
    claimedListing(f)
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    ).resolves.toEqual({ listing: 'unchanged', ok: true, replayed: false })
    await webhook(f, paymentEvent('payment_refunded', 'pi_claim'))
    expect(f.row('SELECT status, refunded_by, refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'none',
      refunded_by: 'devin@serp.co',
      status: 'refunded'
    })
    expect(f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_payment%'`)).toEqual({
      outcome: 'already_refunded'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
    expect(claimPlan(f)).toEqual({ label: 'Free', plan: 'free' })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([])
  })

  it('finishes the site’s failed claim refund made in the dashboard as the admin decided it', async () => {
    const f = fixture()
    claimedListing(f)
    f.failNextRefund.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    ).rejects.toThrow('provider down')
    await webhook(f, paymentEvent('payment_refunded', 'pi_claim'))
    // The admin's refund of a claim keeps the listing (the order alone), and so does its finish,
    // credited to the dashboard's refund (#486).
    expect(f.row('SELECT status, refunded_by, refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'none',
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
    expect(claimPlan(f)).toEqual({ label: 'Free', plan: 'free' })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: true, orderNumber: 1001, productName: 'Claimed' }
      })
    ])
  })

  it('takes a paid listing down when a dispute opens while the site’s refund runs', async () => {
    const f = fixture({ badge: 'pass' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    // The admin's refund (keep it live as free) is claimed; the dispute arrives before it lands.
    const refund = f.provider.refund
    let during: unknown
    f.provider.refund = async request => {
      await webhook(f, paymentEvent('payment_disputed', order.payment))
      during = {
        live: liveOf(f, order.listing),
        ...f.row('SELECT status, dispute_status FROM orders')
      }
      return refund(request)
    }
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual({ listing: 'unchanged', ok: true, replayed: false })
    expect(during).toEqual({ dispute_status: 'open', live: 0, status: 'refunding' })
    expect(f.row(`SELECT detail FROM listing_events WHERE event_type='unpublished'`)).toEqual({
      detail: expect.stringContaining('"reason":"disputed"')
    })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([
      expect.objectContaining({
        eventKey: `payment-alert:disputed:${order.id}`,
        input: { kind: 'disputed', listingLive: false, orderNumber: 1001, productName: 'Name s1' }
      })
    ])
    // The refund then finds it down and records it as it is.
    expect(f.row('SELECT status FROM orders')).toEqual({ status: 'refunded' })
    expect(liveOf(f, order.listing)).toBe(0)
  })

  // Flagged or not, a refund still `refunding` hasn't returned the money: its flag never decides
  // (#484 item 7). A `refunded` order's flag does: a refund that failed takes the listing down on a
  // dispute, whichever came first (#485's lead decision); one that succeeded never does.
  it.each([false, true])(
    'takes a claim’s listing down when a dispute opens while its failed refund is pending (refund.failed first: %s)',
    async flagged => {
      const f = fixture()
      claimedListing(f)
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      ).rejects.toThrow('provider down')
      if (flagged) await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim'))
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(f.row('SELECT status, attention, dispute_status FROM orders')).toEqual({
        attention: flagged ? 'refund_failed' : null,
        dispute_status: 'open',
        status: 'refunding'
      })
      expect(liveOf(f, 'lst_claimed')).toBe(0)
      expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
      expect(
        f.emails.filter(
          email =>
            email.template === 'admin-payment-alert' &&
            (email.input as { kind: string }).kind === 'disputed'
        )
      ).toEqual([
        expect.objectContaining({
          eventKey: 'payment-alert:disputed:ord_claim',
          input: { kind: 'disputed', listingLive: false, orderNumber: 1001, productName: 'Claimed' }
        })
      ])
    }
  )

  it.each([false, true])(
    'takes a refunded claim’s listing down on a dispute only if its refund failed first (refund.failed before: %s)',
    async failed => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      if (failed) await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim'))
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(f.row('SELECT status, attention, dispute_status FROM orders')).toEqual({
        attention: failed ? 'refund_failed' : null,
        dispute_status: 'open',
        status: 'refunded'
      })
      expect(liveOf(f, 'lst_claimed')).toBe(failed ? 0 : 1)
      expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
      expect(f.emails.map(email => email.input)).toContainEqual({
        kind: 'disputed',
        listingLive: !failed,
        orderNumber: 1001,
        productName: 'Claimed'
      })
    }
  )

  it.each(['the admin’s retry', 'a refund in Stripe'])(
    'clears a failed refund’s flag when %s succeeds, so a later dispute keeps the listing up',
    async how => {
      const f = fixture()
      claimedListing(f)
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      ).rejects.toThrow('provider down')
      await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim'))
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: 'refund_failed',
        status: 'refunding'
      })
      if (how === 'the admin’s retry') {
        await expect(
          refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
        ).resolves.toMatchObject({ ok: true })
      } else {
        await webhook(f, paymentEvent('payment_refunded', 'pi_claim'))
      }
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: null,
        status: 'refunded'
      })
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(f.row('SELECT status, attention, dispute_status FROM orders')).toEqual({
        attention: null,
        dispute_status: 'open',
        status: 'refunded'
      })
      expect(liveOf(f, 'lst_claimed')).toBe(1)
      expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
      expect(f.emails.map(email => email.input)).toContainEqual({
        kind: 'disputed',
        listingLive: true,
        orderNumber: 1001,
        productName: 'Claimed'
      })
    }
  )

  // A refund the site finished that then failed, refunded again in Stripe's dashboard (#485 round
  // 2): the money went back, so the flag clears and a later dispute keeps the listing up. The
  // site's own refund's report, delivered late (its request key), is the refund that failed.
  it.each([
    ['a refund in Stripe succeeds', 'dashboard-request', true],
    ['the site’s refund is reported late', 'refund:ord_claim', false]
  ] as const)(
    'on a refunded claim whose refund failed, clears the flag only when %s',
    async (_how, requestKey, clears) => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      expect(liveOf(f, 'lst_claimed')).toBe(1)
      await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
      expect(f.row('SELECT status, attention FROM orders')).toEqual({
        attention: 'refund_failed',
        status: 'refunded'
      })
      await webhook(
        f,
        paymentEvent('payment_refunded', 'pi_claim', { id: 'evt_refunded_again', requestKey })
      )
      expect(
        f.row('SELECT status, attention, refunded_by, provider_refund_id FROM orders')
      ).toEqual({
        attention: clears ? null : 'refund_failed',
        // The refund that sent the money back, by the provider's record (#486).
        provider_refund_id: clears ? 're_2' : 're_1',
        refunded_by: 'devin@serp.co',
        status: 'refunded'
      })
      expect(
        f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_refunded_again'`)
      ).toEqual({ outcome: 'already_refunded' })
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(f.row('SELECT attention, dispute_status FROM orders')).toEqual({
        attention: clears ? null : 'refund_failed',
        dispute_status: 'open'
      })
      expect(liveOf(f, 'lst_claimed')).toBe(clears ? 1 : 0)
      expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
      expect(f.emails.map(email => email.input)).toContainEqual({
        kind: 'disputed',
        listingLive: clears,
        orderNumber: 1001,
        productName: 'Claimed'
      })
    }
  )

  // The refund in Stripe's dashboard that cleared the flag can fail too (#485 round 3): a retry to
  // the payment method that refused the site's refund often does. The clear recorded that refund
  // (#486), so its failure flags the order again and a later dispute takes the listing down.
  it('flags a refunded claim again when the refund in Stripe that cleared its flag fails', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_refunded_again',
        requestKey: 'dashboard-request'
      })
    )
    expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
      attention: null,
      provider_refund_id: 're_2'
    })
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_dashboard_refund_failed',
        refundId: 're_2'
      })
    )
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: 'refund_failed',
      status: 'refunded'
    })
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_dashboard_refund_failed'`)
    ).toEqual({ outcome: 'refund_failed' })
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(f.row('SELECT attention, dispute_status FROM orders')).toEqual({
      attention: 'refund_failed',
      dispute_status: 'open'
    })
    expect(liveOf(f, 'lst_claimed')).toBe(0)
    expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
    expect(f.emails.map(email => email.input)).toContainEqual({
      kind: 'disputed',
      listingLive: false,
      orderNumber: 1001,
      productName: 'Claimed'
    })
  })

  // A failed refund's report names its refund (#485 round 2): an earlier refund's failure,
  // reported after the order's own refund succeeded, flags nothing; the order's own refund's does.
  it.each([
    ['the order’s refund', 're_1', true],
    ['an earlier refund', 're_earlier', false]
  ] as const)('flags a refunded claim when %s failed', async (_which, refundId, flags) => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    expect(f.row('SELECT provider_refund_id FROM orders')).toEqual({ provider_refund_id: 're_1' })
    await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId }))
    expect(f.row('SELECT attention FROM orders')).toEqual({
      attention: flags ? 'refund_failed' : null
    })
    expect(
      f.row(
        `SELECT outcome FROM billing_events WHERE event_id='evt_payment_refund_failed_pi_claim'`
      )
    ).toEqual({ outcome: flags ? 'refund_failed' : 'refund_failed_superseded' })
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(liveOf(f, 'lst_claimed')).toBe(flags ? 0 : 1)
  })

  it('never applies a disputed payment that nothing applied yet', async () => {
    const f = fixture()
    f.submission('s1', 'draft', 'paid')
    insertPaidOrder(f, {
      id: 'ord_unapplied',
      outcome: null,
      paymentId: 'pi_x',
      submissionId: 's1'
    })
    await webhook(f, paymentEvent('payment_disputed', 'pi_x'))
    expect(f.row('SELECT dispute_status FROM orders')).toEqual({ dispute_status: 'open' })
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    await expect(
      confirmReturn(f.deps, { orderId: 'ord_unapplied', userId: 'user_maya' })
    ).resolves.toMatchObject({
      appliedAt: null,
      status: 'paid'
    })
    expect(f.rows('SELECT id FROM listings')).toEqual([])
  })

  it('records a held payment refunded in the dashboard, so its approval reads as free', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.emails.length = 0
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('payment_refunded', payment))
    expect(f.row('SELECT status, outcome, refunded_by, refund_listing_action FROM orders')).toEqual(
      {
        outcome: 'held',
        refund_listing_action: 'none',
        refunded_by: 'provider',
        status: 'refunded'
      }
    )
    expect(
      f.row(
        `SELECT status, plan, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ plan: 'paid', refunded: 1, status: 'verified' })
    expect(
      f.row(`SELECT detail FROM listing_submission_events WHERE event_type='refunded'`)
    ).toEqual({ detail: 'at_provider' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        input: { kind: 'refunded', listingLive: null, orderNumber: 1001, productName: 'Name s1' }
      })
    ])
    // The queue and the screen show it refunded with no amount paid, and Approve refuses it.
    expect(await reviewPayment(f)).toEqual({
      queue: { paymentLoss: 'refunded' },
      screen: { paidAmountCents: null, paymentLoss: 'refunded' }
    })
    await expect(approve(f)).resolves.toEqual(REFUSED_REFUNDED)
    expect(f.row(`SELECT status, listing_id FROM listing_submissions WHERE id='s1'`)).toEqual({
      listing_id: null,
      status: 'verified'
    })
    expect(planOnceApproved(f)).toBe('free')
  })

  it('records a listing in review refunded in the dashboard, so it never returns as paid', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('payment_refunded', order.payment))
    expect(liveOf(f, order.listing)).toBe(0)
    expect(f.row('SELECT refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'unpublish'
    })
    // In review, the refunded order is the record (`paid_pending_review` holds no refund).
    expect(
      f.row(
        `SELECT status, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ refunded: 0, status: 'paid_pending_review' })
    // Republished and approved by its reviewer: a free listing.
    expect(planOnceApproved(f)).toBe('free')
  })

  it('reads a disputed payment’s listing as free until its dispute is won', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('payment_disputed', payment))
    // Held: nothing was live to take down. Approve refuses it while the dispute is open, and
    // the queue shows it disputed with no amount paid.
    expect(f.row('SELECT dispute_status FROM orders')).toEqual({ dispute_status: 'open' })
    expect(await reviewPayment(f)).toEqual({
      queue: { paymentLoss: 'disputed' },
      screen: { paidAmountCents: null, paymentLoss: 'disputed' }
    })
    await expect(approve(f)).resolves.toEqual(REFUSED_DISPUTED)
    // Won: the payment stands, so it is approved as a paid listing.
    await webhook(f, paymentEvent('dispute_closed', payment, { disputeOutcome: 'won' }))
    expect(await reviewPayment(f)).toEqual({
      queue: { paymentLoss: null },
      screen: { paidAmountCents: 4900, paymentLoss: null }
    })
    await expect(approve(f)).resolves.toMatchObject({ ok: true, replayed: false })
    expect(planOnceApproved(f)).toBe('paid')
  })

  it('refuses to approve a held payment whose dispute was lost', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('dispute_closed', payment, { disputeOutcome: 'lost' }))
    expect(f.row('SELECT dispute_status FROM orders')).toEqual({ dispute_status: 'lost' })
    await expect(approve(f)).resolves.toEqual(REFUSED_DISPUTED)
    expect(f.row(`SELECT status FROM listing_submissions WHERE id='s1'`)).toEqual({
      status: 'verified'
    })
  })

  for (const change of ['refunded', 'disputed'] as const) {
    it(`refuses to approve a listing in review republished after a ${change} takedown`, async () => {
      const f = fixture()
      const order = await publishedOrder(f)
      await webhook(
        f,
        paymentEvent(change === 'refunded' ? 'payment_refunded' : 'payment_disputed', order.payment)
      )
      expect(liveOf(f, order.listing)).toBe(0)
      // The reviewer republishes it (Approve needs it live), then approves: refused.
      await expect(
        republishListing(adminContext(f), { listingId: order.listing })
      ).resolves.toMatchObject({ ok: true })
      expect(liveOf(f, order.listing)).toBe(1)
      expect(await reviewPayment(f)).toEqual({
        queue: { paymentLoss: change },
        screen: { paidAmountCents: null, paymentLoss: change }
      })
      await expect(approve(f)).resolves.toEqual(
        change === 'refunded' ? REFUSED_REFUNDED : REFUSED_DISPUTED
      )
      expect(f.row(`SELECT status FROM listing_submissions WHERE id='s1'`)).toEqual({
        status: 'paid_pending_review'
      })
    })
  }

  it('records a won dispute that closed before its opening arrived, and nothing else', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('dispute_closed', order.payment, { disputeOutcome: 'won' }))
    await webhook(f, paymentEvent('payment_disputed', order.payment))
    expect(f.row('SELECT dispute_status, disputed_at FROM orders')).toEqual({
      dispute_status: 'won',
      disputed_at: NOW.toISOString()
    })
    expect(liveOf(f, order.listing)).toBe(1)
    expect(f.emails).toEqual([])
    expect(
      f.rows(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_%dispute%' ORDER BY 1`)
    ).toEqual([{ outcome: 'dispute_won' }, { outcome: 'dispute_won' }])
  })

  it('takes down a lost dispute whose opening never arrived, and alerts the admin', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('dispute_closed', order.payment, { disputeOutcome: 'lost' }))
    expect(f.row('SELECT dispute_status, disputed_at FROM orders')).toEqual({
      dispute_status: 'lost',
      disputed_at: NOW.toISOString()
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(f.emails).toEqual([
      expect.objectContaining({
        eventKey: `payment-alert:disputed:${order.id}`,
        input: expect.objectContaining({ kind: 'disputed', listingLive: false })
      })
    ])
    // Its opening, arriving late, changes nothing.
    await webhook(f, paymentEvent('payment_disputed', order.payment))
    expect(f.row('SELECT version FROM publication_state')).toEqual({ version: 3 })
    expect(
      f.rows(`SELECT event_id, outcome FROM billing_events WHERE event_id LIKE 'evt_%dispute%'`)
    ).toEqual(
      expect.arrayContaining([
        { event_id: `evt_dispute_closed_${order.payment}`, outcome: 'disputed_lost' },
        { event_id: `evt_payment_disputed_${order.payment}`, outcome: 'dispute_lost' }
      ])
    )
    expect(new Set(f.emails.map(email => email.eventKey)).size).toBe(1)
  })

  it('records a paid order nothing applied yet, refunded in the dashboard: never applied', async () => {
    const f = fixture()
    f.submission('s1', 'draft', 'paid')
    insertPaidOrder(f, {
      id: 'ord_unapplied',
      outcome: null,
      paymentId: 'pi_x',
      submissionId: 's1'
    })
    await webhook(f, paymentEvent('payment_refunded', 'pi_x'))
    expect(
      f.row('SELECT status, outcome, applied_at, refunded_by, refund_listing_action FROM orders')
    ).toEqual({
      applied_at: NOW.toISOString(),
      outcome: 'unapplied',
      refund_listing_action: 'none',
      refunded_by: 'provider',
      status: 'refunded'
    })
    // The buyer's return, the sweep and a late fulfilment find it refunded, and apply nothing.
    await expect(
      confirmReturn(f.deps, { orderId: 'ord_unapplied', userId: 'user_maya' })
    ).resolves.toMatchObject({ status: 'refunded' })
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    await expect(fulfilOrder(f.deps, 'ord_unapplied')).resolves.toBe('unapplied')
    expect(f.rows('SELECT id FROM listings')).toEqual([])
    expect(f.row(`SELECT status, paid_at FROM listing_submissions WHERE id='s1'`)).toEqual({
      paid_at: null,
      status: 'draft'
    })
    expect(f.refunds).toEqual([])
  })

  it('takes the listing down when the rest of a partly refunded payment is refunded', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    await webhook(
      f,
      paymentEvent('payment_refunded', order.payment, { id: 'evt_part', partial: true })
    )
    expect(liveOf(f, order.listing)).toBe(1)
    await webhook(f, paymentEvent('payment_refunded', order.payment, { id: 'evt_rest' }))
    expect(f.row('SELECT status, refunded_by FROM orders')).toEqual({
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(
      f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
    ).toEqual({ refunded: 1 })
    expect(f.emails.map(email => email.eventKey)).toEqual([
      `payment-alert:partially_refunded:${order.id}`,
      `payment-alert:refunded:${order.id}`
    ])
    expect(
      f.rows(
        `SELECT event_id, outcome FROM billing_events WHERE event_id IN ('evt_part','evt_rest')`
      )
    ).toEqual(
      expect.arrayContaining([
        { event_id: 'evt_part', outcome: 'partially_refunded' },
        { event_id: 'evt_rest', outcome: 'refunded_at_provider' }
      ])
    )
  })

  it('never applies a payment disputed while its fulfilment ran', async () => {
    const f = fixture()
    f.submission('s1', 'draft', 'paid')
    insertPaidOrder(f, { id: 'ord_racing', outcome: null, paymentId: 'pi_r', submissionId: 's1' })
    // The fulfilment read the order undisputed; the dispute is recorded before it applies.
    f.deps.guardrails = async () => {
      await webhook(f, paymentEvent('payment_disputed', 'pi_r'))
      return { ok: true }
    }
    await expect(fulfilOrder(f.deps, 'ord_racing')).resolves.toBe('disputed')
    expect(f.row('SELECT outcome, applied_at, dispute_status FROM orders')).toEqual({
      applied_at: null,
      dispute_status: 'open',
      outcome: null
    })
    expect(f.rows('SELECT id FROM listings')).toEqual([])
    expect(f.refunds).toEqual([])
  })

  it('acknowledges a payment no order took', async () => {
    const f = fixture()
    await expect(webhook(f, paymentEvent('payment_disputed', 'pi_unknown'))).resolves.toEqual({
      body: { received: true },
      status: 200
    })
    expect(f.row('SELECT order_id, outcome FROM billing_events')).toEqual({
      order_id: null,
      outcome: 'unknown_order'
    })
    expect(f.emails).toEqual([])
  })
})

describe('webhook follow-ups (#481)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const [outcome, sabotage] of [
    ['unknown_order', (f: Fixture) => vi.spyOn(f.deps.operations, 'order').mockResolvedValue(null)],
    [
      'retry_later',
      (f: Fixture) => {
        const apply = f.deps.operations.apply
        // The payment is recorded; every write of its fulfilment loses.
        vi.spyOn(f.deps.operations, 'apply')
          .mockImplementationOnce(plans => apply(plans))
          .mockResolvedValue(false)
      }
    ]
  ] as const) {
    it(`logs a fulfilment that ended ${outcome} as a failure`, async () => {
      const f = fixture()
      f.submission('s1', 'draft', null)
      const body = paidEvent(f, await checkout(f, 's1'))
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const infos = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      sabotage(f)
      await webhook(f, body)
      const lines = (spy: typeof warnings) =>
        spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      expect(lines(warnings)).toEqual([
        {
          event: 'billing_webhook_fulfilment_failed',
          order: expect.any(String),
          outcome,
          type: 'fake.checkout.paid'
        }
      ])
      expect(lines(infos).map(line => line.event)).not.toContain('billing_webhook_fulfilled')
    })
  }

  it('sends a recently applied payment’s emails again, from the sweep', async () => {
    const f = fixture()
    await publishedOrder(f, 's1')
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(
      f.emails
        .map(({ recover, template }) => ({ recover, template }))
        .sort((a, b) => a.template.localeCompare(b.template))
    ).toEqual([
      { recover: true, template: 'admin-review-ready' },
      { recover: true, template: 'listing-live-paid' }
    ])
    expect(new Set(f.emails.map(email => email.eventKey))).toEqual(new Set(['submission-paid:s1']))
    // Past the recovery window, nothing is sent again.
    f.emails.length = 0
    f.clock.now = new Date(NOW.getTime() + 7 * 60 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.emails).toEqual([])
  })

  it('sends a held payment’s emails again with its check’s problem', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.emails.length = 0
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.emails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: expect.objectContaining({ checkProblem: 'the connection timed out' }),
          recover: true,
          template: 'payment-received-in-review'
        })
      ])
    )
  })

  it('sends a recent payment alert again, but never a disputed payment’s “is live” email', async () => {
    const f = fixture()
    const order = await publishedOrder(f, 's1')
    await webhook(f, paymentEvent('payment_disputed', order.payment))
    f.emails.length = 0
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ emails: 1 })
    expect(f.emails).toEqual([
      expect.objectContaining({
        eventKey: `payment-alert:disputed:${order.id}`,
        recover: true,
        template: 'admin-payment-alert'
      })
    ])
  })
})

describe('dispute and refund follow-ups (#483, #484)', () => {
  /**
   * /admin's Reject as `other`, with the billing module's refund hook as the runtime wires it,
   * and the decision's `notify` (the fixture's, or an email service on the ledger, #499).
   */
  function rejectAsOther(f: Fixture, submissionId = 's1', notify?: AdminContext['notify']) {
    return rejectSubmission(
      {
        ...adminContext(f),
        // The refund's emails go through the decision's `notify`, which answers them (#490).
        notify:
          notify ??
          ((async (template, request) => {
            await f.deps.notify(template, request)
            return 'sent'
          }) as AdminContext['notify']),
        refunds: {
          refundRejectedSubmission: ({ notify, ...input }) =>
            refundRejectedSubmission(
              {
                ...f.deps,
                notify: async (template, request) => {
                  await notify(template, request)
                }
              },
              input
            )
        }
      },
      { category: 'other', reason: 'Not a fit.', submissionId }
    )
  }

  it('asks no refund when a disputed submission is rejected, records why, and stops retrying (#483)', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    await webhook(f, paymentEvent('payment_disputed', order.payment))
    f.emails.length = 0
    await expect(rejectAsOther(f)).resolves.toEqual({
      email: { outcome: 'sent', to: 'maya@example.com' },
      ok: true,
      refundPending: false,
      refunded: false,
      replayed: false
    })
    expect(f.refundSeen.count).toBe(0)
    expect(f.row('SELECT status, attention, dispute_status, refund_note FROM orders')).toEqual({
      attention: null,
      dispute_status: 'open',
      refund_note: DISPUTE_DECIDES_REFUND_NOTE,
      status: 'paid'
    })
    expect(f.row(`SELECT status, refunded_at FROM listing_submissions WHERE id='s1'`)).toEqual({
      refunded_at: null,
      status: 'rejected'
    })
    // The plain rejection: nothing went back.
    expect(f.emails.map(email => email.template)).toEqual(['submission-rejected'])
    // A replay of the rejection, and the sweep an hour later, ask nothing of the provider.
    await expect(rejectAsOther(f)).resolves.toMatchObject({
      refundPending: false,
      refunded: false,
      replayed: true
    })
    f.clock.now = new Date(NOW.getTime() + 60 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.refundSeen.count).toBe(0)
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: null,
      status: 'paid'
    })
    // /admin's listing page reads the payment as disputed, not paid (`payment-kept.ts`).
    const detail = await createAdminReadOperations({ client: f.client }).getAdminListing(
      's1.example'
    )
    if (!detail) throw new Error('no admin listing')
    expect(listingDetailView(detail, 'https://media.example').submission?.paidLabel).toBe(
      '$49.00 · disputed'
    )
    // Once the dispute is won, the admin is told, and the sweep refunds it, as the Terms promise
    // for a rejection, with the rejection's email (#485).
    f.emails.length = 0
    await webhook(f, paymentEvent('dispute_closed', order.payment, { disputeOutcome: 'won' }))
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_type LIKE '%dispute_closed%'`)
    ).toEqual({ outcome: 'dispute_won_refund' })
    expect(f.emails).toEqual([
      expect.objectContaining({
        eventKey: `payment-alert:dispute_won_refund:${order.id}`,
        input: expect.objectContaining({ kind: 'dispute_won_refund', orderNumber: 1001 }),
        template: 'admin-payment-alert'
      })
    ])
    f.clock.now = new Date(f.clock.now.getTime() + 60 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ refunds: 1 })
    expect(f.refunds).toHaveLength(1)
    expect(f.row('SELECT status, refund_reason, refund_note FROM orders')).toEqual({
      refund_note: null,
      refund_reason: 'rejected',
      status: 'refunded'
    })
    expect(f.emails.map(email => email.template)).toContain('submission-rejected-refunded')
  })

  it('answers 409 when a dispute opens while an admin refunds a rejection, and refunds nothing (#485)', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    // Rejected, its refund still owed (the hook never ran: a Worker stopped, say).
    await expect(
      rejectSubmission(
        {
          ...adminContext(f),
          refunds: {
            refundRejectedSubmission: async () => {
              throw new Error('stopped')
            }
          }
        },
        { category: 'other', reason: 'Not a fit.', submissionId: 's1' }
      )
    ).resolves.toMatchObject({ refundPending: true })
    expect(f.row('SELECT status FROM orders')).toEqual({ status: 'paid' })
    // The dispute opens after the refund's own dispute check, before the rejection's refund.
    const pending = f.deps.operations.submissionPaymentOrder.bind(f.deps.operations)
    vi.spyOn(f.deps.operations, 'submissionPaymentOrder').mockImplementationOnce(async id => {
      await webhook(f, paymentEvent('payment_disputed', order.payment))
      return pending(id)
    })
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toMatchObject({ error: 'disputed', ok: false, status: 409 })
    expect(f.refunds).toEqual([])
    expect(f.row('SELECT status, dispute_status, refund_note FROM orders')).toEqual({
      dispute_status: 'open',
      refund_note: DISPUTE_DECIDES_REFUND_NOTE,
      status: 'paid'
    })
  })

  it('tells the owner of a held payment refunded in the dashboard and then rejected, once, and refunds nothing (#499)', async () => {
    const f = fixture({
      guardrails: { code: 'fetch_timeout', ok: false, problem: 'the connection timed out' }
    })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    const payment = f.row<{ id: string }>('SELECT provider_payment_id AS id FROM orders').id
    await webhook(f, paymentEvent('payment_refunded', payment))
    expect(
      f.row(
        `SELECT status, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`
      )
    ).toEqual({ refunded: 1, status: 'verified' })
    // The decision's emails go through the email service as production wires it, on the ledger.
    const sender = createCapturingEmailSender()
    const service = createEmailService({
      ledger: createEmailDeliveryLedger({ client: f.client }),
      log: () => undefined,
      policy: resolveEmailPolicy({ D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }),
      sender,
      templates: appEmailTemplates,
      waitUntil: () => undefined
    })
    const notify: AdminContext['notify'] = (template, request) => service.deliver(template, request)
    const answer = {
      email: { outcome: 'sent', to: 'maya@example.com' },
      ok: true,
      refundPending: false,
      refunded: true
    }
    // The first rejection finds the refund recorded: the real hook refunds nothing and sends
    // "rejected and refunded". Its retry refunds nothing, and the ledger answers it went out.
    await expect(rejectAsOther(f, 's1', notify)).resolves.toEqual({ ...answer, replayed: false })
    await expect(rejectAsOther(f, 's1', notify)).resolves.toEqual({ ...answer, replayed: true })
    expect(f.refundSeen.count).toBe(0)
    expect(f.refunds).toEqual([])
    expect(f.row('SELECT status, refunded_by FROM orders')).toEqual({
      refunded_by: 'provider',
      status: 'refunded'
    })
    expect(sender.sent.map(message => message.to)).toEqual(['maya@example.com'])
    expect(f.rows('SELECT template_id, event_key, status, attempts FROM email_deliveries')).toEqual(
      [
        {
          attempts: 1,
          event_key: 'submission-rejected:s1',
          status: 'sent',
          template_id: 'submission-rejected-refunded'
        }
      ]
    )
  })

  /**
   * The decision's and the billing module's emails through the email service as production wires
   * them, on the ledger (#514): the decision's `notify`, and the fixture's for the sweep, the
   * webhook and an admin's "Refund…".
   */
  function emailsOnLedger(f: Fixture) {
    const sender = createCapturingEmailSender()
    const service = createEmailService({
      ledger: createEmailDeliveryLedger({ client: f.client }),
      log: () => undefined,
      policy: resolveEmailPolicy({ D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }),
      sender,
      templates: appEmailTemplates,
      waitUntil: () => undefined
    })
    const notify: AdminContext['notify'] = (template, request) => service.deliver(template, request)
    f.deps.notify = async (template, request) => {
      await service.deliver(template, request)
    }
    const owner = () => sender.sent.filter(message => message.to === 'maya@example.com')
    const rejectionEmails = () =>
      f.rows(
        `SELECT template_id, status, attempts FROM email_deliveries
          WHERE event_key='submission-rejected:s1'`
      )
    return { notify, owner, rejectionEmails, sender }
  }

  // #514: a paid rejection's refund failed at Stripe, and something else finishes it: the sweep's
  // retry or an admin's "Refund…" (each records the submission too, so the sweep no longer lists
  // it), or a refund in Stripe's dashboard, whose report records the order and leaves the
  // submission to the sweep. The owner gets "rejected and refunded" once, under the rejection's
  // event key, and a later admin retry of the rejection and the sweep's resend send nothing more.
  it.each([
    ['the sweep', 'sweep'],
    ['an admin’s “Refund…”', 'admin'],
    ['a refund in Stripe’s dashboard', 'report']
  ] as const)(
    'tells the owner once when %s finishes a rejection’s failed refund (#514)',
    async (_who, path) => {
      const f = fixture()
      const order = await publishedOrder(f)
      const emails = emailsOnLedger(f)
      f.failNextRefund.value = true
      await expect(rejectAsOther(f, 's1', emails.notify)).resolves.toMatchObject({
        refundPending: true,
        refunded: false
      })
      expect(f.row('SELECT status FROM orders')).toEqual({ status: 'refunding' })
      f.clock.now = new Date(NOW.getTime() + 60 * 60 * 1000)
      if (path === 'admin') {
        await expect(
          refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
        ).resolves.toEqual({ listing: 'unchanged', ok: true, replayed: false })
      } else {
        if (path === 'report') await webhook(f, paymentEvent('payment_refunded', order.payment))
        await runBillingSweep(f.deps, { limit: 10 })
      }
      expect(f.row('SELECT status, refund_reason FROM orders')).toEqual({
        refund_reason: 'rejected',
        status: 'refunded'
      })
      expect(
        f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
      ).toEqual({ refunded: 1 })
      const once = [{ attempts: 1, status: 'sent', template_id: 'submission-rejected-refunded' }]
      expect(emails.rejectionEmails()).toEqual(once)
      expect(emails.owner()).toHaveLength(1)
      // The admin's retry of the rejection refunds nothing, and the ledger answers it went out.
      await expect(rejectAsOther(f, 's1', emails.notify)).resolves.toEqual({
        email: { outcome: 'sent', to: 'maya@example.com' },
        ok: true,
        refundPending: false,
        refunded: true,
        replayed: true
      })
      // The sweep's resend, inside its window.
      f.clock.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.refunds).toHaveLength(path === 'report' ? 0 : 1)
      expect(emails.rejectionEmails()).toEqual(once)
      expect(emails.owner()).toHaveLength(1)
    }
  )

  // #514: once a rejection's refund is recorded, nothing lists it again, so a "rejected and
  // refunded" whose send failed goes again from the sweep's next run (inside its six hours), but
  // never once that refund failed at Stripe since: the money didn't go back.
  it.each([
    ['', false],
    [', unless its refund failed since', true]
  ] as const)(
    'sends a rejection’s “rejected and refunded” again from the sweep when its send failed%s (#514)',
    async (_unless, refundFailed) => {
      const f = fixture()
      const order = await publishedOrder(f)
      const emails = emailsOnLedger(f)
      f.failNextRefund.value = true
      await rejectAsOther(f, 's1', emails.notify)
      f.clock.now = new Date(NOW.getTime() + 60 * 60 * 1000)
      emails.sender.failNext(new Error('useSend is down'))
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.row('SELECT status FROM orders')).toEqual({ status: 'refunded' })
      const failed = { attempts: 1, status: 'failed', template_id: 'submission-rejected-refunded' }
      expect(emails.rejectionEmails()).toEqual([failed])
      expect(emails.owner()).toEqual([])
      if (refundFailed) {
        const { refund } = f.row<{ refund: string }>(
          'SELECT provider_refund_id AS refund FROM orders'
        )
        await webhook(f, paymentEvent('payment_refund_failed', order.payment, { refundId: refund }))
        expect(f.row('SELECT attention FROM orders')).toEqual({ attention: 'refund_failed' })
      }
      f.clock.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      f.clock.now = new Date(NOW.getTime() + 3 * 60 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(emails.rejectionEmails()).toEqual([
        refundFailed ? failed : { ...failed, attempts: 2, status: 'sent' }
      ])
      expect(emails.owner()).toHaveLength(refundFailed ? 0 : 1)
      expect(f.refunds).toHaveLength(1)
    }
  )

  it('records a refund reported before its payment, on the order it names, so nothing applies it (#484)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    f.submission('s2', 'draft', 'paid')
    // Another order, its payment recorded (and applied, so the sweep leaves it alone).
    insertPaidOrder(f, {
      id: 'ord_other',
      outcome: 'published',
      paymentId: 'pi_other',
      submissionId: 's2'
    })
    const checkoutId = await checkout(f, 's1')
    const { id: orderId } = f.row<{ id: string }>(`SELECT id FROM orders WHERE submission_id='s1'`)
    const paid = f.provider.pay(checkoutId)
    const payment = paid.paymentId ?? ''
    const charged = { amountCents: 4900, currency: 'usd' }
    // Named orders are trusted only while they have no payment recorded.
    await webhook(
      f,
      paymentEvent('payment_refunded', payment, {
        ...charged,
        id: 'evt_other',
        orderId: 'ord_other'
      })
    )
    await webhook(
      f,
      paymentEvent('payment_refunded', payment, { ...charged, id: 'evt_none', orderId: 'ord_none' })
    )
    expect(
      f.rows(`SELECT outcome FROM billing_events WHERE event_id IN ('evt_other','evt_none')`)
    ).toEqual([{ outcome: 'unknown_order' }, { outcome: 'unknown_order' }])
    await webhook(f, paymentEvent('payment_refunded', payment, { ...charged, orderId }))
    expect(
      f.row(
        `SELECT status, outcome, provider_payment_id, charged_cents, refunded_by FROM orders WHERE id='${orderId}'`
      )
    ).toEqual({
      charged_cents: 4900,
      outcome: 'unapplied',
      provider_payment_id: payment,
      refunded_by: 'provider',
      status: 'refunded'
    })
    // The checkout's own report, the buyer's return and the sweep find it refunded.
    await webhook(
      f,
      JSON.stringify({
        checkout: paid,
        id: 'evt_paid_late',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      } satisfies BillingEvent)
    )
    await expect(confirmReturn(f.deps, { orderId, userId: 'user_maya' })).resolves.toMatchObject({
      status: 'refunded'
    })
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    expect(f.rows('SELECT id FROM listings')).toEqual([])
    expect(f.refunds).toEqual([])
  })

  it('records a dispute reported before its payment on the order its checkout names, so nothing applies it (#484)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const { id: orderId } = f.row<{ id: string }>('SELECT id FROM orders')
    const paid = f.provider.pay(checkoutId)
    const payment = paid.paymentId ?? ''
    // A charge no checkout of the site's took stays unknown.
    await webhook(f, paymentEvent('payment_disputed', 'pi_elsewhere'))
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_payment_disputed_pi_elsewhere'`)
    ).toEqual({ outcome: 'unknown_order' })
    await webhook(f, paymentEvent('payment_disputed', payment))
    expect(
      f.row(
        `SELECT status, outcome, applied_at, provider_payment_id, dispute_status FROM orders WHERE id='${orderId}'`
      )
    ).toEqual({
      applied_at: null,
      dispute_status: 'open',
      outcome: null,
      provider_payment_id: payment,
      status: 'paid'
    })
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id='evt_payment_disputed_${payment}'`)
    ).toEqual({
      outcome: 'disputed'
    })
    // The checkout's own report, the buyer's return and the sweep never apply it.
    await webhook(
      f,
      JSON.stringify({
        checkout: paid,
        id: 'evt_paid_late',
        providerType: 'fake.checkout.paid',
        type: 'checkout_paid'
      } satisfies BillingEvent)
    )
    await confirmReturn(f.deps, { orderId, userId: 'user_maya' })
    f.clock.now = new Date(NOW.getTime() + 60 * 60 * 1000)
    await expect(runBillingSweep(f.deps, { limit: 10 })).resolves.toMatchObject({ applied: 0 })
    expect(f.row(`SELECT status, applied_at FROM orders WHERE id='${orderId}'`)).toEqual({
      applied_at: null,
      status: 'paid'
    })
    expect(f.rows('SELECT id FROM listings')).toEqual([])
    expect(f.refunds).toEqual([])
  })

  it('records a partial refund reported before its payment on the order it names, which then applies (#484)', async () => {
    const f = fixture()
    f.submission('s1', 'draft', null)
    const checkoutId = await checkout(f, 's1')
    const { id: orderId } = f.row<{ id: string }>('SELECT id FROM orders')
    const paid = f.provider.pay(checkoutId)
    await webhook(
      f,
      paymentEvent('payment_refunded', paid.paymentId ?? '', {
        amountCents: 4900,
        currency: 'usd',
        orderId,
        partial: true,
        refundedCents: 900
      })
    )
    expect(f.row('SELECT status, partial_refund_cents FROM orders')).toEqual({
      partial_refund_cents: 900,
      status: 'pending'
    })
    expect(f.emails.map(email => email.input)).toContainEqual(
      expect.objectContaining({ kind: 'partially_refunded' })
    )
    await webhook(f, paidEvent(f, checkoutId))
    expect(f.row('SELECT status, outcome, partial_refund_cents FROM orders')).toEqual({
      outcome: 'published',
      partial_refund_cents: 900,
      status: 'paid'
    })
  })

  it('records how much partial refunds outside the site sent back, never lowering it (#484)', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    for (const [id, refundedCents] of [
      ['evt_part_1', 1000],
      ['evt_part_2', 1500],
      // An earlier report delivered late.
      ['evt_part_late', 1000]
    ] as const) {
      await webhook(
        f,
        paymentEvent('payment_refunded', order.payment, { id, partial: true, refundedCents })
      )
    }
    expect(f.row('SELECT status, partial_refund_cents FROM orders')).toEqual({
      partial_refund_cents: 1500,
      status: 'paid'
    })
    expect(liveOf(f, order.listing)).toBe(1)
    const [row] = await f.deps.operations.adminOrders()
    expect(row?.partialRefundCents).toBe(1500)
  })

  it('reports a refund made outside the site that beat an admin’s refund as that, never as the admin’s (#484)', async () => {
    const f = fixture({ badge: 'missing' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    // The refund outside the site lands while the admin's refund is decided (its badge check).
    const badge = f.deps.badgeAtRefund
    f.deps.badgeAtRefund = async listingId => {
      await webhook(f, paymentEvent('payment_refunded', order.payment))
      return badge(listingId)
    }
    const outside = {
      error: 'refunded_outside',
      message: 'This payment was refunded outside the site, so nothing was refunded here.',
      ok: false,
      status: 409
    }
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual(outside)
    expect(f.refunds).toEqual([])
    expect(f.row('SELECT status, refunded_by FROM orders')).toEqual({
      refunded_by: 'provider',
      status: 'refunded'
    })
    // A page opened before it was refunded gets the same answer, and so does its preview.
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual(outside)
    await expect(previewRefund(f.deps, { orderId: order.id })).resolves.toEqual(outside)
    expect(f.refunds).toEqual([])
  })

  it('records the site’s own refund whose answer never came back as the site’s, with no outside alert (#484)', async () => {
    const f = fixture({ badge: 'missing' })
    const order = await publishedOrder(f)
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    // The provider refunds, but its answer is lost (a timeout): the claim stays `refunding`.
    const refund = f.provider.refund
    f.provider.refund = async request => {
      await refund(request)
      throw new Error('timed out')
    }
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).rejects.toThrow('timed out')
    expect(f.row('SELECT status, refund_attempts FROM orders')).toEqual({
      refund_attempts: 1,
      status: 'refunding'
    })
    await webhook(
      f,
      paymentEvent('payment_refunded', order.payment, { requestKey: `refund:${order.id}` })
    )
    expect(f.row('SELECT status, refunded_by, refund_listing_action FROM orders')).toEqual({
      refund_listing_action: 'unpublish',
      refunded_by: 'devin@serp.co',
      status: 'refunded'
    })
    expect(liveOf(f, order.listing)).toBe(0)
    expect(
      f.row(`SELECT outcome FROM billing_events WHERE event_id LIKE 'evt_payment_refunded%'`)
    ).toEqual({ outcome: 'refunded' })
    // No "refunded outside the site" email, then or from the sweep's resend.
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.emails.filter(email => email.template === 'admin-payment-alert')).toEqual([])
  })

  it.each(['a claim', 'a listing kept free'] as const)(
    'takes %s refunded by the site down when its refund.failed arrives after a dispute (#484)',
    async kind => {
      const f = fixture({ badge: 'pass' })
      let orderId = 'ord_claim'
      let payment = 'pi_claim'
      let listingId = 'lst_claimed'
      if (kind === 'a claim') {
        claimedListing(f)
      } else {
        const order = await publishedOrder(f)
        f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
        ;({ id: orderId, listing: listingId, payment } = order)
      }
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId })
      expect(liveOf(f, listingId)).toBe(1)
      // The dispute finds the refund done: the listing stays up (#482's rule).
      await webhook(f, paymentEvent('payment_disputed', payment))
      expect(liveOf(f, listingId)).toBe(1)
      // Then the refund fails: the money never went back and the buyer disputes it.
      await webhook(f, paymentEvent('payment_refund_failed', payment))
      expect(liveOf(f, listingId)).toBe(0)
      expect(f.row('SELECT status, attention, dispute_status FROM orders')).toEqual({
        attention: 'refund_failed',
        dispute_status: 'open',
        status: 'refunded'
      })
      expect(f.row(`SELECT detail FROM listing_events WHERE event_type='unpublished'`)).toEqual({
        detail: expect.stringContaining('"reason":"disputed"')
      })
      if (kind === 'a claim') {
        expect(claimOwner(f)).toMatchObject({ revoked_at: null, user_id: 'user_maya' })
      }
      expect(f.emails.map(email => email.input)).toContainEqual(
        expect.objectContaining({ kind: 'refund_failed', listingLive: false })
      )
      // Reported again, it changes nothing more.
      const version = f.row('SELECT version FROM publication_state')
      await webhook(f, paymentEvent('payment_refund_failed', payment, { id: 'evt_failed_again' }))
      expect(f.row('SELECT version FROM publication_state')).toEqual(version)
    }
  )
})

describe('the refund that sent the money back, and the refund_failed flag (#486)', () => {
  const REFUNDED_OUTSIDE = {
    error: 'refunded_outside',
    message: 'This payment was refunded outside the site, so nothing was refunded here.',
    ok: false,
    status: 409
  }
  const alerts = (f: Fixture) =>
    [
      ...new Set(
        f.emails
          .filter(email => email.template === 'admin-payment-alert')
          .map(email => email.eventKey)
      )
    ].sort()
  const outcomeOf = (f: Fixture, eventId: string) =>
    f.row<{ outcome: string | null }>(
      `SELECT outcome FROM billing_events WHERE event_id='${eventId}'`
    ).outcome
  const processed = (f: Fixture, eventId: string) =>
    f.row<{ done: number }>(
      `SELECT processed_at IS NOT NULL AS done FROM billing_events WHERE event_id='${eventId}'`
    ).done === 1

  // A refund made in Stripe's dashboard lands in the admin's refund's first ten minutes: its
  // report finds the admin's refund still running, and the admin's call finds the charge refunded
  // already (`charge_already_refunded`, answered as `refundId: null`). Either way round, the order
  // credits the refund that sent the money back.
  it.each([
    ['while the admin’s refund runs', 'during'],
    ['after the admin’s refund finds the charge refunded', 'after']
  ] as const)(
    'credits a refund made outside the site, reported %s, to that refund (#486)',
    async (_when, reported) => {
      const f = fixture({ badge: 'missing' })
      const order = await publishedOrder(f)
      f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
      const outside = paymentEvent('payment_refunded', order.payment, {
        id: 'evt_outside',
        requestKey: 'dashboard-request'
      })
      if (reported === 'after') {
        f.provider.setRefunds(order.payment, [
          { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' }
        ])
      }
      f.provider.refund = async () => {
        if (reported === 'during') await webhook(f, outside)
        return { refundId: null }
      }
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
      ).resolves.toEqual(REFUNDED_OUTSIDE)
      if (reported === 'during') expect(outcomeOf(f, 'evt_outside')).toBe('already_refunding')
      else await webhook(f, outside)
      // Recorded as refunded outside the site ("Refunded outside the site" in admin Orders), with
      // the refund that did it. The money and the listing are as before: the admin's decision
      // (no badge: unpublish) applied.
      expect(
        f.row(
          'SELECT status, refund_reason, refunded_by, refund_listing_action, provider_refund_id FROM orders'
        )
      ).toEqual({
        provider_refund_id: reported === 'during' ? 're_1' : 're_dashboard',
        refund_listing_action: 'unpublish',
        refund_reason: 'admin',
        refunded_by: 'provider',
        status: 'refunded'
      })
      expect(liveOf(f, order.listing)).toBe(0)
      expect(
        f.row(`SELECT refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id='s1'`)
      ).toEqual({ refunded: 1 })
      if (reported === 'after') expect(outcomeOf(f, 'evt_outside')).toBe('refunded_at_provider')
      // The admin is told it was refunded outside the site (the email ledger sends it once).
      expect(alerts(f)).toEqual([`payment-alert:refunded:${order.id}`])
      expect(f.emails).toContainEqual(
        expect.objectContaining({
          input: { kind: 'refunded', listingLive: false, orderNumber: 1001, productName: 'Name s1' }
        })
      )
      // "Refund…" again, and its preview, answer the same.
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
      ).resolves.toEqual(REFUNDED_OUTSIDE)
      await expect(previewRefund(f.deps, { orderId: order.id })).resolves.toEqual(REFUNDED_OUTSIDE)
    }
  )

  // The admin's refund failed (Stripe down); before its retry, the payment was refunded in the
  // dashboard, and no report of that came (the events not ticked yet, say). The retry finds the
  // charge refunded already, and Stripe's record names the dashboard's refund.
  it.each(['“Refund…” again', 'the sweep'] as const)(
    'credits a refund made outside the site before %s retried the admin’s to that refund (#486)',
    async how => {
      const f = fixture({ badge: 'missing' })
      const order = await publishedOrder(f)
      f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
      ).rejects.toThrow('provider down')
      f.provider.setRefunds(order.payment, [
        { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' }
      ])
      f.provider.refund = async () => ({ refundId: null })
      if (how === 'the sweep') {
        f.clock.now = new Date(NOW.getTime() + 2 * 60 * 60 * 1000)
        await runBillingSweep(f.deps, { limit: 10 })
      } else {
        await expect(
          refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
        ).resolves.toEqual(REFUNDED_OUTSIDE)
      }
      expect(
        f.row('SELECT status, refunded_by, refund_listing_action, provider_refund_id FROM orders')
      ).toEqual({
        provider_refund_id: 're_dashboard',
        refund_listing_action: 'unpublish',
        refunded_by: 'provider',
        status: 'refunded'
      })
      expect(liveOf(f, order.listing)).toBe(0)
      expect(alerts(f)).toEqual([`payment-alert:refunded:${order.id}`])
    }
  )

  it('answers a rejection’s refund from Orders that a refund outside the site beat as that (#486)', async () => {
    const f = fixture()
    const order = await publishedOrder(f)
    // Rejected, its refund still owed (the hook never ran: a Worker stopped, say).
    await expect(
      rejectSubmission(
        {
          ...adminContext(f),
          refunds: {
            refundRejectedSubmission: async () => {
              throw new Error('stopped')
            }
          }
        },
        { category: 'other', reason: 'Not a fit.', submissionId: 's1' }
      )
    ).resolves.toMatchObject({ refundPending: true })
    f.provider.setRefunds(order.payment, [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' }
    ])
    f.provider.refund = async () => ({ refundId: null })
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual(REFUNDED_OUTSIDE)
    expect(
      f.row('SELECT status, refund_reason, refunded_by, provider_refund_id FROM orders')
    ).toEqual({
      provider_refund_id: 're_dashboard',
      refund_reason: 'rejected',
      refunded_by: 'provider',
      status: 'refunded'
    })
    // The money went back, so the owner hears the rejection was refunded, and the admin how.
    expect(f.emails.map(email => email.template)).toEqual(
      expect.arrayContaining(['admin-payment-alert', 'submission-rejected-refunded'])
    )
  })

  // After the site's refund failed, a full refund's report finishes it; when Stripe refuses the
  // read (a key without the access), the report's request key says which refund it was, as
  // before, and the delivery is answered.
  it.each([
    ['a refund in the dashboard', 'dashboard-request', 'provider'],
    ['the site’s own refund', 'refund:ord_claim', 'devin@serp.co']
  ] as const)(
    'credits %s by its request key when Stripe refuses the read (#486)',
    async (_which, requestKey, refundedBy) => {
      const f = fixture()
      claimedListing(f)
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      ).rejects.toThrow('provider down')
      f.provider.paymentRefunds = async () => {
        throw new BillingProviderError('Stripe answered 403.', 'provider_error', 403)
      }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        await expect(
          webhook(f, paymentEvent('payment_refunded', 'pi_claim', { requestKey }))
        ).resolves.toEqual({ body: { received: true }, status: 200 })
      } finally {
        errors.mockRestore()
      }
      expect(f.row('SELECT status, refunded_by, provider_refund_id FROM orders')).toEqual({
        provider_refund_id: null,
        refunded_by: refundedBy,
        status: 'refunded'
      })
    }
  )

  // #504: Stripe can't say for now (down, rate-limited, a partial list), so the report alone
  // can't show the money went back: nothing is recorded, the delivery answers 500, and Stripe's
  // retry credits the refund its record shows.
  it.each([
    ['a refund in the dashboard', 'dashboard-request', null, 'provider'],
    ['the site’s own refund', 'refund:ord_claim', 'ord_claim', 'devin@serp.co']
  ] as const)(
    'leaves the claimed refund as it was while Stripe can’t say, then credits %s by Stripe on the retry (#504)',
    async (_which, requestKey, namedOrder, refundedBy) => {
      const f = fixture()
      claimedListing(f)
      f.failNextRefund.value = true
      await expect(
        refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      ).rejects.toThrow('provider down')
      const before = f.row('SELECT * FROM orders')
      const report = paymentEvent('payment_refunded', 'pi_claim', { id: 'evt_report', requestKey })
      f.refundsUnreachable.value = true
      await expect(webhook(f, report)).rejects.toBeInstanceOf(BillingProviderError)
      expect(f.row('SELECT * FROM orders')).toEqual(before)
      expect(processed(f, 'evt_report')).toBe(false)
      expect(alerts(f)).toEqual([])
      f.refundsUnreachable.value = false
      f.provider.setRefunds('pi_claim', [
        { amountCents: 4900, id: 're_back', orderId: namedOrder, status: 'succeeded' }
      ])
      await expect(webhook(f, report)).resolves.toEqual({ body: { received: true }, status: 200 })
      expect(f.row('SELECT status, refunded_by, provider_refund_id FROM orders')).toEqual({
        provider_refund_id: 're_back',
        refunded_by: refundedBy,
        status: 'refunded'
      })
      expect(alerts(f)).toEqual(
        refundedBy === 'provider' ? ['payment-alert:refunded:ord_claim'] : []
      )
    }
  )

  it('credits the site’s own earlier refund, by the order it names, when its key expired (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_earlier', orderId: 'ord_claim', status: 'succeeded' }
    ])
    f.provider.refund = async () => ({ refundId: null })
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    ).resolves.toEqual({ listing: 'unchanged', ok: true, replayed: false })
    expect(f.row('SELECT status, refunded_by, provider_refund_id FROM orders')).toEqual({
      provider_refund_id: 're_earlier',
      refunded_by: 'devin@serp.co',
      status: 'refunded'
    })
    expect(alerts(f)).toEqual([])
  })

  it('credits the admin, as before, when Stripe can’t say which refund sent the money back (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    f.provider.refund = async () => ({ refundId: null })
    f.refundsUnreachable.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    ).resolves.toEqual({ listing: 'unchanged', ok: true, replayed: false })
    expect(f.row('SELECT status, refunded_by, provider_refund_id FROM orders')).toEqual({
      provider_refund_id: null,
      refunded_by: 'devin@serp.co',
      status: 'refunded'
    })
    expect(alerts(f)).toEqual([])
  })

  // #485's third review: a refund in Stripe's dashboard sent the money back after the site's
  // refund failed, and its report arrives before the site's refund's failure. Stripe's record
  // says the money is back, so the failure flags nothing and a dispute keeps the listing up.
  it('flags nothing when a refund’s failure arrives after a later refund’s report (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' },
      { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_dashboard_refunded',
        requestKey: 'dashboard-request'
      })
    )
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', { id: 'evt_failed', refundId: 're_1' })
    )
    expect(outcomeOf(f, 'evt_failed')).toBe('refund_failed_superseded')
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: null,
      status: 'refunded'
    })
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(liveOf(f, 'lst_claimed')).toBe(1)
    expect(alerts(f)).toEqual(['payment-alert:disputed:ord_claim'])
  })

  // #485's third review: the dashboard's refund that would clear the flag failed too, and its
  // report (retried by Stripe) lands after its failure. Stripe's record says the money never went
  // back, so the flag stays and a dispute takes the listing down.
  it('keeps the flag when a refund’s retried report lands after its failure (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'failed' },
      { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_dashboard_failed',
        refundId: 're_dashboard'
      })
    )
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_dashboard_refunded_retried',
        requestKey: 'dashboard-request'
      })
    )
    expect(outcomeOf(f, 'evt_dashboard_refunded_retried')).toBe('already_refunded')
    // The order records the dashboard's refund, the one that failed, though no report of it ever
    // cleared the flag (#503), so the admin is emailed for each failed refund.
    expect(f.row('SELECT status, attention, provider_refund_id FROM orders')).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_dashboard',
      status: 'refunded'
    })
    expect(alerts(f)).toEqual(
      (
        await Promise.all([
          refundFailedKey('ord_claim', 're_1'),
          refundFailedKey('ord_claim', 're_dashboard')
        ])
      ).sort()
    )
    await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
    expect(liveOf(f, 'lst_claimed')).toBe(0)
  })

  // Codex on #498: the dashboard refunded the payment in more parts than one page of Stripe's
  // list holds (100). The provider reads every page, so the total is the whole charge and the
  // site's refund failing flags nothing.
  it('flags nothing when the refunds that sent the money back fill more than a page (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    f.provider.setRefunds('pi_claim', [
      ...Array.from({ length: 104 }, (_, index) => ({
        amountCents: index < 100 ? 45 : 100,
        id: `re_part_${index}`,
        orderId: null,
        status: 'succeeded' as const
      })),
      { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', { id: 'evt_failed', refundId: 're_1' })
    )
    expect(outcomeOf(f, 'evt_failed')).toBe('refund_failed_superseded')
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: null,
      status: 'refunded'
    })
  })

  // More refunds than the provider reads: an unknown, as when Stripe is down, never a short total.
  // The failure decides as before, and the delivery answers 500 so Stripe delivers it again.
  it('decides as before when the provider can’t read all of a payment’s refunds (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    f.provider.paymentRefunds = async () => {
      throw new BillingProviderError('More refunds than it reads.', 'refunds_incomplete', 502)
    }
    const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
      id: 'evt_failed',
      refundId: 're_1'
    })
    await expect(webhook(f, failed)).rejects.toBeInstanceOf(BillingProviderError)
    expect(f.row('SELECT attention FROM orders')).toEqual({ attention: 'refund_failed' })
    expect(processed(f, 'evt_failed')).toBe(false)
  })

  // Stripe can't be reached: the report decides as before, and the delivery answers 500, so
  // Stripe delivers it again; once Stripe answers, its record decides.
  it('decides a failure as before while Stripe can’t be reached, then by Stripe on the retry (#486)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    // The first refund's failure, after a dashboard refund sent the money back (as above).
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' },
      { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
    ])
    const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
      id: 'evt_failed',
      refundId: 're_1'
    })
    f.refundsUnreachable.value = true
    await expect(webhook(f, failed)).rejects.toBeInstanceOf(BillingProviderError)
    // As before: the order's own refund failed, so it is flagged; the event stays unprocessed.
    expect(f.row('SELECT attention FROM orders')).toEqual({ attention: 'refund_failed' })
    expect(processed(f, 'evt_failed')).toBe(false)
    f.refundsUnreachable.value = false
    await expect(webhook(f, failed)).resolves.toEqual({ body: { received: true }, status: 200 })
    expect(outcomeOf(f, 'evt_failed')).toBe('refund_failed_superseded')
    expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
      attention: null,
      provider_refund_id: 're_dashboard'
    })
  })

  // #513 (#509's review): a refund's report while Stripe can't say for now (down, a 5xx, a partial
  // list) records nothing: the flag stays, so a dispute meanwhile still reads the refund as failed,
  // and the delivery answers 500. Stripe's retry then decides by its record.
  it.each([
    ['sent the money back', 'succeeded', null, 're_dashboard'],
    ['failed too', 'failed', 'refund_failed', 're_1']
  ] as const)(
    'keeps the flag while Stripe can’t say, then decides a refund’s report by Stripe on the retry when that refund %s (#513)',
    async (_how, status, attention, providerRefundId) => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
      const before = f.row('SELECT * FROM orders')
      f.emails.length = 0
      const refunded = paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_dashboard_refunded',
        requestKey: 'dashboard-request'
      })
      f.refundsUnreachable.value = true
      await expect(webhook(f, refunded)).rejects.toBeInstanceOf(BillingProviderError)
      expect(f.row('SELECT * FROM orders')).toEqual(before)
      expect(processed(f, 'evt_dashboard_refunded')).toBe(false)
      f.refundsUnreachable.value = false
      f.provider.setRefunds('pi_claim', [
        { amountCents: 4900, id: 're_dashboard', orderId: null, status },
        { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
      ])
      await expect(webhook(f, refunded)).resolves.toEqual({ body: { received: true }, status: 200 })
      expect(f.row('SELECT status, attention, provider_refund_id FROM orders')).toEqual({
        attention,
        provider_refund_id: providerRefundId,
        status: 'refunded'
      })
      // Flagged already for the site's refund: nothing new to tell the admin.
      expect(alerts(f)).toEqual([])
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(liveOf(f, 'lst_claimed')).toBe(attention ? 0 : 1)
    }
  )

  // #498's review: the dashboard refund's failure is recorded while another refund event asks
  // Stripe for the payment's refunds, and Stripe's answer predates it (the refund still pending).
  // The clear is compared and swapped on the order as read before Stripe was asked, so the event
  // reads both again, and the flag stays. The order keeps the dashboard's refund, the newest that
  // failed: the site's refund's late report doesn't put its own back (#515's review, #503).
  it.each([
    ['a dashboard refund’s report', 'refunded'],
    ['a retried failure', 'failed']
  ] as const)(
    'keeps the flag when a refund’s failure is recorded while %s reads Stripe (#498)',
    async (_which, event) => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_failed',
        refundId: 're_1'
      })
      // A retried failure: its first delivery found Stripe down, decided as before, and answered 500.
      f.refundsUnreachable.value = event === 'failed'
      await webhook(f, failed).catch(() => undefined)
      f.refundsUnreachable.value = false
      expect(f.row('SELECT attention FROM orders')).toEqual({ attention: 'refund_failed' })
      // Stripe's record once the dashboard's refund failed too.
      f.provider.setRefunds('pi_claim', [
        { amountCents: 4900, id: 're_dash', orderId: null, status: 'failed' },
        { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
      ])
      const read = f.provider.paymentRefunds
      let asked = false
      f.provider.paymentRefunds = async paymentId => {
        if (asked) return read(paymentId)
        asked = true
        f.clock.now = new Date(f.clock.now.getTime() + 1000)
        await webhook(
          f,
          paymentEvent('payment_refund_failed', 'pi_claim', {
            id: 'evt_dash_failed',
            refundId: 're_dash'
          })
        )
        return [
          { amountCents: 4900, id: 're_dash', orderId: null, status: 'pending' },
          { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
        ]
      }
      await webhook(
        f,
        event === 'failed'
          ? failed
          : paymentEvent('payment_refunded', 'pi_claim', {
              id: 'evt_dash_refunded',
              requestKey: 'dashboard-request'
            })
      )
      expect(f.row('SELECT status, attention, provider_refund_id FROM orders')).toEqual({
        attention: 'refund_failed',
        provider_refund_id: 're_dash',
        status: 'refunded'
      })
      await webhook(f, paymentEvent('payment_disputed', 'pi_claim'))
      expect(liveOf(f, 'lst_claimed')).toBe(0)
    }
  )

  // Something else changed the order while Stripe was read (no refund's failure): the event
  // reads both again, and Stripe's record still clears the flag.
  it.each(['report', 'failure'] as const)(
    'reads again, and clears the flag, when the order changed while a refund’s %s read Stripe (#498)',
    async event => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_failed',
        refundId: 're_1'
      })
      f.refundsUnreachable.value = event === 'failure'
      await webhook(f, failed).catch(() => undefined)
      f.refundsUnreachable.value = false
      let reads = 0
      f.provider.paymentRefunds = async () => {
        reads += 1
        if (reads === 1) {
          f.clock.now = new Date(f.clock.now.getTime() + 1000)
          f.db.exec(`UPDATE orders SET updated_at='${f.clock.now.toISOString()}'`)
        }
        return [
          { amountCents: 4900, id: 're_dash', orderId: null, status: 'succeeded' },
          { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
        ]
      }
      await webhook(
        f,
        event === 'failure'
          ? failed
          : paymentEvent('payment_refunded', 'pi_claim', { requestKey: 'dashboard-request' })
      )
      expect(reads).toBe(2)
      expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
        attention: null,
        provider_refund_id: 're_dash'
      })
    }
  )

  // The order keeps changing while Stripe is read: after reading both again once, the flag stays
  // and the delivery answers 500, so Stripe delivers it again.
  it('keeps the flag and answers 500 when the order keeps changing while Stripe is read (#498)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
    let reads = 0
    f.provider.paymentRefunds = async () => {
      reads += 1
      f.clock.now = new Date(f.clock.now.getTime() + 1000)
      f.db.exec(`UPDATE orders SET updated_at='${f.clock.now.toISOString()}'`)
      return [
        { amountCents: 4900, id: 're_dash', orderId: null, status: 'succeeded' },
        { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
      ]
    }
    const refunded = paymentEvent('payment_refunded', 'pi_claim', {
      id: 'evt_dash_refunded',
      requestKey: 'dashboard-request'
    })
    await expect(webhook(f, refunded)).rejects.toMatchObject({
      code: 'billing_payment_change_not_recorded'
    })
    expect(reads).toBe(2)
    expect(f.row('SELECT attention FROM orders')).toEqual({ attention: 'refund_failed' })
    expect(processed(f, 'evt_dash_refunded')).toBe(false)
  })

  // #498's review: nothing has run the restricted key's Refunds read against Stripe. A key refused
  // it (401, 403) won't be let in on a retry, so the event decides as before and is answered, with
  // the error logged; a rate limit or Stripe's own error answers 500 so Stripe delivers it again.
  it.each([
    ['failure', 401, 200],
    ['failure', 403, 200],
    ['failure', 429, 500],
    ['failure', 500, 500],
    ['report', 401, 200],
    ['report', 403, 200],
    ['report', 429, 500],
    ['report', 503, 500]
  ] as const)(
    'decides a refund’s %s as before when the refunds read answers %i, and answers %i (#498)',
    async (event, status, answered) => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      if (event === 'report') {
        await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
      }
      f.provider.paymentRefunds = async () => {
        throw new BillingProviderError(`Stripe answered ${status}.`, 'provider_error', status)
      }
      const delivered =
        event === 'failure'
          ? paymentEvent('payment_refund_failed', 'pi_claim', { id: 'evt_x', refundId: 're_1' })
          : paymentEvent('payment_refunded', 'pi_claim', {
              id: 'evt_x',
              requestKey: 'dashboard-request'
            })
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        if (answered === 200) {
          await expect(webhook(f, delivered)).resolves.toEqual({
            body: { received: true },
            status: 200
          })
        } else {
          await expect(webhook(f, delivered)).rejects.toBeInstanceOf(BillingProviderError)
        }
        expect(errors).toHaveBeenCalledWith(
          expect.stringMatching(
            new RegExp(`"event":"billing_refunds_unchecked".*"retry":${answered === 500}`)
          )
        )
      } finally {
        errors.mockRestore()
      }
      expect(processed(f, 'evt_x')).toBe(answered === 200)
      // As before: the order's own refund's failure flags it, and when the key is refused the read,
      // another refund's report clears it; while Stripe can't say for now, it stays (#513).
      expect(f.row('SELECT attention FROM orders')).toEqual({
        attention: event === 'report' && answered === 200 ? null : 'refund_failed'
      })
    }
  )

  // #503 (#498's review): the admin's "refund failed" email is keyed on the refund that failed, so
  // a dashboard refund that cleared the flag and then failed too emails the admin again, while a
  // retried report of the same failure (Stripe's retry after a 500, or another report) doesn't.
  it('emails the admin once for each failed refund of an order (#503)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
      id: 'evt_failed',
      refundId: 're_1'
    })
    // Its first delivery finds Stripe down: flagged as reported, and answered 500.
    f.refundsUnreachable.value = true
    await expect(webhook(f, failed)).rejects.toBeInstanceOf(BillingProviderError)
    f.refundsUnreachable.value = false
    await webhook(f, failed)
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_failed_again',
        refundId: 're_1'
      })
    )
    const first = await refundFailedKey('ord_claim', 're_1')
    expect(alerts(f)).toEqual([first])
    // A refund in Stripe's dashboard sends the money back, then fails too.
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_refunded_again',
        requestKey: 'dashboard-request'
      })
    )
    expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
      attention: null,
      provider_refund_id: 're_2'
    })
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_dashboard_failed',
        refundId: 're_2'
      })
    )
    expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_2'
    })
    const second = await refundFailedKey('ord_claim', 're_2')
    expect(alerts(f)).toEqual([first, second].sort())
    // The sweep's resend of each names the refund the flagged order records: no third email.
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    const resent = f.emails.filter(email => email.recover).map(email => email.eventKey)
    expect(resent).toHaveLength(3)
    expect(new Set(resent)).toEqual(new Set([second]))
    expect(alerts(f)).toEqual([first, second].sort())
  })

  // #515's review: a dashboard refund of a paid order records no refund, and its report, retried
  // after a 500, is processed after that refund failed and before its `refund.failed`. Both events
  // key the email on the failed refund in Stripe's record, so one failure sends one email.
  it('emails the admin once when a dashboard refund’s retried report lands before its failure (#503)', async () => {
    const f = fixture()
    claimedListing(f)
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'succeeded' }
    ])
    const refunded = paymentEvent('payment_refunded', 'pi_claim', {
      id: 'evt_dashboard_refunded',
      requestKey: 'dashboard-request'
    })
    // Its first delivery records the refund, then finds Stripe down and answers 500.
    f.refundsUnreachable.value = true
    await expect(webhook(f, refunded)).rejects.toBeInstanceOf(BillingProviderError)
    f.refundsUnreachable.value = false
    expect(f.row('SELECT status, attention, provider_refund_id FROM orders')).toEqual({
      attention: null,
      provider_refund_id: null,
      status: 'refunded'
    })
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: 're_dashboard', orderId: null, status: 'failed' }
    ])
    await webhook(f, refunded)
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_dashboard_failed',
        refundId: 're_dashboard'
      })
    )
    expect(f.row('SELECT attention, provider_refund_id FROM orders')).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_dashboard'
    })
    const sent = [
      await refundFailedKey('ord_claim', 're_dashboard'),
      'payment-alert:refunded:ord_claim'
    ]
    expect(alerts(f)).toEqual(sent.sort())
    // The sweep's resend names the same refund.
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(alerts(f)).toEqual(sent.sort())
  })

  // #514 (#515's re-review): two partial refunds in Stripe's dashboard send the whole payment back.
  // The newer fails (flagged, emailed), a third refund sends the rest back (the flag clears), then
  // the older fails. The order isn't flagged then, so it records the refund that report names, and
  // that failure emails the admin under its own key, once.
  it('emails the admin once for an older refund that fails after a refund cleared a newer one’s flag (#514)', async () => {
    const f = fixture()
    claimedListing(f)
    const newer = { amountCents: 2450, id: 're_newer', orderId: null }
    const older = { amountCents: 2450, id: 're_older', orderId: null }
    const third = { amountCents: 2450, id: 're_third', orderId: null, status: 'succeeded' as const }
    const flag = 'SELECT status, attention, provider_refund_id FROM orders'
    f.provider.setRefunds('pi_claim', [
      { ...newer, status: 'pending' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_refunded',
        requestKey: 'dashboard-request'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: null,
      provider_refund_id: null,
      status: 'refunded'
    })
    f.provider.setRefunds('pi_claim', [
      { ...newer, status: 'failed' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_newer_failed',
        refundId: 're_newer'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_newer',
      status: 'refunded'
    })
    f.provider.setRefunds('pi_claim', [
      third,
      { ...newer, status: 'failed' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_third_refunded',
        requestKey: 'dashboard-request-third'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: null,
      provider_refund_id: 're_third',
      status: 'refunded'
    })
    f.provider.setRefunds('pi_claim', [
      third,
      { ...newer, status: 'failed' },
      { ...older, status: 'failed' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_older_failed',
        refundId: 're_older'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_older',
      status: 'refunded'
    })
    const sent = [
      await refundFailedKey('ord_claim', 're_newer'),
      await refundFailedKey('ord_claim', 're_older'),
      'payment-alert:refunded:ord_claim'
    ].sort()
    expect(alerts(f)).toEqual(sent)
    // A retried report of that failure keeps the refund the order records, and it and the sweep's
    // resend send nothing more.
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_older_failed_again',
        refundId: 're_older'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: 'refund_failed',
      provider_refund_id: 're_older',
      status: 'refunded'
    })
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(alerts(f)).toEqual(sent)
  })

  // #516's review: the same sequence, but the older refund's email fails to send (useSend down) and
  // marking its report processed fails, so Stripe delivers it again. The flagged order records that
  // refund already, so the report processed again keeps it: its retry and the sweep's resend send
  // the email under that refund's key, where recording the newest failed one (the newer, whose
  // email went out) sent nothing.
  it('sends an older refund’s failed email when its report is processed again, keyed on the refund the order records (#514)', async () => {
    const f = fixture()
    claimedListing(f)
    const sender = createCapturingEmailSender()
    const service = createEmailService({
      ledger: createEmailDeliveryLedger({ client: f.client }),
      log: () => undefined,
      policy: resolveEmailPolicy({ D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }),
      sender,
      templates: appEmailTemplates,
      waitUntil: () => undefined
    })
    f.deps.notify = async (template, request) => {
      await service.deliver(template, request)
    }
    const newer = { amountCents: 2450, id: 're_newer', orderId: null }
    const older = { amountCents: 2450, id: 're_older', orderId: null }
    const third = { amountCents: 2450, id: 're_third', orderId: null, status: 'succeeded' as const }
    const flag = 'SELECT status, attention, provider_refund_id FROM orders'
    f.provider.setRefunds('pi_claim', [
      { ...newer, status: 'pending' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', { id: 'evt_refunded', requestKey: 'dash-1' })
    )
    f.provider.setRefunds('pi_claim', [
      { ...newer, status: 'failed' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_newer_failed',
        refundId: 're_newer'
      })
    )
    f.provider.setRefunds('pi_claim', [
      third,
      { ...newer, status: 'failed' },
      { ...older, status: 'pending' }
    ])
    await webhook(
      f,
      paymentEvent('payment_refunded', 'pi_claim', {
        id: 'evt_third_refunded',
        requestKey: 'dash-3'
      })
    )
    expect(f.row(flag)).toEqual({
      attention: null,
      provider_refund_id: 're_third',
      status: 'refunded'
    })
    f.provider.setRefunds('pi_claim', [
      third,
      { ...newer, status: 'failed' },
      { ...older, status: 'failed' }
    ])
    const olderKey = await refundFailedKey('ord_claim', 're_older')
    const olderEmail = () =>
      f.rows(`SELECT status, attempts FROM email_deliveries WHERE event_key='${olderKey}'`)
    const olderFailed = paymentEvent('payment_refund_failed', 'pi_claim', {
      id: 'evt_older_failed',
      refundId: 're_older'
    })
    // The first delivery flags the order and its email fails; marking it processed fails too.
    sender.failNext(new Error('useSend is down'))
    const finishEvent = f.deps.operations.finishEvent
    f.deps.operations.finishEvent = async () => {
      f.deps.operations.finishEvent = finishEvent
      throw new Error('D1 unavailable')
    }
    const first = deliver(f, olderFailed)
    await expect(first.answer).rejects.toThrow('D1 unavailable')
    await first.settled()
    const flaggedOlder = {
      attention: 'refund_failed',
      provider_refund_id: 're_older',
      status: 'refunded'
    }
    expect(f.row(flag)).toEqual(flaggedOlder)
    expect(olderEmail()).toEqual([{ attempts: 1, status: 'failed' }])
    // Stripe delivers it again: the order keeps that refund, and the retry sends under its key
    // (useSend still down).
    sender.failNext(new Error('useSend is down'))
    await expect(webhook(f, olderFailed)).resolves.toEqual({
      body: { received: true },
      status: 200
    })
    expect(f.row(flag)).toEqual(flaggedOlder)
    expect(olderEmail()).toEqual([{ attempts: 2, status: 'failed' }])
    // The sweep's resend names the same refund and sends it, once.
    f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
    await runBillingSweep(f.deps, { limit: 10 })
    await runBillingSweep(f.deps, { limit: 10 })
    expect(f.row(flag)).toEqual(flaggedOlder)
    expect(olderEmail()).toEqual([{ attempts: 3, status: 'sent' }])
    const adminEmails = f.rows<{ event_key: string; status: string }>(
      `SELECT event_key, status FROM email_deliveries WHERE template_id='admin-payment-alert'`
    )
    expect(adminEmails.map(row => `${row.event_key} ${row.status}`).sort()).toEqual(
      [
        `${await refundFailedKey('ord_claim', 're_newer')} sent`,
        `${olderKey} sent`,
        'payment-alert:refunded:ord_claim sent'
      ].sort()
    )
    expect(sender.sent.filter(message => message.to === 'devin@serp.co')).toHaveLength(3)
  })

  // #516's review: Stripe delivers the site refund's failure again (its first delivery flagged the
  // order and emailed, then answered 500), and while the retry asks Stripe, a dashboard refund's
  // own failure is recorded and its email fails to send. The retry decided on the order as read
  // before that, so it would record the site's refund over the dashboard's, and the sweep, keyed on
  // the recorded refund, would never resend the dashboard refund's email. The flag write compares
  // and swaps on `updated_at`, so the retry reads both again, keeps the dashboard refund, and sends
  // its email. Both reads that can be stale: the order flagged with the refund the report names,
  // and not flagged (the dashboard refund cleared the flag before it failed).
  it.each([
    ['flagged with the refund the report names', false],
    ['not flagged, a dashboard refund having cleared it', true]
  ])(
    'keeps a newer failed refund recorded while a retried report reads Stripe on an order %s, and resends its email (#516)',
    async (_, clearFirst) => {
      const f = fixture()
      claimedListing(f)
      const sender = createCapturingEmailSender()
      const service = createEmailService({
        ledger: createEmailDeliveryLedger({ client: f.client }),
        log: () => undefined,
        policy: resolveEmailPolicy({
          D1_RUNTIME_ENV: 'production',
          SITE_ENVIRONMENT: 'production'
        }),
        sender,
        templates: appEmailTemplates,
        waitUntil: () => undefined
      })
      f.deps.notify = async (template, request) => {
        await service.deliver(template, request)
      }
      const flag = 'SELECT status, attention, provider_refund_id FROM orders'
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
        id: 'evt_failed',
        refundId: 're_1'
      })
      f.refundsUnreachable.value = true
      await webhook(f, failed).catch(() => undefined)
      f.refundsUnreachable.value = false
      if (clearFirst) {
        f.provider.setRefunds('pi_claim', [
          { amountCents: 4900, id: 're_dash', orderId: null, status: 'pending' },
          { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
        ])
        await webhook(
          f,
          paymentEvent('payment_refunded', 'pi_claim', {
            id: 'evt_dash_refunded',
            requestKey: 'dashboard-request'
          })
        )
      }
      expect(f.row(flag)).toEqual(
        clearFirst
          ? { attention: null, provider_refund_id: 're_dash', status: 'refunded' }
          : { attention: 'refund_failed', provider_refund_id: 're_1', status: 'refunded' }
      )
      f.provider.setRefunds('pi_claim', [
        { amountCents: 4900, id: 're_dash', orderId: null, status: 'failed' },
        { amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }
      ])
      const read = f.provider.paymentRefunds
      let reads = 0
      f.provider.paymentRefunds = async paymentId => {
        reads += 1
        if (reads > 1) return read(paymentId)
        f.clock.now = new Date(f.clock.now.getTime() + 1000)
        sender.failNext(new Error('useSend is down'))
        await webhook(
          f,
          paymentEvent('payment_refund_failed', 'pi_claim', {
            id: 'evt_dash_failed',
            refundId: 're_dash'
          })
        )
        return read(paymentId)
      }
      const dashKey = await refundFailedKey('ord_claim', 're_dash')
      const email = (key: string) =>
        f.rows(`SELECT status, attempts FROM email_deliveries WHERE event_key='${key}'`)
      const flaggedDash = {
        attention: 'refund_failed',
        provider_refund_id: 're_dash',
        status: 'refunded'
      }
      await expect(webhook(f, failed)).resolves.toEqual({ body: { received: true }, status: 200 })
      // The retry's first decision lost the write and asked Stripe again (the dashboard refund's
      // report read it once in between).
      expect(reads).toBe(3)
      expect(f.row(flag)).toEqual(flaggedDash)
      expect(email(dashKey)).toEqual([{ attempts: 2, status: 'sent' }])
      f.clock.now = new Date(f.clock.now.getTime() + 30 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(f.row(flag)).toEqual(flaggedDash)
      expect(email(dashKey)).toEqual([{ attempts: 2, status: 'sent' }])
      expect(email(await refundFailedKey('ord_claim', 're_1'))).toEqual([
        { attempts: 1, status: 'sent' }
      ])
    }
  )

  // #516's review: a refund.failed's flag keeps losing its compare and swap (the order changes on
  // every read of Stripe). After deciding again once, nothing is recorded or sent, and the delivery
  // answers 500 unprocessed, so Stripe delivers it again.
  it('records and sends nothing, and answers 500, when the order keeps changing under a refund.failed (#516)', async () => {
    const f = fixture()
    claimedListing(f)
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    const recorded = f.row<{ provider_refund_id: string | null }>(
      'SELECT provider_refund_id FROM orders'
    ).provider_refund_id
    const sent = f.emails.length
    let reads = 0
    f.provider.paymentRefunds = async () => {
      reads += 1
      f.clock.now = new Date(f.clock.now.getTime() + 1000)
      f.db.exec(`UPDATE orders SET updated_at='${f.clock.now.toISOString()}'`)
      return [{ amountCents: 4900, id: 're_1', orderId: 'ord_claim', status: 'failed' }]
    }
    const failed = paymentEvent('payment_refund_failed', 'pi_claim', {
      id: 'evt_failed',
      refundId: 're_1'
    })
    await expect(webhook(f, failed)).rejects.toMatchObject({
      code: 'billing_payment_change_not_recorded'
    })
    expect(reads).toBe(2)
    expect(f.row('SELECT status, attention, provider_refund_id FROM orders')).toEqual({
      attention: null,
      provider_refund_id: recorded,
      status: 'refunded'
    })
    expect(f.emails.slice(sent)).toEqual([])
    expect(processed(f, 'evt_failed')).toBe(false)
  })

  // #503: the sweep sends a failed refund's email again only while the order is flagged. Once a
  // refund cleared the flag, the order records that refund, whose own failure needs its own email.
  it.each([
    ['the order is still flagged', false],
    ['a refund cleared the flag since', true]
  ] as const)(
    'sends a failed refund’s email again from the sweep only while %s (#503)',
    async (_state, cleared) => {
      const f = fixture()
      claimedListing(f)
      await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
      await webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId: 're_1' }))
      if (cleared) {
        await webhook(
          f,
          paymentEvent('payment_refunded', 'pi_claim', {
            id: 'evt_refunded_again',
            requestKey: 'dashboard-request'
          })
        )
      }
      f.emails.length = 0
      f.clock.now = new Date(NOW.getTime() + 30 * 60 * 1000)
      await runBillingSweep(f.deps, { limit: 10 })
      expect(alerts(f)).toEqual(cleared ? [] : [await refundFailedKey('ord_claim', 're_1')])
      if (!cleared) return
      // The refund that cleared it fails: its own email goes out.
      await webhook(
        f,
        paymentEvent('payment_refund_failed', 'pi_claim', {
          id: 'evt_dashboard_failed',
          refundId: 're_2'
        })
      )
      expect(alerts(f)).toEqual([await refundFailedKey('ord_claim', 're_2')])
    }
  )

  // #503: a Stripe refund id has capitals, which the email ledger's key can't hold, so the key
  // carries it hashed, and the real key builder takes it.
  it('keys a failed refund’s email on a Stripe refund id in a form the email ledger takes (#503)', async () => {
    const f = fixture()
    f.deps.eventKey = emailEventKey
    claimedListing(f)
    const refundId = 're_3PqXyZ2eZvKYlo2C0aBcDeFg'
    f.provider.refund = async () => ({ refundId })
    await refundOrder(f.deps, { actor: 'devin@serp.co', orderId: 'ord_claim' })
    f.provider.setRefunds('pi_claim', [
      { amountCents: 4900, id: refundId, orderId: 'ord_claim', status: 'failed' }
    ])
    await expect(
      webhook(f, paymentEvent('payment_refund_failed', 'pi_claim', { refundId }))
    ).resolves.toEqual({ body: { received: true }, status: 200 })
    // The real key builder throws on a key the ledger can't hold, which would answer it 500.
    expect(alerts(f)).toEqual([await refundFailedKey('ord_claim', refundId)])
  })
})
