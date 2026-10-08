/**
 * The billing service (#68) on node:sqlite with the checked-in migrations and a fake provider:
 * a checkout opens once per target; a payment is recorded and applied once however it arrives
 * (webhook, replay, return, sweep); guardrails publish or hold a paid submission; a payment its
 * target can't accept is refunded; upgrades and relists apply to the listing; and refunds follow
 * the rejection or the badge check at refund.
 */

import { describe, expect, it } from 'vitest'
import { createBadgeProgramOperations } from '@/db/badge-program'
import { createBillingOperations } from '@/db/billing'
import { createDatabase } from '@/db/client'
import { executePlans } from '@/db/plan-runner'
import { prepareCatalogPublication } from '@/db/plan-support'
import { buildRejectSubmissionPlans } from '@/db/submission-plans'
import { insertPublishedListing, SqliteD1 } from '@/db/test-support'
import { checkBadgeAtRefund } from '../badge-program/refund'
import { features, type SiteFeatures } from '../features'
import type { GuardrailResult } from './guardrails'
import { createPaidClaims } from './paid-claims'
import {
  type BillingEvent,
  type BillingProvider,
  BillingWebhookError,
  type CheckoutState,
  type RefundRequest
} from './provider'
import {
  type BillingDependencies,
  confirmReturn,
  handleWebhook,
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
  let created = 0
  const provider: BillingProvider & {
    pay(checkoutId: string, charged?: number): CheckoutState
  } = {
    async createCheckout(request) {
      created += 1
      const checkoutId = `cs_${created}`
      sessions.set(checkoutId, {
        amountCents: request.amountCents,
        checkoutId,
        currency: request.currency,
        orderId: request.orderId,
        paymentId: null,
        state: 'open'
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
    pay(checkoutId, charged) {
      const session = sessions.get(checkoutId)
      if (!session) throw new Error('unknown session')
      const paid = {
        ...session,
        amountCents: charged ?? session.amountCents,
        paymentId: `pi_${checkoutId}`,
        state: 'paid' as const
      }
      sessions.set(checkoutId, paid)
      return paid
    },
    async refund(request) {
      refundSeen.count += 1
      if (refuseRefunds.value) throw new Error('charge_disputed')
      if (failNextRefund.value) {
        failNextRefund.value = false
        throw new Error('provider down')
      }
      refunds.push(request)
      return { refundId: `re_${refunds.length}` }
    },
    async verifyWebhook({ body }) {
      const event = JSON.parse(body) as BillingEvent & { forged?: boolean }
      if (event.forged) throw new BillingWebhookError('bad signature')
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
  const { expired, expireFails, failNextRefund, provider, refundSeen, refunds, refuseRefunds } =
    fakeProvider()
  const clock = { now: NOW }
  const badgeChecks = { count: 0 }
  const emails: Array<{ eventKey: string; template: string; to: string }> = []
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
      emails.push({ eventKey: request.eventKey, template, to: request.to })
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

const webhook = (f: Fixture, body: string) =>
  handleWebhook(f.deps, { body, headers: new Headers() })

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
    expect(f.rows('SELECT outcome, processed_at IS NOT NULL AS done FROM billing_events')).toEqual([
      { done: 1, outcome: 'published' }
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
    // 20 minutes left: shorter than the shortest checkout.
    f.db.exec(`UPDATE listing_claims SET email_verified_at='2026-10-05T12:20:00.000Z'`)
    await expect(
      startClaimCheckout(f.deps, { ...claim, email: 'maya@example.com', origin: ORIGIN })
    ).resolves.toMatchObject({ ok: false, status: 409 })
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
})

describe('refunds', () => {
  async function paidLive(f: Fixture): Promise<string> {
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    return f.row<{ id: string }>('SELECT id FROM orders').id
  }

  it('refunds a paid submission rejected as other, once, with its email', async () => {
    const f = fixture()
    await paidLive(f)
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
