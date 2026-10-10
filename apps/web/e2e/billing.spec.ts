import { type APIRequestContext, expect, type Page } from '@playwright/test'
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
  billingCategory,
  billingD1,
  billingOrigin,
  billingServer,
  billingSuiteEnabled,
  type StripeMock,
  seedBillingCatalog,
  seedBillingListing,
  startStripeMock,
  stripeSignatureHeader
} from './billing-fixture'
import { type FixtureProduct, type FixtureSite, startFixtureSite } from './submit-fixture'
import { test } from './test'

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

/** `BILLING_SCREENSHOT_DIRECTORY` captures each screen for review (desktop width, light). */
const screenshots = process.env.BILLING_SCREENSHOT_DIRECTORY

/**
 * Each screen of ours: the payment provider is never named on it (owner decision on #70), then
 * the optional capture.
 */
async function capture(page: Page, name: string): Promise<void> {
  expect(await page.locator('body').innerText(), name).not.toMatch(/stripe/iu)
  if (!screenshots) return
  await page.screenshot({ fullPage: true, path: `${screenshots}/${name}.png` })
}

test.beforeAll(async () => {
  stripe = await startStripeMock()
  site = await startFixtureSite()
  seedBillingCatalog()
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
      ${q(site.website(key))}, 'Long content.', ${q(billingCategory.slug)},
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
  seedBillingListing({
    checksum: `e2e-${key}`,
    content: 'Content.',
    description: 'A free listing.',
    id: listingId,
    name: `Free ${key.slice(-5)}`,
    published_at: '2026-05-16',
    slug,
    source: 'submission',
    source_identity: listingId,
    source_kind: 'e2e',
    website: site.website(key)
  })
  billingD1(`
    INSERT INTO listing_submissions (id, slug, name, description, website, content,
      category_slug, logo_url, status, plan, listing_id, owner_user_id, block_key,
      block_covers_subdomains)
    VALUES (${q(crypto.randomUUID())}, ${q(slug)}, ${q(`Free ${key.slice(-5)}`)}, 'A free listing.',
      ${q(site.website(key))}, 'Content.', ${q(billingCategory.slug)}, ${q(`${site.website(key)}icon.png`)},
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

test('checkout success: paid at checkout, live at once and in the review queue', async ({
  page
}) => {
  const submitter = await signInSubmitter(page, 'success')
  const draft = seedDraft(submitter.id, 'success')
  // 4a stays on screen while the start route is held back (a 204 keeps the browser there).
  await page.route('**/checkout/start/', route => route.fulfill({ status: 204 }))
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page.getByText('Taking you to secure checkout')).toBeVisible()
  await capture(page, '4a-handoff')
  await page.unroute('**/checkout/start/')
  // The handoff (4a) sends the browser on to the provider's checkout by itself.
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/pay\/cs_test_/u)
  await page.getByRole('button', { name: 'Pay' }).click()
  await expect(page).toHaveURL(new RegExp(`/submit/${draft.id}/checkout/return/\\?order=`, 'u'))
  await expect(page.getByRole('heading', { name: /is live on SERP$/u })).toBeVisible()
  await expect(page.getByText('Payment received', { exact: true })).toBeVisible()
  await expect(page.getByText(/^ORD-\d+$/u)).toBeVisible()
  await capture(page, '4d-live')

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

// The test-mode catalog price of a paid listing (`STRIPE_PRICES.test` in the Worker), hard-coded
// so a config change fails the suite rather than moving the expectation with it.
const TEST_LISTING_PRICE = 'price_1UOQRHCp8si97z5sqYTUNjxv'

test('promotion codes: a discounted and a 100%-off checkout both go live; a changed price never opens (#250)', async ({
  page
}) => {
  const submitter = await signInSubmitter(page, 'promo')

  // Half off: charged $24.50, live at once, and the return shows what was paid.
  const half = seedDraft(submitter.id, 'promo-half')
  const halfSession = await openCheckout(page.request, `/submit/${half.id}/checkout/start/`)
  expect(stripe.sessions.get(halfSession)?.amount_subtotal).toBe(4900)
  const halfEvent = JSON.stringify({
    data: { object: stripe.pay(halfSession, 2450) },
    id: `evt_e2e_${unique()}`,
    livemode: false,
    object: 'event',
    type: 'checkout.session.completed'
  })
  expect((await postEvent(page.request, halfEvent)).status()).toBe(200)
  const halfOrder = order(`submission_id = ${q(half.id)}`)
  expect(halfOrder).toMatchObject({ outcome: 'published', status: 'paid' })
  expect(
    billingD1(`SELECT charged_cents, attention FROM orders WHERE id = ${q(halfOrder.id)}`)
  ).toEqual([{ attention: null, charged_cents: 2450 }])
  await page.goto(`/submit/${half.id}/checkout/return/?order=${halfOrder.id}`)
  await expect(
    page.getByText('$24.50 USD, one-off ($24.50 off with a promotion code)')
  ).toBeVisible()

  // 100% off: nothing charged, no payment, still live.
  const free = seedDraft(submitter.id, 'promo-free')
  const freeSession = await openCheckout(page.request, `/submit/${free.id}/checkout/start/`)
  const freeEvent = JSON.stringify({
    data: { object: stripe.pay(freeSession, 4900) },
    id: `evt_e2e_${unique()}`,
    livemode: false,
    object: 'event',
    type: 'checkout.session.completed'
  })
  expect((await postEvent(page.request, freeEvent)).status()).toBe(200)
  const freeOrder = order(`submission_id = ${q(free.id)}`)
  expect(freeOrder).toMatchObject({ outcome: 'published', status: 'paid' })
  expect(
    billingD1(`SELECT charged_cents, provider_payment_id FROM orders WHERE id = ${q(freeOrder.id)}`)
  ).toEqual([{ charged_cents: 0, provider_payment_id: freeSession }])
  expect((await page.request.get(`/products/${free.slug}/`)).status()).toBe(200)
  // Nothing was charged, so the return page promises no receipt.
  await page.goto(`/submit/${free.id}/checkout/return/?order=${freeOrder.id}`)
  await expect(page.getByText('$0.00 USD, one-off')).toBeVisible()
  await expect(page.getByText('Receipt', { exact: true })).toHaveCount(0)

  // A 100%-off upgrade: an order the Orders screen can close (a submission in review is
  // rejected instead).
  const listing = seedFreeListing(submitter.id, 'promo-upgrade')
  const upgradeSession = await openCheckout(
    page.request,
    `/account/listings/${listing.slug}/checkout/`
  )
  const upgradeEvent = JSON.stringify({
    data: { object: stripe.pay(upgradeSession, 4900) },
    id: `evt_e2e_${unique()}`,
    livemode: false,
    object: 'event',
    type: 'checkout.session.completed'
  })
  expect((await postEvent(page.request, upgradeEvent)).status()).toBe(200)
  const upgradeOrder = order(`listing_id = ${q(listing.listingId)}`)
  expect(upgradeOrder).toMatchObject({ outcome: 'upgraded', status: 'paid' })

  // A catalog price that isn't the site's $49: no checkout opens, and the session is expired.
  stripe.prices.set(TEST_LISTING_PRICE, { amount: 9900, currency: 'usd' })
  try {
    const changed = seedDraft(submitter.id, 'promo-changed')
    const refused = await page.request.get(`/submit/${changed.id}/checkout/start/`, {
      maxRedirects: 0
    })
    expect(refused.status()).toBe(503)
    expect([...stripe.sessions.values()].at(-1)?.status).toBe('expired')
  } finally {
    stripe.prices.delete(TEST_LISTING_PRICE)
  }

  // Admin Orders: the discount under what was charged, the discounted order linking to its
  // checkout (where the code is), and the 100%-off order closed with nothing sent back.
  const admin = await asAdmin(page)
  try {
    await page.goto('/admin/orders/')
    const halfRow = page.locator(`tr[data-order="${halfOrder.id}"]`)
    await expect(halfRow.getByText('$24.50 off with a promotion code')).toBeVisible()
    await halfRow.getByRole('button', { name: /^Open menu for ORD-/u }).click()
    await expect(page.getByRole('menuitem', { name: /payment/iu })).toHaveAttribute(
      'href',
      new RegExp(`${halfSession}$`, 'u')
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(
      page.locator(`tr[data-order="${freeOrder.id}"]`).getByText('$49.00 off with a promotion code')
    ).toBeVisible()
    const freeRow = page.locator(`tr[data-order="${upgradeOrder.id}"]`)
    await freeRow.getByRole('button', { name: /^Open menu for ORD-/u }).click()
    await page.getByRole('menuitem', { name: 'Refund…' }).click()
    const close = page.getByRole('alertdialog')
    await expect(close.getByRole('heading', { name: /^Close the order/u })).toBeVisible()
    await expect(close.getByText(/nothing goes back/u)).toBeVisible()
    await close.getByLabel('Reason for the activity log').fill('Test promotion code.')
    await close.getByRole('button', { name: /^Close/u }).click()
    await expect(page.getByText(/^Closed ORD-\d+: nothing was charged$/u)).toBeVisible()
    expect(order(`id = ${q(upgradeOrder.id)}`)).toMatchObject({ status: 'refunded' })
    expect(stripe.refunds.some(refund => refund.payment_intent === upgradeSession)).toBe(false)
  } finally {
    removeAdmin(admin, billingServer)
  }
})

test('checks failed: paid, then held for review instead of going live', async ({ page }) => {
  const submitter = await signInSubmitter(page, 'held')
  const draft = seedDraft(submitter.id, 'held')
  site.update(draft.key, { status: 503 })
  await page.goto(`/submit/${draft.id}/checkout/`)
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
  await page.getByRole('button', { name: 'Pay' }).click()
  await expect(page.getByRole('heading', { name: /goes live after review$/u })).toBeVisible()
  await expect(page.getByText('Payment received, waiting for review')).toBeVisible()
  await capture(page, '4e-held')
  expect(
    billingD1(`SELECT status, plan, listing_id FROM listing_submissions WHERE id = ${q(draft.id)}`)
  ).toEqual([{ listing_id: null, plan: 'paid', status: 'verified' }])
  expect(order(`submission_id = ${q(draft.id)}`)).toMatchObject({ outcome: 'held', status: 'paid' })
  await expect
    .poll(() => emailSubjects(page.request, submitter.email))
    .toContainEqual(expect.stringMatching(/^Payment received: .* is in review$/u))
})

test('confirming, then failed: the return waits for the payment and offers to try again', async ({
  page
}) => {
  const submitter = await signInSubmitter(page, 'failed')
  const draft = seedDraft(submitter.id, 'failed')
  await openCheckout(page.request, `/submit/${draft.id}/checkout/start/`)
  const pending = order(`submission_id = ${q(draft.id)}`)
  await page.goto(`/submit/${draft.id}/checkout/return/?order=${pending.id}`)
  await expect(page.getByText('Confirming your payment…')).toBeVisible()
  await capture(page, '4c-confirming')
  billingD1(`UPDATE orders SET status = 'failed', failure_reason = 'payment_failed',
    failed_at = ${q(new Date().toISOString())} WHERE id = ${q(pending.id)}`)
  await expect(page.getByRole('heading', { name: 'Try the payment again' })).toBeVisible()
  await expect(page.getByText('Payment didn’t go through')).toBeVisible()
  await capture(page, '4g-failed')
  await page.getByRole('link', { name: 'Try again' }).click()
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
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
  await expect(page).toHaveURL(new RegExp(`/submit/${draft.id}/checkout/cancelled/$`, 'u'))
  await expect(page.getByRole('heading', { name: 'Checkout cancelled' })).toBeVisible()
  await expect(page.getByText('Not paid')).toBeVisible()
  await capture(page, '4f-cancelled')
  expect(
    billingD1(`SELECT status, plan, paid_at FROM listing_submissions WHERE id = ${q(draft.id)}`)
  ).toEqual([{ paid_at: null, plan: 'paid', status: 'draft' }])
  expect(order(`submission_id = ${q(draft.id)}`)).toMatchObject({ status: 'pending' })

  // "Return to checkout" reuses the open checkout instead of opening a second payment.
  await page.getByRole('link', { name: 'Return to checkout' }).click()
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
  const sessionId = await openCheckout(page.request, `/submit/${draft.id}/checkout/start/`)
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

async function refundFromOrders(
  page: Page,
  orderId: string,
  dialog: { button: string; screenshot: string; title: RegExp },
  toast: RegExp
): Promise<void> {
  await page.goto('/admin/orders/')
  await capture(page, '13-orders')
  await page
    .locator(`tr[data-order="${orderId}"]`)
    .getByRole('button', { name: /^Open menu for ORD-/u })
    .click()
  await capture(page, '13a-row-menu')
  await page.getByRole('menuitem', { name: 'Refund…' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByRole('heading', { name: dialog.title })).toBeVisible()
  await confirm.getByLabel('Reason for the activity log').fill('Customer asked for a refund.')
  await capture(page, dialog.screenshot)
  await confirm.getByRole('button', { name: dialog.button }).click()
  await expect(page.getByText(/^Refunded \$49\.00 for ORD-\d+$/u)).toBeVisible()
  await expect(page.getByText(toast)).toBeVisible()
  // The toast is a filled card: stock Sonner reads its colors from the theme (#241), and a
  // theme that hands it bare HSL numbers leaves it transparent.
  const shown = page.locator('[data-sonner-toast]').filter({ has: page.getByText(toast) })
  const fill = await shown.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(fill).not.toBe('rgba(0, 0, 0, 0)')
  expect(fill).not.toBe('transparent')
  await capture(page, `${dialog.screenshot}-done`)
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
      {
        button: 'Refund, keep live as free',
        screenshot: '13c-refund-badge-pass',
        title: /^Refund \$49\.00 for .*\?$/u
      },
      /^Logged under e2e-billing-admin-/u
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
    await refundFromOrders(
      page,
      paid.id,
      {
        button: 'Refund and unpublish',
        screenshot: '13b-refund-no-badge',
        title: /^Refund \$49\.00 and unpublish .*\?$/u
      },
      /was unpublished \(no passing badge\)\. Logged under e2e-billing-admin-/u
    )
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

test('a paid claim: the payment makes the claimer the owner (#67)', async ({ page }) => {
  const claimer = await signInSubmitter(page, 'claim')
  const key = `claim-${unique()}`
  site.set(key, product(`Claim ${key.slice(-5)}`, 'missing'))
  const slug = site.slug(key)
  const listingId = `e2e-billing-claim-${key}`
  const claimId = crypto.randomUUID()
  const verifiedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  seedBillingListing({
    checksum: `e2e-${key}`,
    content: 'Content.',
    description: 'A curated listing.',
    id: listingId,
    name: `Claim ${key.slice(-5)}`,
    published_at: '2026-05-16',
    slug,
    source_identity: listingId,
    source_kind: 'e2e',
    website: site.website(key)
  })
  billingD1(`
    INSERT INTO listing_claims (id, listing_id, user_id, method, status, email, email_domain,
      product_url, listing_website, code_sent_at, code_expires_at, email_verified_at)
    VALUES (${q(claimId)}, ${q(listingId)}, ${q(claimer.id)}, 'paid', 'email_verified',
      ${q(`team@${slug}`)}, ${q(slug)}, ${q(site.website(key))}, ${q(site.website(key))},
      ${q(verifiedAt)}, ${q(verifiedAt)}, ${q(verifiedAt)});
  `)
  // Screen 8's "Continue to payment" opens this route.
  await page.goto(`/claims/${claimId}/checkout/`)
  await expect(page).toHaveURL(/\/pay\/cs_test_/u)
  await page.getByRole('button', { name: 'Pay' }).click()
  await expect(page).toHaveURL(new RegExp(`/products/${slug.replaceAll('.', '\\.')}/#claim$`, 'u'))
  expect(order(`claim_id = ${q(claimId)}`)).toMatchObject({
    outcome: 'claimed',
    purpose: 'claim',
    status: 'paid'
  })
  expect(
    billingD1(
      `SELECT user_id, verified_via FROM listing_owners WHERE listing_id = ${q(listingId)} AND revoked_at IS NULL`
    )
  ).toEqual([{ user_id: claimer.id, verified_via: 'paid_claim' }])
})

test('a paid submission rejected as other is refunded automatically', async ({ page }) => {
  const submitter = await signInSubmitter(page, 'reject')
  const draft = seedDraft(submitter.id, 'reject')
  const sessionId = await openCheckout(page.request, `/submit/${draft.id}/checkout/start/`)
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
