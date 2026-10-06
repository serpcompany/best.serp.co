import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { client, q, signIn, unique } from './admin-fixture'
import { claimsD1, claimsOrigin, claimsSuiteEnabled } from './claims-fixture'
import { type FixtureSite, startFixtureSite } from './submit-fixture'

/**
 * The claim dialog (serpcompany/best.serp.co#67, #70 screens 8 and 9) in the browser, on the
 * claims suite's Worker (`LOCAL_CLAIMS=on`, `LOCAL_BADGE_PROGRAM=on`): the sidebar's claim link,
 * sign-in first for visitors, the four steps with their approved errors (webmail, another domain,
 * a wrong, expired, or over-attempt code), the badge check, success, the "Verified owner" badge,
 * and the already-owned dialog. Desktop uses the dialog; a phone gets the drawer.
 *
 * Set CLAIM_SCREENSHOT_DIRECTORY to save each state (desktop and mobile, in the color scheme the
 * run emulates: CLAIM_SCREENSHOT_SCHEME=dark for dark).
 */

test.skip(!claimsSuiteEnabled, 'needs the local claims Worker from playwright.config.ts')
test.use({ baseURL: claimsOrigin() })

const baseURL = claimsOrigin()
const screenshots = process.env.CLAIM_SCREENSHOT_DIRECTORY
  ? resolve(process.env.CLAIM_SCREENSHOT_DIRECTORY)
  : null
const scheme = process.env.CLAIM_SCREENSHOT_SCHEME === 'dark' ? 'dark' : 'light'
let fixture: FixtureSite

async function capture(page: Page, name: string): Promise<void> {
  if (!screenshots) return
  mkdirSync(screenshots, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(screenshots, `${name}-${scheme}.png`) })
}

interface Seeded {
  id: string
  label: string
  name: string
  slug: string
}

function seed(name: string, badge: 'missing' | 'valid' = 'missing'): Seeded {
  const label = `dialog-${unique()}`
  fixture.set(label, { badge, description: `${name}, a fixture.`, name })
  const slug = fixture.slug(label)
  const id = `e2e-dialog-${label}`
  claimsD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum)
    VALUES (${q(id)}, ${q(slug)}, ${q(name)}, ${q(`${name} helps teams ship.`)},
      ${q(fixture.website(label))}, 'A listing for the claim dialog suite.', 'draft',
      '2026-05-16', 'legacy-json-migration-v1', ${q(id)}, ${q(`e2e-${label}`)});
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(id)}, id, 0, 1 FROM categories WHERE slug = 'e2e-claim-tools';
    UPDATE listings SET status = 'approved' WHERE id = ${q(id)};
  `)
  return { id, label, name, slug }
}

async function signedIn(context: BrowserContext, email: string): Promise<void> {
  await signIn(client(context.request, baseURL), email)
}

async function codeFor(page: Page, to: string): Promise<string> {
  const response = await page.request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  const { messages } = (await response.json()) as { messages: Array<{ subject: string }> }
  const code = messages
    .map(message => /^(\d{6}) is your SERP code to claim /u.exec(message.subject)?.[1])
    .find(Boolean)
  if (!code) throw new Error(`no claim code for ${to}`)
  return code
}

function dialog(page: Page) {
  return page.getByRole('dialog')
}

async function enterCode(page: Page, code: string): Promise<void> {
  const input = dialog(page).locator('input[autocomplete="one-time-code"]')
  await input.fill('')
  await input.fill(code)
}

test.beforeAll(async () => {
  fixture = await startFixtureSite()
  claimsD1(`
    INSERT OR IGNORE INTO publication_state (id, version, checksum) VALUES (1, 0, 'e2e-claims');
    INSERT OR IGNORE INTO categories (slug, name, description, sort_order)
      VALUES ('e2e-claim-tools', 'E2E Claim Tools', 'Tools for the claims suite.', 0);
  `)
})

test.afterAll(async () => {
  await fixture?.close()
})

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: scheme })
})

test('a visitor sees the claim link and signs in first', async ({ page }) => {
  const listing = seed('Visitor product')
  await page.goto(`/products/${listing.slug}/`)
  await expect(page.getByText('Work at Visitor product?')).toBeVisible()
  await capture(page, '9a-claim-link')
  await page.getByRole('button', { name: 'Claim this listing' }).click()
  await page.waitForURL(/\/login\/\?callbackUrl=/u)
  expect(decodeURIComponent(new URL(page.url()).searchParams.get('callbackUrl') ?? '')).toBe(
    `/products/${listing.slug}/#claim`
  )
})

test('claims a listing with the badge through every step and its errors', async ({
  context,
  page
}) => {
  test.setTimeout(120_000)
  const listing = seed('Dialog product')
  const email = `claimer-${unique()}@example.com`
  await signedIn(context, email)
  await page.clock.install()
  await page.goto(`/products/${listing.slug}/`)
  await page.getByRole('button', { name: 'Claim this listing' }).click()

  // Step 1: the method. The paid method stays hidden while orders (#68) are off.
  await expect(dialog(page).getByRole('heading', { name: 'Claim Dialog product' })).toBeVisible()
  await expect(
    dialog(page).getByText('Prove you work at Dialog product to manage this listing.')
  ).toBeVisible()
  await expect(dialog(page).getByText('Step 1 of 4')).toBeVisible()
  await expect(dialog(page).getByText('Install the badge (free)')).toBeVisible()
  await expect(dialog(page).getByText(/Skip the badge/u)).toHaveCount(0)
  await expect(
    dialog(page).getByText('Either way, you’ll confirm an email address at')
  ).toBeVisible()
  await capture(page, '8a-method')
  await dialog(page).getByRole('button', { name: 'Continue' }).click()

  // Step 2: the work email, with the approved errors.
  const field = dialog(page).getByLabel('Your email at localtest.me')
  await expect(dialog(page).getByText('Step 2 of 4')).toBeVisible()
  await capture(page, '8b-email')
  await field.fill('jordan.lee@gmail.com')
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(
    dialog(page).getByText(
      'Gmail addresses can’t confirm you work at Dialog product. Use an address at localtest.me.'
    )
  ).toBeVisible()
  await capture(page, '8g-webmail')
  await field.fill('jordan@brieflow.io')
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(
    dialog(page).getByText(
      'That address is at brieflow.io. Use an email at localtest.me (subdomains like team.localtest.me work too).'
    )
  ).toBeVisible()
  await capture(page, '8h-mismatch')
  // The browser takes it; the server needs a registrable domain.
  await field.fill('jordan@localhost')
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(
    dialog(page).getByText('Enter a valid email address, like you@company.com.')
  ).toBeVisible()
  const address = `jordan@${listing.slug}`
  await field.fill(address)
  await dialog(page).getByRole('button', { name: 'Send code' }).click()

  // Step 3: the code. A wrong one, then an expired one, then the right one.
  await expect(dialog(page).getByText(`Code sent to ${address}`)).toBeVisible()
  await expect(
    dialog(page).getByText(/It expires in 10 minutes\. Didn’t get it\? Resend in/u)
  ).toBeVisible()
  await capture(page, '8c-code')
  const code = await codeFor(page, address)
  await enterCode(page, code === '000000' ? '111111' : '000000')
  await expect(dialog(page).getByText('That code isn’t right.')).toBeVisible()
  claimsD1(`UPDATE listing_claims SET code_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
    WHERE listing_id = ${q(listing.id)}`)
  await enterCode(page, code)
  await expect(dialog(page).getByText('This code has expired. Send a new one.')).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Send a new code' })).toBeVisible()
  await capture(page, '8j-expired')
  claimsD1(`UPDATE listing_claims SET code_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')
    WHERE listing_id = ${q(listing.id)}`)
  await dialog(page).getByRole('button', { name: 'Send a new code' }).click()
  await expect(dialog(page).getByText(/Resend in/u)).toBeVisible()
  const fresh = (await page.request
    .get(`/api/dev/email-outbox?to=${encodeURIComponent(address)}`)
    .then(response => response.json())) as { messages: Array<{ subject: string }> }
  const newest = /^(\d{6}) /u.exec(fresh.messages[0]?.subject ?? '')?.[1] ?? ''
  await enterCode(page, newest)

  // Step 4: the badge. Missing first (one of ten checks used), then published.
  await expect(dialog(page).getByText('Step 4 of 4')).toBeVisible()
  await expect(dialog(page).getByText('10 of 10 checks left')).toBeVisible()
  await expect(
    dialog(page).getByText(
      `Paste this into the HTML of ${fixture.website(listing.label)} and keep the link dofollow.`
    )
  ).toBeVisible()
  await capture(page, '8d-badge')
  await dialog(page).getByRole('button', { name: 'Verify badge and claim' }).click()
  await expect(dialog(page).getByText('Page reached, badge not found')).toBeVisible()
  await expect(dialog(page).getByText('9 of 10 checks left')).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: /Check again in/u })).toBeDisabled()
  await capture(page, '8d-badge-missing')
  fixture.update(listing.label, { badge: 'valid' })
  // The 30-second wait between checks, on the page's clock.
  await page.clock.fastForward(31_000)
  claimsD1(`UPDATE listing_claims SET badge_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute')
    WHERE listing_id = ${q(listing.id)}`)
  await expect(dialog(page).getByRole('button', { name: 'Verify badge and claim' })).toBeEnabled()
  await dialog(page).getByRole('button', { name: 'Verify badge and claim' }).click()

  // Success, and the listing now shows the Verified owner badge without the claim link.
  await expect(
    dialog(page).getByRole('heading', { name: 'You now manage Dialog product' })
  ).toBeVisible()
  await expect(
    dialog(page).getByText('It’s in your account. Edits you make are reviewed before they go live.')
  ).toBeVisible()
  await expect(dialog(page).getByText('Keep the badge on localtest.me')).toBeVisible()
  await expect(dialog(page).getByRole('link', { name: 'Edit listing' })).toHaveAttribute(
    'href',
    `/account/listings/${listing.slug}/edit/`
  )
  await expect(dialog(page).getByRole('link', { name: 'Open account' })).toHaveAttribute(
    'href',
    '/account/'
  )
  await capture(page, '8f-success')
  expect(
    claimsD1(`SELECT verified_via FROM listing_owners WHERE listing_id = ${q(listing.id)}`)
  ).toEqual([{ verified_via: 'badge_claim' }])
  // The claim link goes at once, whatever the cached page says, and stays gone after closing.
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Close' }).first().click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toHaveCount(0)
})

test('shows the Verified owner badge, with its tooltip, and no claim link on an owned listing', async ({
  page
}) => {
  const listing = seed('Verified product')
  const ownerId = `e2e-dialog-owner-${unique()}`
  claimsD1(`
    INSERT INTO users (id, name, email, email_verified) VALUES (${q(ownerId)}, 'Owner', ${q(`${ownerId}@example.com`)}, 1);
    INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES (${q(listing.id)}, ${q(ownerId)}, 'badge_claim', ${q(new Date().toISOString())});
  `)
  await page.goto(`/products/${listing.slug}/`)
  const verified = page.getByText('Verified owner')
  await expect(verified).toBeVisible()
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toHaveCount(0)
  await verified.hover()
  await expect(page.getByText('The maker verified ownership of this listing').first()).toBeVisible()
  await capture(page, '9b-verified-owner')
})

test('locks after five wrong codes', async ({ context, page }) => {
  const listing = seed('Locked product')
  await signedIn(context, `locked-${unique()}@example.com`)
  await page.goto(`/products/${listing.slug}/`)
  await page.getByRole('button', { name: 'Claim this listing' }).click()
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  const address = `team@${listing.slug}`
  await dialog(page).getByLabel('Your email at localtest.me').fill(address)
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  const code = await codeFor(page, address)
  const wrong = code === '000000' ? '111111' : '000000'
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await enterCode(page, wrong)
    await expect(
      dialog(page).getByText(
        attempt < 5
          ? 'That code isn’t right.'
          : 'Too many incorrect codes. Wait 15 minutes, then request a new code.'
      )
    ).toBeVisible()
  }
  await expect(dialog(page).getByRole('button', { name: 'Verify' })).toBeDisabled()
  await capture(page, '8k-attempts')
})

test('shows the already-owned dialog with the contact path', async ({ context, page }) => {
  const listing = seed('Owned product')
  await signedIn(context, `second-${unique()}@example.com`)
  // The page rendered while the listing had no owner; someone verifies before this visitor clicks.
  await page.goto(`/products/${listing.slug}/`)
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toBeVisible()
  const ownerId = `e2e-dialog-owner-${unique()}`
  claimsD1(`
    INSERT INTO users (id, name, email, email_verified) VALUES (${q(ownerId)}, 'Owner', ${q(`${ownerId}@example.com`)}, 1);
    INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES (${q(listing.id)}, ${q(ownerId)}, 'badge_claim', ${q(new Date().toISOString())});
  `)
  await page.getByRole('button', { name: 'Claim this listing' }).click()
  await expect(
    dialog(page).getByRole('heading', { name: 'Owned product already has an owner' })
  ).toBeVisible()
  await expect(
    dialog(page).getByText('Someone has already verified that they own this listing.')
  ).toBeVisible()
  await expect(
    dialog(page).getByText(
      'If you think that’s a mistake, message us. We’ll check with the current owner and can move the listing to you.'
    )
  ).toBeVisible()
  await expect(dialog(page).getByRole('link', { name: 'Message us' })).toHaveAttribute(
    'href',
    '/contact/'
  )
  await capture(page, '8i-owned')
})

test('tells the owner they manage the listing, never that someone else owns it', async ({
  context,
  page
}) => {
  const listing = seed('Mine product')
  const email = `mine-${unique()}@example.com`
  await signedIn(context, email)
  // The page rendered before this visitor's ownership reached it (the catalog cache).
  await page.goto(`/products/${listing.slug}/`)
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toBeVisible()
  claimsD1(`
    INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      SELECT ${q(listing.id)}, id, 'badge_claim', ${q(new Date().toISOString())}
      FROM users WHERE email = ${q(email)};
  `)
  await page.getByRole('button', { name: 'Claim this listing' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'You manage this listing' })).toBeVisible()
  await expect(
    dialog(page).getByText('It’s in your account. Edits you make are reviewed before they go live.')
  ).toBeVisible()
  await expect(dialog(page).getByText(/already has an owner/u)).toHaveCount(0)
  await expect(dialog(page).getByRole('link', { name: 'Edit listing' })).toHaveAttribute(
    'href',
    `/account/listings/${listing.slug}/edit/`
  )
  await expect(page.getByRole('button', { name: 'Claim this listing' })).toHaveCount(0)
  await capture(page, '8f-mine')
})

test('says when the hourly caps stop a send, and when a confirmation ran out', async ({
  context,
  page
}) => {
  const listing = seed('Capped product')
  await signedIn(context, `capped-${unique()}@example.com`)
  await page.clock.install()
  await page.goto(`/products/${listing.slug}/`)
  await page.getByRole('button', { name: 'Claim this listing' }).click()
  await dialog(page).getByRole('button', { name: 'Continue' }).click()
  const address = `team@${listing.slug}`
  await dialog(page).getByLabel('Your email at localtest.me').fill(address)
  await dialog(page).getByRole('button', { name: 'Send code' }).click()
  await expect(dialog(page).getByText(`Code sent to ${address}`)).toBeVisible()
  // Three codes an hour per address: the fourth send is refused, and the dialog says so.
  for (let send = 2; send <= 4; send += 1) {
    claimsD1(`UPDATE listing_claims SET code_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')
      WHERE listing_id = ${q(listing.id)}`)
    await page.clock.fastForward(61_000)
    const answer = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === '/api/claims' && response.request().method() === 'POST'
    )
    await dialog(page).getByRole('button', { name: 'Resend', exact: true }).click()
    expect((await answer).status()).toBe(send < 4 ? 201 : 429)
  }
  await expect(
    dialog(page).getByText(
      /^Too many code requests\. Try again in \d+ (?:minutes?|hours?), or use the most recent code we sent\.$/u
    )
  ).toBeVisible()
  await capture(page, '8l-capped')

  // The most recent code still confirms; a day later the confirmation has run out.
  await enterCode(page, await codeFor(page, address))
  await expect(dialog(page).getByText('Step 4 of 4')).toBeVisible()
  claimsD1(`UPDATE listing_claims SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')
    WHERE listing_id = ${q(listing.id)}`)
  await dialog(page).getByRole('button', { name: 'Verify badge and claim' }).click()
  await expect(dialog(page).getByText('Step 3 of 4')).toBeVisible()
  await expect(dialog(page).getByText('This code has expired. Send a new one.')).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Send a new code' })).toBeVisible()
  await capture(page, '8m-confirmation-expired')
})

test.describe('on a phone', () => {
  test.use({ viewport: { height: 812, width: 375 } })

  test('opens the claim flow in a drawer', async ({ context, page }) => {
    const listing = seed('Phone product')
    await signedIn(context, `phone-${unique()}@example.com`)
    await page.goto(`/products/${listing.slug}/`)
    await page.getByRole('button', { name: 'Claim this listing' }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('heading', { name: 'Claim Phone product' })).toBeVisible()
    await expect(drawer).toHaveAttribute('data-vaul-drawer-direction', 'bottom')
    await capture(page, 'mobile-8a-method')
    await drawer.getByRole('button', { name: 'Continue' }).click()
    await drawer.getByLabel('Your email at localtest.me').fill('jo@gmail.com')
    await drawer.getByRole('button', { name: 'Send code' }).click()
    await expect(
      drawer.getByText(/Gmail addresses can’t confirm you work at Phone product/u)
    ).toBeVisible()
    await capture(page, 'mobile-8g-webmail')
  })
})
