import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request as playwrightRequest
} from '@playwright/test'
import {
  ADMIN_EMAIL_PREFIXES,
  accountServer,
  activeCategory,
  adminOrigin,
  adminSuiteEnabled,
  client,
  q,
  removeAdmin,
  removeLeftoverAdmins,
  seedAdminCatalog,
  signInAsNewAdmin,
  localD1 as suiteD1,
  unique
} from './admin-fixture'
import { escapeRegExp } from './site-fixture'
import { type FixtureSite, startFixtureSite } from './submit-fixture'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because:
      'three tabs save the revision they loaded at once, so two of the revision saves get 409',
    patterns: [expectedResponse(409, /\/api\/account\/listings\/[^/]+\/revision/u)]
  }
})

/**
 * The submitter dashboard (serpcompany/best.serp.co#65) against its own local Worker and D1
 * (`accountServer`; it publishes listings and adds admins, like the admin suite): a submission moves through its statuses on
 * `/account`, is fixed and resubmitted after a change request, its live listing is edited as a
 * revision that an admin approves, a free listing's badge is checked from its panel, and a
 * pending submission is withdrawn. Every record is the user's own: another account, a missing
 * Origin, or no session gets nothing.
 *
 * Set ACCOUNT_SCREENSHOT_DIRECTORY to save each screen at desktop and mobile width, in light and
 * dark, for comparison with the #70 mockups.
 */

test.skip(!adminSuiteEnabled, 'needs the local account Worker from playwright.config.ts')
test.describe.configure({ mode: 'serial' })
test.use({ baseURL: adminOrigin(accountServer) })

/** SQL on this suite's own local D1 (`accountServer`). */
function localD1<T = Record<string, unknown>>(sql: string): T[] {
  return suiteD1<T>(sql, accountServer)
}

const screenshots = process.env.ACCOUNT_SCREENSHOT_DIRECTORY
  ? resolve(process.env.ACCOUNT_SCREENSHOT_DIRECTORY)
  : null

const SIZES = {
  desktop: { height: 1400, width: 1280 },
  mobile: { height: 1700, width: 390 }
} as const

/** Saves the current screen at both widths and in both themes, then restores desktop light. */
async function capture(page: Page, name: string): Promise<void> {
  if (!screenshots) return
  mkdirSync(screenshots, { recursive: true })
  for (const [width, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.waitForTimeout(400)
      await page.screenshot({ path: resolve(screenshots, `${name}-${width}-${colorScheme}.png`) })
    }
  }
  await page.setViewportSize({ height: 900, width: 1280 })
  await page.emulateMedia({ colorScheme: 'light' })
}

function uniqueIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.18.${octet()}.${octet()}`
}

interface Submitter {
  context: BrowserContext
  email: string
  headers: Record<string, string>
  page: Page
}

async function outboxCode(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  const { otp } = (await response.json()) as { otp: string | null }
  expect(otp).toMatch(/^\d{6}$/u)
  return otp as string
}

/** A browser context signed in as a fresh account; its page and requests share the session. */
async function signedIn(browser: Browser, label: string): Promise<Submitter> {
  const ip = uniqueIp()
  const context = await browser.newContext({
    baseURL: adminOrigin(accountServer),
    extraHTTPHeaders: { 'cf-connecting-ip': ip }
  })
  const email = `e2e-account-${label}-${unique()}@example.com`
  const headers = { origin: adminOrigin(accountServer) }
  const requested = await context.request.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers
  })
  expect(requested.status(), await requested.text()).toBe(200)
  const signedInResponse = await context.request.post('/api/auth/sign-in/email-otp', {
    data: { email, otp: await outboxCode(context.request, email) },
    headers
  })
  expect(signedInResponse.status(), await signedInResponse.text()).toBe(200)
  return { context, email, headers, page: await context.newPage() }
}

/** A saved draft for a fixture website, as `/submit/` saves one (#63). */
async function saveDraft(user: Submitter, website: string, name: string): Promise<string> {
  const response = await user.context.request.post('/api/submissions', {
    data: {
      categorySlug: activeCategory(),
      content: 'Turns rough product notes into landing pages.',
      description: 'Drafts landing pages and emails from product notes, in your voice.',
      logoUrl: `${website}icon.png`,
      name,
      website
    },
    headers: user.headers
  })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { submission: { id: string } }).submission.id
}

function row(page: Page, name: string) {
  return page.getByRole('row', { name: new RegExp(name) })
}

function submissionRow(id: string) {
  return localD1<{ content_version: number; listing_id: string | null; status: string }>(
    `SELECT status, listing_id, content_version FROM listing_submissions WHERE id = ${q(id)}`
  )[0]
}

async function emailsTo(request: APIRequestContext, to: string) {
  const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { messages: Array<{ subject: string; text: string }> })
    .messages
}

let fixture: FixtureSite
const admins: string[] = []

test.beforeAll(async () => {
  seedAdminCatalog(accountServer)
  // This suite's own leftovers (an interrupted run); its Worker and D1 are its own.
  removeLeftoverAdmins([ADMIN_EMAIL_PREFIXES.accountDashboard], accountServer)
  fixture = await startFixtureSite()
})

test.afterAll(async () => {
  await fixture.close()
  for (const email of admins) removeAdmin(email, accountServer)
})

test('a submission moves through its statuses, is resubmitted after a change request, and its listing is edited through an approved revision', async ({
  baseURL,
  browser,
  page: adminPage
}) => {
  test.setTimeout(300_000)
  const label = `acct-${unique()}`
  const name = `Ledgerly ${label.slice(-5)}`
  const website = fixture.website(label)
  const slug = fixture.slug(label)
  fixture.set(label, { badge: 'missing', description: 'Tax worksheets for freelancers.', name })
  const user = await signedIn(browser, 'journey')
  const { page } = user
  const admin = client(adminPage.request, baseURL)
  admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.accountDashboard, accountServer))

  // Draft: it waits for a plan, and expires 30 days after it was saved.
  const id = await saveDraft(user, website, name)
  await page.goto('/account/')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(row(page, name).getByText('Draft – choose a plan')).toBeVisible()
  await expect(row(page, name).getByText('Expires in 30 days')).toBeVisible()
  await expect(row(page, name).getByRole('link', { name: 'Continue' })).toHaveAttribute(
    'href',
    `/submit/${id}/choose/`
  )

  // Free chosen: it waits for its badge.
  const plan = await user.context.request.post(`/api/submissions/${id}/plan`, {
    data: { plan: 'free' },
    headers: user.headers
  })
  expect(plan.status()).toBe(200)
  await page.reload()
  await expect(row(page, name).getByText('Pending badge')).toBeVisible()
  await expect(row(page, name).getByRole('link', { name: 'Add badge' })).toBeVisible()

  // The badge is up and verified: in review.
  fixture.update(label, { badge: 'valid' })
  const verify = await user.context.request.post(`/api/submissions/${id}/verify`, {
    data: {},
    headers: user.headers
  })
  expect(await verify.json()).toMatchObject({ result: { ok: true } })
  await page.reload()
  await expect(row(page, name).getByText('In review')).toBeVisible()
  await expect(row(page, name).getByText('Waiting for a reviewer')).toBeVisible()
  await capture(page, '05-overview')

  // In review: FAQs and links can be added, and are reviewed with the listing.
  await row(page, name).getByRole('link', { name }).click()
  await page.waitForURL(`**/account/submissions/${id}/`)
  await expect(page.getByText('Waiting for a reviewer')).toBeVisible()
  await expect(
    page.getByText('None yet. Add them now and they’re reviewed with the listing.')
  ).toBeVisible()
  await capture(page, '06-in-review')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('button', { name: 'Add FAQ' }).click()
  await page.getByLabel('Question 1').fill('Does it file my taxes?')
  await page.getByLabel('Answer 1').fill('No. It prepares the worksheets; you file.')
  await page.getByRole('button', { name: 'Add link' }).click()
  await page.getByLabel('Link 1 label').fill('Pricing')
  await page.getByLabel('Link 1 URL').fill('ledgerly.example/pricing')
  await page.getByRole('button', { name: 'Save FAQs and links' }).click()
  await expect(page.getByText('Enter a full URL starting with https://')).toBeVisible()
  await capture(page, '06-adding-faqs')
  await page.getByLabel('Link 1 URL').fill('https://ledgerly.example/pricing')
  await page.getByRole('button', { name: 'Save FAQs and links' }).click()
  await expect(page.getByText('Does it file my taxes?')).toBeVisible()
  expect(submissionRow(id)?.content_version).toBe(2)

  // A reviewer asks for changes; the account shows the note and the edit form.
  const note = 'Describe what it does in plain terms, without “#1”, and link the plans page.'
  const changes = await adminPage.request.post(`/api/admin/submissions/${id}/request-changes`, {
    data: { note },
    headers: admin.headers
  })
  expect(changes.status(), await changes.text()).toBe(200)
  await page.goto('/account/')
  await expect(row(page, name).getByText('Changes requested')).toBeVisible()
  await expect(row(page, name).getByText('Fix and resubmit')).toBeVisible()
  await row(page, name).getByRole('link', { name: 'Edit' }).click()
  await page.waitForURL(`**/account/submissions/${id}/`)
  await expect(page.getByText(note)).toBeVisible()
  await expect(page.getByLabel('Website URL')).toBeDisabled()
  await page.getByLabel('Short description').fill('Sorts freelancer expenses into tax categories.')
  await expect(page.getByText('Edited', { exact: true })).toBeVisible()
  // The note is about a link too: it's fixed in the same pass (#102 review round 1).
  await expect(page.getByLabel('Link 1 URL')).toHaveValue('https://ledgerly.example/pricing')
  await page.getByLabel('Link 1 URL').fill('https://ledgerly.example/plans')
  await capture(page, '06-changes-requested')
  await page.getByRole('button', { name: 'Resubmit for review' }).click()
  await expect(page.getByText(`${name} is back in the review queue.`)).toBeVisible()
  await expect(page.getByText('Waiting for a reviewer')).toBeVisible()
  await expect(page.getByText('Resubmitted')).toBeVisible()
  expect(submissionRow(id)).toMatchObject({ content_version: 3, status: 'verified' })
  expect(
    localD1(`SELECT url FROM listing_submission_resource_links WHERE submission_id = ${q(id)}`)
  ).toEqual([{ url: 'https://ledgerly.example/plans' }])
  // The FAQs added in review are kept, and the admin hears it's back.
  await expect(page.getByText('Does it file my taxes?')).toBeVisible()
  await expect
    .poll(
      async () =>
        (await emailsTo(page.request, 'devin@serp.co')).filter(message =>
          message.subject.includes(name)
        ).length
    )
    .toBe(2)

  // Approved: the listing is live, with the FAQs and links, and owned by the submitter. The
  // approval sends back the hosted logo and featured image the review screen shows (#96).
  const reviewed = Object.fromEntries(
    localD1<{ kind: string; media_key: string }>(
      `SELECT j.kind, j.media_key FROM media_ingestions j
        JOIN listing_submissions s ON s.id = j.submission_id
        WHERE s.id = ${q(id)} AND j.sort_order = 0 AND j.status = 'hosted'
          AND (j.kind = 'image' OR j.source_url = s.logo_url)`
    ).map(slot => [slot.kind, slot.media_key])
  )
  const approve = await adminPage.request.post(`/api/admin/submissions/${id}/approve`, {
    data: {
      expectedContentVersion: 3,
      expectedImageKey: reviewed.image ?? null,
      expectedLogoKey: reviewed.logo ?? null
    },
    headers: admin.headers
  })
  expect(approve.status(), await approve.text()).toBe(200)
  await page.goto('/account/')
  await expect(row(page, name).getByText('Live', { exact: true })).toBeVisible()
  await expect(row(page, name).getByText(/Badge passing · checked/u)).toBeVisible()
  // The badge program (#66) is on (#130): the "Badge checks" card promises weekly checks.
  await expect(page.getByText('Free listings are checked weekly')).toBeVisible()

  // The badge panel: the last check, the code, the history, and Re-verify now.
  await row(page, name).getByRole('button', { name: 'Badge' }).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByText(`${name} badge`)).toBeVisible()
  await expect(panel.getByText('Free listing · checked weekly')).toBeVisible()
  await expect(panel.getByText('Badge found, dofollow')).toBeVisible()
  // The badge code (#188's shared embed-code box) links the badge to this listing.
  await expect(panel.getByLabel('Badge snippet')).toHaveValue(
    new RegExp(`href="[^"]*/products/${escapeRegExp(slug)}/"`, 'u')
  )
  // Orders are on (#68, #133): a live free listing can be upgraded to the paid plan.
  await expect(panel.getByRole('link', { name: 'Upgrade: $49 one-off' })).toHaveAttribute(
    'href',
    `/account/listings/${slug}/checkout/`
  )
  // The panel's own budget (10 a day); the badge step's check doesn't count.
  await expect(panel.getByText('10 of 10')).toBeVisible()
  await capture(page, '05-badge-passing')
  fixture.update(label, { badge: 'nofollow' })
  // A check within the last 30 seconds (the submission's) keeps the button disabled.
  await expect(panel.getByRole('button', { name: 'Re-verify now' })).toBeEnabled({
    timeout: 40_000
  })
  await panel.getByRole('button', { name: 'Re-verify now' }).click()
  await expect(panel.getByRole('button', { name: /Check again in 0:/u })).toBeDisabled()
  await expect(panel.getByText('Link is nofollow')).toBeVisible()
  // With the badge program on, a failing badge is fixed before the program's recheck.
  await expect(panel.getByText('Fix the badge before the recheck', { exact: true })).toBeVisible()
  await expect(
    panel.getByText(
      'If it’s still failing at the recheck about 24 hours later, the listing is unlisted.'
    )
  ).toBeVisible()
  await expect(panel.getByText('9 of 10')).toBeVisible()
  await capture(page, '05-badge-failing')
  await panel.getByRole('button', { name: 'Close' }).click()
  fixture.update(label, { badge: 'valid' })

  // Editing the live listing creates a revision; the public listing doesn't change yet.
  await page.goto(`/account/listings/${slug}/edit/`)
  await expect(page.getByRole('heading', { name: `Edit ${name}` })).toBeVisible()
  await expect(page.getByLabel('Name')).toBeDisabled()
  // Listing pages show FAQs (#105, features.listingFaqs), and the hint says so.
  await expect(page.getByText('Shown on your listing page.')).toBeVisible()
  await capture(page, '07-edit')
  const revised = 'Sorts expenses from your bank feed and prepares quarterly tax worksheets.'
  await page.getByLabel('Short description').fill(revised)
  await page.getByRole('button', { name: 'Add FAQ' }).click()
  await page.getByLabel('Question 2').fill('Which banks can I connect?')
  await page.getByLabel('Answer 2').fill('Most US banks and credit unions.')
  await capture(page, '07-adding')
  await page.getByRole('button', { name: 'Submit changes for review' }).click()
  await expect(page.getByText('Your edits are waiting for review', { exact: true })).toBeVisible()
  await expect(page.getByText('2 changes in this revision')).toBeVisible()
  await capture(page, '07-pending')
  const [revision] = localD1<{ content_version: number; id: string; status: string }>(
    `SELECT id, status, content_version FROM listing_revisions
      WHERE listing_id = ${q(`submission_${id}`)} ORDER BY created_at DESC LIMIT 1`
  )
  expect(revision?.status).toBe('pending_review')
  // Three tabs save the version they loaded at once: one wins, the others get 409.
  const revisionBody = {
    categorySlug: activeCategory(),
    content: 'Turns rough product notes into landing pages.',
    description: revised,
    expectedRevisionVersion: revision?.content_version,
    faqs: [
      { answer: 'No. It prepares the worksheets; you file.', question: 'Does it file my taxes?' },
      { answer: 'Most US banks and credit unions.', question: 'Which banks can I connect?' }
    ],
    logoUrl: `${website}icon.png`,
    resourceLinks: [{ label: 'Pricing', url: 'https://ledgerly.example/plans' }]
  }
  const listingRowId = `submission_${id}`
  const saves = await Promise.all(
    [1, 2, 3].map(() =>
      user.context.request.post(`/api/account/listings/${listingRowId}/revision`, {
        data: revisionBody,
        headers: user.headers
      })
    )
  )
  expect(saves.map(response => response.status()).sort()).toEqual([200, 409, 409])
  expect(
    localD1<{ content_version: number }>(
      `SELECT content_version FROM listing_revisions WHERE id = ${q(revision?.id ?? '')}`
    )[0]?.content_version
  ).toBe((revision?.content_version ?? 0) + 1)
  // The page still holds the old version: its save is refused, not applied.
  await page.getByRole('button', { name: 'Change pending edits' }).click()
  await page.getByRole('button', { name: 'Submit changes for review' }).click()
  await expect(
    page.getByText('This listing changed in another window. Reload and try again.')
  ).toBeVisible()
  await page.goto('/account/')
  await expect(row(page, name).getByText('Edits in review')).toBeVisible()
  await expect
    .poll(async () =>
      (await emailsTo(page.request, 'devin@serp.co')).some(message =>
        message.text.includes(`/admin/revisions/${revision?.id}/`)
      )
    )
    .toBe(true)

  // An admin approves the revision; the listing page then shows the edits.
  await adminPage.goto(`/admin/revisions/${revision?.id}/`)
  await adminPage.getByRole('button', { name: 'Approve', exact: true }).click()
  await adminPage
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Approve and publish' })
    .click()
  await expect
    .poll(
      () =>
        localD1<{ status: string }>(
          `SELECT status FROM listing_revisions WHERE id = ${q(revision?.id ?? '')}`
        )[0]?.status
    )
    .toBe('approved')
  const visitor = await playwrightRequest.newContext({ baseURL })
  try {
    await expect(async () => {
      const html = await (await visitor.get(`/products/${slug}/`)).text()
      expect(html).toContain(revised)
      // The link fixed in the resubmission is on the listing page.
      expect(html).toContain('https://ledgerly.example/plans')
    }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
  } finally {
    await visitor.dispose()
  }
  // The FAQs are the listing's now (the public page doesn't render listing FAQs yet).
  expect(
    localD1<{ question: string }>(
      `SELECT question FROM listing_faqs WHERE listing_id = ${q(`submission_${id}`)} ORDER BY sort_order`
    ).map(faq => faq.question)
  ).toEqual(['Does it file my taxes?', 'Which banks can I connect?'])
  await page.goto('/account/')
  await expect(row(page, name).getByText('Edits in review')).toHaveCount(0)
  await capture(page, '05-overview-live')
  await user.context.close()
})

test('withdraws a pending submission from the table', async ({ browser }) => {
  const label = `acct-${unique()}`
  const name = `Mealmap ${label.slice(-5)}`
  fixture.set(label, { badge: 'missing', description: 'Meal plans.', name })
  const user = await signedIn(browser, 'withdraw')
  const id = await saveDraft(user, fixture.website(label), name)
  await user.context.request.post(`/api/submissions/${id}/plan`, {
    data: { plan: 'free' },
    headers: user.headers
  })
  const { page } = user
  await page.goto('/account/')
  await row(page, name)
    .getByRole('button', { name: `Open menu for ${name}` })
    .click()
  await page.getByRole('menuitem', { name: 'Withdraw' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByText(`Withdraw ${name}?`)).toBeVisible()
  await capture(page, '06-withdraw-confirm')
  await dialog.getByRole('button', { name: 'Withdraw submission' }).click()
  await expect(row(page, name).getByText('Withdrawn')).toBeVisible()
  await expect(row(page, name).getByText('You withdrew it')).toBeVisible()
  expect(submissionRow(id)?.status).toBe('withdrawn')
  await page.goto(`/account/submissions/${id}/`)
  await expect(page.getByText('You withdrew this submission')).toBeVisible()
  await capture(page, '06-withdrawn')
  await user.context.close()
})

test('shows and acts on the user’s own records only, never cached or indexed', async ({
  baseURL,
  browser
}) => {
  const label = `acct-${unique()}`
  const name = `Clipwise ${label.slice(-5)}`
  fixture.set(label, { badge: 'missing', description: 'Clips.', name })
  const owner = await signedIn(browser, 'owner')
  const id = await saveDraft(owner, fixture.website(label), name)
  await owner.context.request.post(`/api/submissions/${id}/plan`, {
    data: { plan: 'free' },
    headers: owner.headers
  })
  // A live listing the owner owns, as an approval leaves it.
  const listingId = `e2e-owned-${unique()}`
  const listingSlug = `${listingId}.example`
  const [ownerUser] = localD1<{ id: string }>(
    `SELECT id FROM users WHERE email = ${q(owner.email)}`
  )
  localD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum, source, link_rel)
    VALUES (${q(listingId)}, ${q(listingSlug)}, 'Owned listing', 'Owned.', ${q(`https://${listingSlug}/`)},
      '', 'draft', '2026-09-01', 'verified-submission', ${q(listingId)}, ${q(`e2e-${listingId}`)},
      'submission', 'nofollow');
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(listingId)}, id, 0, 1 FROM categories WHERE slug = ${q(activeCategory())};
    INSERT INTO listing_media (listing_id, kind, url, sort_order)
      VALUES (${q(listingId)}, 'logo', ${q(`https://${listingSlug}/logo.png`)}, 0);
    UPDATE listings SET status = 'approved' WHERE id = ${q(listingId)};
    INSERT INTO listing_owners (listing_id, user_id, role, verified_via, verified_at)
      VALUES (${q(listingId)}, ${q(ownerUser?.id ?? '')}, 'owner', 'admin', '2026-09-01T00:00:00.000Z');
  `)
  await owner.page.goto(`/account/listings/${listingSlug}/edit/`)
  await expect(owner.page.getByRole('heading', { name: 'Edit Owned listing' })).toBeVisible()

  // Another account: the pages are 404s and every action is refused as not found.
  const other = await signedIn(browser, 'other')
  for (const path of [
    `/account/submissions/${id}/`,
    `/account/listings/${listingSlug}/edit/`,
    `/account/listings/${listingSlug}/`
  ]) {
    expect((await other.context.request.get(path)).status(), path).toBe(404)
  }
  await other.page.goto('/account/')
  await expect(other.page.getByText(name)).toHaveCount(0)
  const writes: Array<[string, unknown]> = [
    [`/api/account/submissions/${id}/withdraw`, {}],
    [
      `/api/account/submissions/${id}/extras`,
      { expectedContentVersion: 1, faqs: [], resourceLinks: [] }
    ],
    [
      `/api/account/submissions/${id}/resubmit`,
      {
        categorySlug: activeCategory(),
        content: '',
        description: 'Taken over.',
        expectedContentVersion: 1,
        logoUrl: `${fixture.website(label)}icon.png`,
        name: 'Taken over'
      }
    ],
    [
      `/api/account/listings/${listingId}/revision`,
      {
        categorySlug: activeCategory(),
        content: '',
        description: 'Taken over.',
        expectedRevisionVersion: null,
        faqs: [],
        logoUrl: `https://${listingSlug}/logo.png`,
        resourceLinks: []
      }
    ],
    [`/api/account/listings/${listingId}/discard-revision`, {}],
    [`/api/account/listings/${listingId}/verify-badge`, {}]
  ]
  for (const [path, data] of writes) {
    const response = await other.context.request.post(path, { data, headers: other.headers })
    expect(response.status(), path).toBe(404)
    expect(response.headers()['cache-control']).toContain('no-store')
  }
  expect(submissionRow(id)?.status).toBe('pending_badge')
  expect(localD1(`SELECT id FROM listing_revisions WHERE listing_id = ${q(listingId)}`)).toEqual([])

  // The owner's own write without this site's Origin is refused (CSRF), and so is no session.
  const crossSite = await owner.context.request.post(`/api/account/submissions/${id}/withdraw`, {
    data: {},
    headers: { origin: 'https://evil.example' }
  })
  expect(crossSite.status()).toBe(403)
  const anonymous = await playwrightRequest.newContext({ baseURL })
  try {
    const refused = await anonymous.post(`/api/account/submissions/${id}/withdraw`, {
      data: {},
      headers: { origin: adminOrigin(accountServer) }
    })
    expect(refused.status()).toBe(401)
    for (const path of ['/account/', `/account/submissions/${id}/`, '/account/listings/']) {
      const response = await anonymous.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(307)
      expect(response.headers().location, path).toContain(
        `/login/?callbackUrl=${encodeURIComponent(path)}`
      )
    }
  } finally {
    await anonymous.dispose()
  }
  expect(submissionRow(id)?.status).toBe('pending_badge')

  // Every account page bypasses the edge cache and is noindex.
  for (const path of [
    '/account/',
    '/account/submissions/',
    '/account/listings/',
    `/account/listings/${listingSlug}/edit/`
  ]) {
    const response = await owner.context.request.get(path)
    expect(response.status(), path).toBe(200)
    expect(response.headers()['x-edge-cache'], path).toBe('BYPASS')
    expect(await response.text(), path).toMatch(/<meta name="robots" content="noindex/u)
  }
  await owner.context.close()
  await other.context.close()
})

/** A live listing owned by `ownerEmail`'s account, with these FAQs, as an approval leaves it. */
function seedOwnedListing(
  label: string,
  ownerEmail: string,
  faqs: Array<[string, string]>,
  content = ''
) {
  const id = `e2e-faqs-${label}-${unique()}`
  const slug = `${id}.example`
  const [owner] = localD1<{ id: string }>(`SELECT id FROM users WHERE email = ${q(ownerEmail)}`)
  localD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum, source, link_rel)
    VALUES (${q(id)}, ${q(slug)}, ${q(`FAQ ${label}`)}, 'A listing for the FAQ section.',
      ${q(`https://${slug}/`)}, ${q(content)}, 'draft', '2026-09-01', 'verified-submission', ${q(id)},
      ${q(`e2e-${id}`)}, 'submission', 'nofollow');
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(id)}, id, 0, 1 FROM categories WHERE slug = ${q(activeCategory())};
    INSERT INTO listing_media (listing_id, kind, url, sort_order)
      VALUES (${q(id)}, 'logo', ${q(`https://${slug}/logo.png`)}, 0);
    ${faqs
      .map(
        ([question, answer], index) =>
          `INSERT INTO listing_faqs (listing_id, question, answer, sort_order)
            VALUES (${q(id)}, ${q(question)}, ${q(answer)}, ${index});`
      )
      .join('\n')}
    UPDATE listings SET status = 'approved' WHERE id = ${q(id)};
    INSERT INTO listing_owners (listing_id, user_id, role, verified_via, verified_at)
      VALUES (${q(id)}, ${q(owner?.id ?? '')}, 'owner', 'admin', '2026-09-01T00:00:00.000Z');
  `)
  return { id, slug }
}

test('listing pages show approved FAQs, none without, and an approved FAQ revision after the epoch turns (#105)', async ({
  baseURL,
  browser,
  page: adminPage
}) => {
  test.setTimeout(180_000)
  const owner = await signedIn(browser, 'faqs')
  const withFaqs = seedOwnedListing('with', owner.email, [
    ['Does it file my taxes?', 'No. It prepares the worksheets; you file.'],
    ['Which banks can I connect?', 'Most US banks and credit unions.']
  ])
  const without = seedOwnedListing('without', owner.email, [])
  // As the one-time import stored them: each FAQ also a heading in the long description.
  const imported = seedOwnedListing(
    'imported',
    owner.email,
    [['How do I export a report?', 'From the Reports page.']],
    '## FAQ\n\n### How do I export a report?\n\nFrom the Reports page.'
  )
  const visitor = await playwrightRequest.newContext({ baseURL })
  try {
    // With FAQs: the section, every question, and the answers (in the HTML while closed).
    const html = await (await visitor.get(`/products/${withFaqs.slug}/`)).text()
    expect(html).toContain('id="faqs"')
    for (const text of [
      'Does it file my taxes?',
      'No. It prepares the worksheets; you file.',
      'Which banks can I connect?'
    ]) {
      expect(html).toContain(text)
    }
    // Edge-cached like the rest of the page.
    expect((await visitor.get(`/products/${withFaqs.slug}/`)).headers()['x-edge-cache']).toBe('HIT')
    // Without FAQs: no section at all.
    expect(await (await visitor.get(`/products/${without.slug}/`)).text()).not.toContain(
      'id="faqs"'
    )
    // FAQs the long description already shows aren't repeated in a section.
    const importedHtml = await (await visitor.get(`/products/${imported.slug}/`)).text()
    expect(importedHtml).toContain('How do I export a report?')
    expect(importedHtml).not.toContain('id="faqs"')

    // The page in a browser: questions as an Accordion, an answer shown when opened.
    const page = await (await browser.newContext({ baseURL })).newPage()
    await page.goto(`/products/${withFaqs.slug}/`)
    const faqs = page.locator('section[aria-labelledby="faqs"]')
    await expect(faqs.getByRole('heading', { name: 'FAQs' })).toBeVisible()
    await expect(faqs.getByText('No. It prepares the worksheets; you file.')).toBeHidden()
    await faqs.getByRole('button', { name: 'Does it file my taxes?' }).click()
    await expect(faqs.getByText('No. It prepares the worksheets; you file.')).toBeVisible()
    if (screenshots) {
      mkdirSync(screenshots, { recursive: true })
      // The section itself (and, on a phone, the page around it), at both widths and themes.
      for (const [width, size] of Object.entries(SIZES)) {
        await page.setViewportSize({ height: 900, width: size.width })
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await faqs.scrollIntoViewIfNeeded()
          await page.waitForTimeout(400)
          await faqs.screenshot({
            path: resolve(screenshots, `105-faqs-section-${width}-${colorScheme}.png`)
          })
          await page.screenshot({
            path: resolve(screenshots, `105-faqs-page-${width}-${colorScheme}.png`)
          })
        }
      }
    }
    await page.context().close()

    // The owner changes the FAQs; nothing public changes until an admin approves.
    const saved = await owner.context.request.post(
      `/api/account/listings/${withFaqs.id}/revision`,
      {
        data: {
          categorySlug: activeCategory(),
          content: '',
          description: 'A listing for the FAQ section.',
          expectedRevisionVersion: null,
          faqs: [
            {
              answer: 'No. It prepares the worksheets; you file.',
              question: 'Does it file my taxes?'
            },
            { answer: 'Yes, as a CSV.', question: 'Can I export my data?' }
          ],
          logoUrl: `https://${withFaqs.slug}/logo.png`,
          resourceLinks: []
        },
        headers: owner.headers
      }
    )
    expect(saved.status(), await saved.text()).toBe(200)
    const { revisionId } = (await saved.json()) as { revisionId: string }
    expect(await (await visitor.get(`/products/${withFaqs.slug}/`)).text()).not.toContain(
      'Can I export my data?'
    )
    const admin = client(adminPage.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.accountDashboard, accountServer))
    const approved = await adminPage.request.post(`/api/admin/revisions/${revisionId}/approve`, {
      data: { expectedContentVersion: 1 },
      headers: admin.headers
    })
    expect(approved.status(), await approved.text()).toBe(200)
    // The approval advances the catalog epoch, so the cached page turns over.
    await expect(async () => {
      const updated = await (await visitor.get(`/products/${withFaqs.slug}/`)).text()
      expect(updated).toContain('Can I export my data?')
      expect(updated).not.toContain('Which banks can I connect?')
    }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
  } finally {
    await visitor.dispose()
    await owner.context.close()
  }
})
