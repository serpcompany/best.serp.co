import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  ADMIN_EMAIL_PREFIXES,
  type Client,
  client,
  q,
  removeAdmin,
  removeLeftoverAdmins,
  signIn,
  signInAsNewAdmin,
  unique
} from './admin-fixture'
import {
  billingD1,
  billingOrigin,
  billingServer,
  billingSuiteEnabled,
  type StripeMock,
  startStripeMock,
  stripeSignatureHeader
} from './billing-fixture'
import { type FixtureProduct, type FixtureSite, startFixtureSite } from './submit-fixture'

/**
 * Paid listings (serpcompany/best.serp.co#68) end to end, against a mocked Stripe on a local
 * Worker with orders on (`billing-fixture.ts`):
 * - checkout success: a draft pays on the provider's page, and the return lands on the account
 *   with the listing live and in the review queue; the late webhook changes nothing;
 * - checkout cancel: back to the plan choice, the draft kept, the same checkout reused;
 * - the webhook: verified (signature and timestamp), and a replayed event is a no-op;
 * - upgrade: a live free listing's "Upgrade: $49 one-off" makes it paid;
 * - refunds from Orders: the badge is checked once at refund; a pass keeps the listing live as
 *   free, a miss unpublishes it (410);
 * - a paid submission rejected as `other` is refunded automatically.
 */

test.skip(!billingSuiteEnabled, 'needs the local orders Worker from playwright.config.ts')
test.describe.configure({ mode: 'serial' })
test.use({ baseURL: billingOrigin(), channel: 'chromium' })

let stripe: StripeMock
let site: FixtureSite

test.beforeAll(async () => {
  stripe = await startStripeMock()
  site = await startFixtureSite()
  billingD1(`
    INSERT OR IGNORE INTO publication_state (id, version, checksum) VALUES (1, 0, 'e2e-billing');
    INSERT OR IGNORE INTO categories (slug, name, description, sort_order)
      VALUES ('e2e-billing-tools', 'E2E Billing Tools', 'Tools for the orders suite.', 0);
  `)
  removeLeftoverAdmins([ADMIN_EMAIL_PREFIXES.billing], billingServer)
})

test.afterAll(async () => {
  await stripe?.close()
  await site?.close()
})

function product(name: string, badge: FixtureProduct['badge']): FixtureProduct {
  return { badge, description: `${name}, a fixture product.`, name }
}

/** Signs a fresh submitter in, in the page's browser context, and returns their user id. */
async function signInSubmitter(page: Page, label: string): Promise<{ email: string; id: string }> {
  const email = `e2e-billing-${label}-${unique()}@example.com`
  await signIn(client(page.request, billingOrigin()), email)
  const [user] = billingD1<{ id: string }>(`SELECT id FROM users WHERE email = ${q(email)}`)
  if (!user) throw new Error('the submitter was not created')
  return { email, id: user.id }
}

/** A draft with no plan chosen, saved today, on a fixture website. */
function seedDraft(userId: string, label: string, badge: FixtureProduct['badge'] = 'missing') {
  const key = `${label}-${unique()}`
  site.set(key, product(`Paid ${key.slice(-5)}`, badge))
  const slug = site.slug(key)
  const id = crypto.randomUUID()
  billingD1(`
    INSERT INTO listing_submissions (id, slug, name, description, website, content, category_slug,
      logo_url, status, plan, owner_user_id, draft_saved_at, block_key, block_covers_subdomains)
    VALUES (${q(id)}, ${q(slug)}, ${q(`Paid ${key.slice(-5)}`)}, 'A fixture for the orders suite.',
      ${q(site.website(key))}, 'Long content.', 'e2e-billing-tools',
      ${q(`${site.website(key)}icon.png`)}, 'draft', NULL, ${q(userId)}, ${q(new Date().toISOString())},
      ${q(slug)}, 1);
  `)
  return { id, key, slug }
}

/** An approved free submission's live listing, owned by the user. */
function seedFreeListing(userId: string, label: string) {
  const key = `${label}-${unique()}`
  site.set(key, product(`Free ${key.slice(-5)}`, 'valid'))
  const slug = site.slug(key)
  const listingId = `e2e-billing-lst-${key}`
  billingD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum, source)
    VALUES (${q(listingId)}, ${q(slug)}, ${q(`Free ${key.slice(-5)}`)}, 'A free listing.',
      ${q(site.website(key))}, 'Content.', 'draft', '2026-05-16', 'e2e', ${q(listingId)},
      ${q(`e2e-${key}`)}, 'submission');
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(listingId)}, id, 0, 1 FROM categories WHERE slug = 'e2e-billing-tools';
    UPDATE listings SET status = 'approved' WHERE id = ${q(listingId)};
    INSERT INTO listing_submissions (id, slug, name, description, website, content,
      category_slug, logo_url, status, plan, listing_id, owner_user_id, block_key,
      block_covers_subdomains)
    VALUES (${q(crypto.randomUUID())}, ${q(slug)}, ${q(`Free ${key.slice(-5)}`)}, 'A free listing.',
      ${q(site.website(key))}, 'Content.', 'e2e-billing-tools', ${q(`${site.website(key)}icon.png`)},
      'approved', 'free', ${q(listingId)}, ${q(userId)}, ${q(slug)}, 1);
    INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES (${q(listingId)}, ${q(userId)}, 'submission', ${q(new Date().toISOString())});
  `)
  return { key, listingId, slug }
}

function order(where: string) {
  const [row] = billingD1<{
    id: string
    outcome: string | null
    provider_checkout_id: string | null
    purpose: string
    refund_reason: string | null
    status: string
  }>(
    `SELECT id, purpose, status, outcome, refund_reason, provider_checkout_id FROM orders
      WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 1`
  )
  if (!row) throw new Error(`no order where ${where}`)
  return row
}

async function emailSubjects(request: APIRequestContext, to: string): Promise<string[]> {
  const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { messages: Array<{ subject: string }> }).messages.map(
    message => message.subject
  )
}

async function postEvent(
  request: APIRequestContext,
  body: string,
  signature = stripeSignatureHeader(body)
) {
  return request.post('/api/billing/webhook/', {
    data: body,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature }
  })
}

function completedEvent(sessionId: string, eventId = `evt_e2e_${unique()}`): string {
  return JSON.stringify({
    data: { object: stripe.pay(sessionId) },
    id: eventId,
    livemode: false,
    object: 'event',
    type: 'checkout.session.completed'
  })
}

/** Opens a checkout through the Worker without a browser, and returns the mock session id. */
async function openCheckout(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path, { maxRedirects: 0 })
  expect(response.status(), await response.text()).toBe(303)
  const location = response.headers().location ?? ''
  expect(location).toContain('/pay/')
  return location.split('/').pop() ?? ''
}

test('checkout success: paid at Stripe, live at once and in the review queue', async ({ page }) => {
  const submitter = await signInSubmitter(page, 'success')
  const draft = seedDraft(submitter.id, 'success')
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/pay\/cs_test_/u)
  await page.getByRole('button', { name: 'Pay' }).click()
  await expect(page).toHaveURL(new RegExp(`/account/submissions/${draft.id}/$`, 'u'))

  expect(
    billingD1(`SELECT status, plan FROM listing_submissions WHERE id = ${q(draft.id)}`)
  ).toEqual([{ plan: 'paid', status: 'paid_pending_review' }])
  const paid = order(`submission_id = ${q(draft.id)}`)
  expect(paid).toMatchObject({ outcome: 'published', purpose: 'submission', status: 'paid' })
  expect((await page.request.get(`/products/${draft.slug}/`)).status()).toBe(200)
  // In the admin review queue as paid and live.
  expect(
    billingD1(
      `SELECT COUNT(*) AS n FROM listing_submissions WHERE status = 'paid_pending_review' AND id = ${q(draft.id)}`
    )
  ).toEqual([{ n: 1 }])
  await expect
    .poll(() => emailSubjects(page.request, submitter.email))
    .toContainEqual(expect.stringMatching(/is live on SERP$/u))

  // The webhook arrives after the return: recorded, and nothing changes.
  const late = await postEvent(page.request, completedEvent(paid.provider_checkout_id ?? ''))
  expect(late.status()).toBe(200)
  expect(billingD1(`SELECT COUNT(*) AS n FROM listings WHERE slug = ${q(draft.slug)}`)).toEqual([
    { n: 1 }
  ])
  expect(order(`id = ${q(paid.id)}`)).toMatchObject({ outcome: 'published', status: 'paid' })
})

test('checkout cancel: back to the plan choice, the draft kept, the checkout reused', async ({
  page
}) => {
  const submitter = await signInSubmitter(page, 'cancel')
  const draft = seedDraft(submitter.id, 'cancel')
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
  const first = page.url().split('/').pop()
  await page.getByRole('link', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(new RegExp(`/submit/${draft.id}/choose/$`, 'u'))
  await expect(page.getByRole('heading', { name: 'Choose how to get listed' })).toBeVisible()
  expect(
    billingD1(`SELECT status, plan, paid_at FROM listing_submissions WHERE id = ${q(draft.id)}`)
  ).toEqual([{ paid_at: null, plan: 'paid', status: 'draft' }])
  expect(order(`submission_id = ${q(draft.id)}`)).toMatchObject({ status: 'pending' })

  // Paying again reuses the open checkout instead of opening a second payment.
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
  expect(page.url().split('/').pop()).toBe(first)
  expect(
    billingD1(`SELECT COUNT(*) AS n FROM orders WHERE submission_id = ${q(draft.id)}`)
  ).toEqual([{ n: 1 }])
})

test('webhook replay: verified events are processed once; forged and stale ones are refused', async ({
  page
}) => {
  const submitter = await signInSubmitter(page, 'replay')
  const draft = seedDraft(submitter.id, 'replay')
  const sessionId = await openCheckout(page.request, `/submit/${draft.id}/checkout/`)
  const body = completedEvent(sessionId)

  const forged = await postEvent(page.request, body, stripeSignatureHeader(`${body} `))
  expect(forged.status()).toBe(400)
  const stale = await postEvent(
    page.request,
    body,
    stripeSignatureHeader(body, Math.floor(Date.now() / 1000) - 600)
  )
  expect(stale.status()).toBe(400)
  expect(order(`submission_id = ${q(draft.id)}`)).toMatchObject({ status: 'pending' })

  const first = await postEvent(page.request, body)
  expect(first.status()).toBe(200)
  expect(await first.json()).toEqual({ received: true })
  const replay = await postEvent(page.request, body)
  expect(replay.status()).toBe(200)
  expect(await replay.json()).toEqual({ received: true, replayed: true })

  const paid = order(`submission_id = ${q(draft.id)}`)
  expect(paid).toMatchObject({ outcome: 'published', status: 'paid' })
  expect(billingD1(`SELECT COUNT(*) AS n FROM listings WHERE slug = ${q(draft.slug)}`)).toEqual([
    { n: 1 }
  ])
  expect(
    billingD1(
      `SELECT outcome, processed_at IS NOT NULL AS done FROM billing_events WHERE order_id = ${q(paid.id)}`
    )
  ).toEqual([{ done: 1, outcome: 'published' }])
})

async function upgrade(page: Page, slug: string): Promise<void> {
  await page.goto(`/account/listings/${slug}/`)
  await page.getByRole('link', { name: 'Upgrade: $49 one-off' }).click()
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
  await page.getByRole('button', { name: 'Pay' }).click()
  await expect(page).toHaveURL(
    // A paid listing has no badge panel: its account page opens the listing's edit page.
    new RegExp(`/account/listings/${slug.replaceAll('.', '\\.')}/(?:edit/)?$`, 'u')
  )
}

const upgraded: Array<{ key: string; listingId: string; slug: string }> = []

test('upgrade: a live free listing becomes a paid listing', async ({ page }) => {
  const owner = await signInSubmitter(page, 'upgrade')
  for (const label of ['upgrade-pass', 'upgrade-miss']) {
    const listing = seedFreeListing(owner.id, label)
    await upgrade(page, listing.slug)
    expect(
      billingD1(
        `SELECT plan, paid_at IS NOT NULL AS paid FROM listing_submissions WHERE listing_id = ${q(listing.listingId)}`
      )
    ).toEqual([{ paid: 1, plan: 'paid' }])
    expect(order(`listing_id = ${q(listing.listingId)}`)).toMatchObject({
      outcome: 'upgraded',
      purpose: 'upgrade',
      status: 'paid'
    })
    upgraded.push(listing)
  }
})

async function refundFromOrders(page: Page, orderId: string, toast: RegExp): Promise<void> {
  await page.goto('/admin/orders/')
  await page
    .locator(`tr[data-order="${orderId}"]`)
    .getByRole('button', { name: 'Open menu for this order' })
    .click()
  await page.getByRole('menuitem', { name: 'Refund' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('We check the badge')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Refund' }).click()
  await expect(page.getByText(toast)).toBeVisible()
}

async function asAdmin(page: Page): Promise<string> {
  const account: Client = client(page.request, billingOrigin())
  return signInAsNewAdmin(account, ADMIN_EMAIL_PREFIXES.billing, billingServer)
}

test('refund with a badge pass: the listing stays live as a free listing', async ({ page }) => {
  const listing = upgraded[0]
  if (!listing) throw new Error('the upgrade test runs first')
  const admin = await asAdmin(page)
  try {
    const paid = order(`listing_id = ${q(listing.listingId)}`)
    await refundFromOrders(
      page,
      paid.id,
      /^Refunded \$49\.00\. .* stays live as a free listing\.$/u
    )
    expect(order(`id = ${q(paid.id)}`)).toMatchObject({
      refund_reason: 'admin',
      status: 'refunded'
    })
    expect(
      billingD1(
        `SELECT s.plan, l.is_active FROM listing_submissions s JOIN listings l ON l.id = s.listing_id WHERE l.id = ${q(listing.listingId)}`
      )
    ).toEqual([{ is_active: 1, plan: 'free' }])
    expect(
      billingD1(`SELECT kind, outcome FROM badge_checks WHERE listing_id = ${q(listing.listingId)}`)
    ).toEqual([{ kind: 'refund', outcome: 'pass' }])
    expect(stripe.refunds).toContainEqual(expect.objectContaining({ amount: 4900 }))
  } finally {
    removeAdmin(admin, billingServer)
  }
})

test('refund with a badge miss: the listing is unpublished (410)', async ({ page }) => {
  const listing = upgraded[1]
  if (!listing) throw new Error('the upgrade test runs first')
  site.update(listing.key, { badge: 'missing' })
  const admin = await asAdmin(page)
  try {
    const paid = order(`listing_id = ${q(listing.listingId)}`)
    await refundFromOrders(page, paid.id, /^Refunded \$49\.00\. .* was unpublished\.$/u)
    expect(order(`id = ${q(paid.id)}`)).toMatchObject({ status: 'refunded' })
    expect(billingD1(`SELECT is_active FROM listings WHERE id = ${q(listing.listingId)}`)).toEqual([
      { is_active: 0 }
    ])
    expect(
      billingD1(`SELECT kind, outcome FROM badge_checks WHERE listing_id = ${q(listing.listingId)}`)
    ).toEqual([{ kind: 'refund', outcome: 'fail' }])
    await expect
      .poll(async () => (await page.request.get(`/products/${listing.slug}/`)).status())
      .toBe(410)
  } finally {
    removeAdmin(admin, billingServer)
  }
})

test('a paid submission rejected as other is refunded automatically', async ({ page }) => {
  const submitter = await signInSubmitter(page, 'reject')
  const draft = seedDraft(submitter.id, 'reject')
  const sessionId = await openCheckout(page.request, `/submit/${draft.id}/checkout/`)
  expect((await postEvent(page.request, completedEvent(sessionId))).status()).toBe(200)
  const paid = order(`submission_id = ${q(draft.id)}`)
  expect(paid).toMatchObject({ outcome: 'published', status: 'paid' })

  const admin = await asAdmin(page)
  try {
    const rejected = await page.request.post(`/api/admin/submissions/${draft.id}/reject`, {
      data: { category: 'other', reason: 'Not a software product.' },
      headers: { origin: billingOrigin() }
    })
    expect(await rejected.json()).toMatchObject({ ok: true, refunded: true })
    expect(order(`id = ${q(paid.id)}`)).toMatchObject({
      refund_reason: 'rejected',
      status: 'refunded'
    })
    expect(
      billingD1(
        `SELECT status, refunded_at IS NOT NULL AS refunded FROM listing_submissions WHERE id = ${q(draft.id)}`
      )
    ).toEqual([{ refunded: 1, status: 'rejected' }])
    await expect
      .poll(() => emailSubjects(page.request, submitter.email))
      .toContainEqual(expect.stringMatching(/and we’ve refunded you$/u))
  } finally {
    removeAdmin(admin, billingServer)
  }
})
