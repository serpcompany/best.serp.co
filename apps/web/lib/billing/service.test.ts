/**
 * The billing service (#68) on node:sqlite with the checked-in migrations and a fake provider:
 * a checkout opens once per target; a payment is recorded and applied once however it arrives
 * (webhook, replay, return, sweep); guardrails publish or hold a paid submission; a payment its
 * target can't accept is refunded; upgrades and relists apply to the listing; and refunds follow
 * the rejection or the badge check at refund.
 */
import { createBadgeProgramOperations } from '@serpdirectory/data-ops/badge-program'
import { createBillingOperations } from '@serpdirectory/data-ops/billing'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { executePlans } from '@serpdirectory/data-ops/plan-runner'
import { prepareCatalogPublication } from '@serpdirectory/data-ops/plan-support'
import { buildRejectSubmissionPlans } from '@serpdirectory/data-ops/submission-plans'
import { insertPublishedListing, SqliteD1 } from '@serpdirectory/data-ops/test-support'
import { describe, expect, it } from 'vitest'
import { checkBadgeAtRefund } from '../badge-program/refund'
import type { GuardrailResult } from './guardrails'
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
  refundOrder,
  refundRejectedSubmission,
  runBillingSweep,
  startListingCheckout,
  startSubmissionCheckout
} from './service'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const ORIGIN = 'https://best.serp.co'

function fakeProvider() {
  const sessions = new Map<string, CheckoutState>()
  const refunds: RefundRequest[] = []
  const expired: string[] = []
  /** Throws on the next refund (the provider was down). */
  const failNextRefund = { value: false }
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
    async expireCheckout(checkoutId) {
      expired.push(checkoutId)
      const session = sessions.get(checkoutId)
      if (session?.state === 'open') sessions.set(checkoutId, { ...session, state: 'expired' })
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
  return { expired, failNextRefund, provider, refunds, sessions }
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
  const { expired, failNextRefund, provider, refunds } = fakeProvider()
  const badgeChecks = { count: 0 }
  const emails: Array<{ eventKey: string; template: string; to: string }> = []
  let ids = 0
  const deps: BillingDependencies = {
    adminRecipient: 'devin@serp.co',
    badgeAtRefund: listingId => {
      badgeChecks.count += 1
      return checkBadgeAtRefund({
        listingId,
        now: NOW,
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
    now: () => NOW,
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
    db,
    deps,
    emails,
    expired,
    failNextRefund,
    listing,
    provider,
    refunds,
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
    providerType: 'checkout.session.completed',
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
        providerType: 'checkout.session.completed',
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
        providerType: 'checkout.session.completed',
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

  it('records the refund and flags the order when the listing change keeps failing', async () => {
    const f = fixture({ badge: 'pass' })
    f.submission('s1', 'draft', null)
    await webhook(f, paidEvent(f, await checkout(f, 's1')))
    f.db.exec(`UPDATE listing_submissions SET status='approved' WHERE id='s1'`)
    const order = f.row<{ id: string }>('SELECT id FROM orders')
    f.failNextRefund.value = true
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).rejects.toThrow()
    // The badge check at refund aged out before the retry: keep_free can't apply any more.
    f.db.exec(`UPDATE badge_checks SET checked_at='2026-10-06T09:00:00.000Z'`)
    await expect(
      refundOrder(f.deps, { actor: 'devin@serp.co', orderId: order.id })
    ).resolves.toEqual({
      listing: 'pending',
      ok: true,
      replayed: false
    })
    expect(f.row('SELECT status, attention FROM orders')).toEqual({
      attention: 'listing_update_failed',
      status: 'refunded'
    })
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
  it('records a payment that reached a superseded checkout and finishes claimed refunds', async () => {
    const f = fixture()
    f.submission('s1', 'pending_badge', 'free')
    const first = await checkout(f, 's1')
    f.db.exec(`UPDATE orders SET checkout_expires_at='2026-10-06T12:01:00.000Z'`)
    await checkout(f, 's1')
    // The superseded checkout was paid anyway and its webhook never arrived.
    f.provider.pay(first)
    f.db.exec(`UPDATE orders SET failed_at='2026-10-06T11:00:00.000Z' WHERE status='failed'`)
    await runBillingSweep(f.deps, { limit: 10 })
    expect(
      f.rows(`SELECT status, outcome FROM orders WHERE provider_checkout_id='${first}'`)
    ).toEqual([{ outcome: 'published', status: 'paid' }])
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
      refunds: 0
    })
    expect(f.rows(`SELECT target_key, status, outcome FROM orders ORDER BY target_key`)).toEqual([
      { outcome: null, status: 'failed', target_key: 'submission:s1' },
      { outcome: 'published', status: 'paid', target_key: 'submission:s2' }
    ])
  })
})
