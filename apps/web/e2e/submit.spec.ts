import { type APIRequestContext, type BrowserContext, expect, type Page } from '@playwright/test'
import { listingPath, site } from './site-fixture'
import { executeLocalD1, type FixtureSite, startFixtureSite } from './submit-fixture'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because:
      "the badge step checks the cooldown, a repeated check, and a stranger's submission page",
    patterns: [
      expectedResponse(409, /\/api\/submissions\/[^/]+\/verify/u),
      expectedResponse(429, /\/api\/submissions\/[^/]+\/verify/u),
      expectedResponse(404, /\/submit\/[^/]+\/badge\//u)
    ]
  }
})

/**
 * Submit v2 in a browser against the local Worker (serpcompany/best.serp.co#63, #70 screens
 * 2, 2b, 3): fill the form signed out, sign in with the emailed code, save the draft, choose
 * free, and verify the badge on a local fixture website; URL prefill; duplicate and prohibited
 * URLs. Codes and emails come from the local dev outboxes.
 */

const ADMIN_RECIPIENT = 'devin@serp.co'
const CATEGORY = 'Video Downloaders'

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** A documentation-range client address, so each test has its own per-client limits. */
function uniqueIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.18.${octet()}.${octet()}`
}

let fixture: FixtureSite

test.beforeAll(async () => {
  fixture = await startFixtureSite()
})

test.afterAll(async () => {
  await fixture.close()
})

async function newClient(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': uniqueIp() } })
}

async function outboxCode(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  const { otp } = (await response.json()) as { otp: string | null }
  expect(otp).toMatch(/^\d{6}$/u)
  return otp as string
}

/** Signs a context in over HTTP; its pages then share the session cookie. */
async function signInContext(context: BrowserContext, baseURL: string, email: string) {
  const headers = { origin: new URL(baseURL).origin }
  const requested = await context.request.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers
  })
  expect(requested.status(), await requested.text()).toBe(200)
  const signedIn = await context.request.post('/api/auth/sign-in/email-otp', {
    data: { email, otp: await outboxCode(context.request, email) },
    headers
  })
  expect(signedIn.status(), await signedIn.text()).toBe(200)
}

interface OutboxMessage {
  subject: string
  text: string
}

async function emailsTo(request: APIRequestContext, to: string): Promise<OutboxMessage[]> {
  const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { messages: OutboxMessage[] }).messages
}

async function chooseCategory(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Primary category' }).click()
  // The list opens below its trigger (alignItemWithTrigger off), and its popup, which scrolls
  // the 140-odd categories, is capped at max-h-80 (320 px) (#241, #186).
  await expect(page.getByRole('listbox')).toBeVisible()
  const popup = page.locator('[data-slot="select-content"]')
  const box = await popup.boundingBox()
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320)
  await page.getByRole('option', { name, exact: true }).click()
}

async function typeWebsite(page: Page, website: string) {
  const field = page.getByLabel('Website URL')
  await field.fill(website)
  await field.blur()
}

test.describe('submit v2', () => {
  test('fills the form signed out, signs in, saves the draft, chooses free, and verifies the badge', async ({
    browser
  }) => {
    test.setTimeout(150_000)
    const label = `quill-${unique()}`
    const productName = `Quillmate ${label.slice(-5)}`
    const email = `e2e-submit-${unique()}@example.com`
    fixture.set(label, {
      badge: 'missing',
      description: 'Turns rough product notes into on-brand landing pages, emails, and ads.',
      name: productName
    })
    const slug = fixture.slug(label)
    const context = await newClient(browser)
    const page = await context.newPage()

    // Signed out: the form is open, and says sign-in comes when continuing.
    await page.goto('/submit/')
    await expect(page.getByRole('heading', { level: 1, name: 'Submit a product' })).toBeVisible()
    await expect(page.getByText('Sign in when you’re ready')).toBeVisible()

    // Prefill proposes the name, short description, and logo; the category stays empty.
    await typeWebsite(page, fixture.website(label))
    await expect(page.getByText('Details found')).toBeVisible()
    await expect(page.getByText(`We filled in 3 fields from ${slug}`)).toBeVisible()
    await expect(page.getByLabel('Name')).toHaveValue(productName)
    await expect(page.getByText('From og:site_name')).toBeVisible()
    await expect(page.getByLabel('Short description')).toHaveValue(
      'Turns rough product notes into on-brand landing pages, emails, and ads.'
    )
    await expect(page.getByText('From meta description')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Site icon' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.getByText('Pick the closest match. We don’t fill this in.')).toBeVisible()

    // Every proposal stays editable.
    const description = 'Drafts landing pages and emails from product notes, in your voice.'
    await page.getByLabel('Short description').fill(description)
    await expect(page.getByText('From meta description')).toHaveCount(0)
    await chooseCategory(page, CATEGORY)

    // Continue signed out: the draft stays in this browser through the email-code sign-in.
    await page.getByRole('button', { name: 'Sign in and continue' }).click()
    await page.waitForURL(/\/login\/\?callbackUrl=%2Fsubmit%2F$/u)
    await expect(page.getByText(`Your ${productName} draft is saved`)).toBeVisible()
    await expect(page.getByText('Sign in to finish submitting it.')).toBeVisible()
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Email me a code' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await page.locator('#code').fill(await outboxCode(page.request, email))
    await expect(
      page.getByText('Taking you back to Submit, where your draft is waiting.')
    ).toBeVisible()
    await page.waitForURL(url => url.pathname === '/submit/')

    // Back on Submit, signed in, with the draft restored.
    await expect(page.getByLabel('Website URL')).toHaveValue(fixture.website(label))
    await expect(page.getByLabel('Name')).toHaveValue(productName)
    await expect(page.getByLabel('Short description')).toHaveValue(description)
    await expect(page.getByRole('combobox', { name: 'Primary category' })).toContainText(CATEGORY)
    await expect(page.getByText('Sign in when you’re ready')).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue' }).click()

    // 2b: the draft is saved (no plan yet), with both plans: orders are on (#68, #133).
    await page.waitForURL(/\/submit\/[0-9a-f-]{36}\/choose\/\?saved=1$/u)
    const submissionId = new URL(page.url()).pathname.split('/')[2] as string
    await expect(page.getByText('Details saved')).toBeVisible()
    await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Choose how to get listed' })).toBeVisible()
    await expect(page.getByText('Skip the badge: $49 one-off')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Pay $49 and go live' })).toHaveAttribute(
      'href',
      `/submit/${submissionId}/checkout/`
    )

    // The account lists the draft, which can be continued from there.
    await page.goto('/account/')
    const row = page.getByRole('row', { name: new RegExp(productName) })
    await expect(row.getByText('Draft – choose a plan')).toBeVisible()
    await expect(row.getByText('Expires in 30 days')).toBeVisible()
    await row.getByRole('link', { name: 'Continue' }).click()
    await page.waitForURL(`**/submit/${submissionId}/choose/`)
    await expect(page.getByText('Welcome back')).toBeVisible()

    // Free: the badge step, with snippets that link to the future listing.
    await page.getByRole('button', { name: 'Get the badge code' }).click()
    await page.waitForURL(`**/submit/${submissionId}/badge/`)
    await expect(page.getByRole('heading', { name: `Add the badge to ${slug}` })).toBeVisible()
    const listingUrl = `${site.publicUrl}${listingPath(slug)}`
    await expect(page.getByLabel('light badge snippet')).toContainText(listingUrl)
    await expect(page.getByText(`10 of 10`)).toBeVisible()

    // A check before the badge is published: page reached, badge not found, one check used.
    await page.getByRole('button', { name: 'Verify badge' }).click()
    await expect(page.getByText('Page reached, badge not found')).toBeVisible()
    await expect(page.getByText('9 of 10')).toBeVisible()
    await expect(page.getByRole('button', { name: /Check again in 0:[0-3]\d/u })).toBeDisabled()

    // Publish the badge; after the 30-second cooldown, the check passes.
    fixture.update(label, { badge: 'valid' })
    await expect(page.getByRole('button', { name: 'Verify badge' })).toBeEnabled({
      timeout: 40_000
    })
    await page.getByRole('button', { name: 'Verify badge' }).click()
    await expect(page.getByText('Badge verified')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: `${productName} is in the review queue` })
    ).toBeVisible()
    await expect(page.getByText(`We’ll email ${email} with the result.`)).toBeVisible()

    // Both emails went out: "submission received" to the submitter, "ready for review" to the
    // admin recipient.
    await expect
      .poll(async () => (await emailsTo(page.request, email)).map(message => message.subject))
      .toContain(`We received ${productName}`)
    await expect
      .poll(async () =>
        (await emailsTo(page.request, ADMIN_RECIPIENT)).map(message => message.subject)
      )
      .toContain(`Ready for review: ${productName} (free, badge verified)`)
    const adminEmail = (await emailsTo(page.request, ADMIN_RECIPIENT)).find(message =>
      message.subject.includes(productName)
    )
    expect(adminEmail?.text).toContain(email)
    expect(adminEmail?.text).toContain(`/admin/submissions/${submissionId}`)

    await page.goto('/account/')
    await expect(
      page.getByRole('row', { name: new RegExp(productName) }).getByText('In review')
    ).toBeVisible()
    await context.close()
  })

  test('shows every missing field before saving', async ({ baseURL, browser }) => {
    const context = await newClient(browser)
    await signInContext(context, baseURL ?? '', `e2e-submit-empty-${unique()}@example.com`)
    const page = await context.newPage()
    await page.goto('/submit/')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Fix 5 fields to continue')).toBeVisible()
    for (const message of [
      'Enter your website address, starting with https://.',
      'Enter the product name.',
      'Choose a primary category.',
      'Add a short description.',
      'Add a logo. Use the one from your site or paste an image link.'
    ]) {
      await expect(page.getByText(message)).toBeVisible()
    }
    await page.getByLabel('Short description').fill('x'.repeat(170))
    await expect(page.getByText('Keep it to 160 characters or fewer. It’s 170 now.')).toBeVisible()
    await expect(page.getByText('170/160')).toBeVisible()
    await context.close()
  })

  test('blocks already listed, already submitted, and prohibited websites', async ({
    baseURL,
    browser
  }) => {
    test.setTimeout(120_000)
    const origin = new URL(baseURL ?? '').origin
    const id = unique()
    const owner = await newClient(browser)
    await signInContext(owner, baseURL ?? '', `e2e-submit-owner-${id}@example.com`)

    // The owner saves a draft for a domain over the API.
    const iconLabel = `icon-${id}`
    fixture.set(iconLabel, { badge: 'missing', description: 'Icon host.', name: 'Icon host' })
    const pendingWebsite = `https://pending-${id}.example/`
    const created = await owner.request.post('/api/submissions', {
      data: {
        categorySlug: 'video-downloaders',
        content: '',
        description: 'A pending product.',
        logoUrl: `${fixture.website(iconLabel)}icon.png`,
        name: 'Pending product',
        website: pendingWebsite
      },
      headers: { origin }
    })
    expect(created.status(), await created.text()).toBe(201)
    const { submission } = (await created.json()) as { submission: { id: string; status: string } }
    expect(submission.status).toBe('draft')

    // The same domain again (another path, www.) is a duplicate, even over the API.
    const again = await owner.request.post('/api/submissions', {
      data: {
        categorySlug: 'video-downloaders',
        content: '',
        description: 'Again.',
        logoUrl: `${fixture.website(iconLabel)}icon.png`,
        name: 'Again',
        website: `https://www.pending-${id}.example/pricing`
      },
      headers: { origin }
    })
    expect(again.status()).toBe(409)
    expect(await again.json()).toMatchObject({
      availability: { kind: 'pending', mine: { id: submission.id } },
      code: 'duplicate_submission'
    })

    // The owner sees their own submission and can open it.
    const ownerPage = await owner.newPage()
    await ownerPage.goto('/submit/')
    await typeWebsite(ownerPage, pendingWebsite)
    await expect(ownerPage.getByText(`You already submitted pending-${id}.example`)).toBeVisible()
    await expect(ownerPage.getByRole('link', { name: 'Open submission' })).toHaveAttribute(
      'href',
      `/submit/${submission.id}/choose/`
    )
    await expect(ownerPage.getByRole('button', { name: 'Continue' })).toBeDisabled()

    // Anyone else is told it is already in review.
    const visitor = await newClient(browser)
    const page = await visitor.newPage()
    await page.goto('/submit/')
    await typeWebsite(page, `pending-${id}.example/about`)
    await expect(page.getByText(`pending-${id}.example is already in review`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in and continue' })).toBeDisabled()

    // An imported listing: matched on the domain, with a link to claim it (#67).
    await typeWebsite(page, 'https://www.frase.io/pricing')
    await expect(page.getByText(/is already listed on SERP$/u)).toBeVisible()
    await expect(
      page.getByText('We match on the domain, so frase.io/pricing counts as frase.io.')
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Claim this listing' })).toHaveAttribute(
      'href',
      '/products/frase.io/#claim'
    )
    await expect(page.getByRole('button', { name: 'Sign in and continue' })).toBeDisabled()
    const listed = await owner.request.post('/api/submissions', {
      data: {
        categorySlug: 'video-downloaders',
        content: '',
        description: 'Listed.',
        logoUrl: `${fixture.website(iconLabel)}icon.png`,
        name: 'Listed',
        website: 'https://frase.io/pricing'
      },
      headers: { origin }
    })
    expect(listed.status()).toBe(409)
    expect(await listed.json()).toMatchObject({
      availability: { kind: 'listed' },
      code: 'listing_exists'
    })

    // A prohibited block covers the registrable domain and its subdomains.
    executeLocalD1(
      `INSERT INTO listing_submission_url_blocks (url_key,covers_subdomains,reason,blocked_by,blocked_at) VALUES ('prohibited-${id}.example',1,'Prohibited by the Terms','e2e','${new Date().toISOString()}')`
    )
    await typeWebsite(page, `https://go.prohibited-${id}.example/`)
    await expect(page.getByText(`go.prohibited-${id}.example can’t be submitted`)).toBeVisible()
    await expect(
      page.getByText(/rejected this site as prohibited by our Terms of Service/u)
    ).toBeVisible()
    const blocked = await owner.request.post('/api/submissions', {
      data: {
        categorySlug: 'video-downloaders',
        content: '',
        description: 'Blocked.',
        logoUrl: `${fixture.website(iconLabel)}icon.png`,
        name: 'Blocked',
        website: `https://prohibited-${id}.example/`
      },
      headers: { origin }
    })
    expect(blocked.status()).toBe(403)
    expect(await blocked.json()).toMatchObject({ code: 'url_blocked' })

    await owner.close()
    await visitor.close()
  })

  test('reports each badge check outcome and only counts conclusive ones', async ({
    baseURL,
    browser
  }) => {
    const origin = new URL(baseURL ?? '').origin
    const id = unique()
    const owner = await newClient(browser)
    await signInContext(owner, baseURL ?? '', `e2e-submit-checks-${id}@example.com`)
    const headers = { origin }

    async function pendingBadge(label: string, product: Parameters<FixtureSite['set']>[1]) {
      fixture.set(label, product)
      const created = await owner.request.post('/api/submissions', {
        data: {
          categorySlug: 'video-downloaders',
          content: '',
          description: product.description,
          logoUrl: `${fixture.website(label)}icon.png`,
          name: product.name,
          website: fixture.website(label)
        },
        headers
      })
      expect(created.status(), await created.text()).toBe(201)
      const { submission } = (await created.json()) as { submission: { id: string } }
      const chosen = await owner.request.post(`/api/submissions/${submission.id}/plan`, {
        data: { plan: 'free' },
        headers
      })
      expect(chosen.status(), await chosen.text()).toBe(200)
      return submission.id
    }

    async function verify(submissionId: string) {
      const response = await owner.request.post(`/api/submissions/${submissionId}/verify`, {
        data: {},
        headers
      })
      return { body: await response.json(), status: response.status() }
    }

    const nofollow = await pendingBadge(`nofollow-${id}`, {
      badge: 'nofollow',
      description: 'Nofollow badge.',
      name: 'Nofollow'
    })
    const wrong = await pendingBadge(`wrong-${id}`, {
      badge: 'wrong',
      description: 'Wrong destination.',
      name: 'Wrong'
    })
    const down = await pendingBadge(`down-${id}`, {
      badge: 'valid',
      description: 'Site down.',
      name: 'Down'
    })
    fixture.update(`down-${id}`, { status: 503 })
    const metaRobots = await pendingBadge(`robots-${id}`, {
      badge: 'valid',
      description: 'Robots meta.',
      name: 'Robots',
      robots: 'meta'
    })
    const headerRobots = await pendingBadge(`header-${id}`, {
      badge: 'valid',
      description: 'Robots header.',
      name: 'Header',
      robots: 'header'
    })

    expect(await verify(nofollow)).toMatchObject({
      body: {
        result: { code: 'link_not_followed', ok: false, rel: ['nofollow'] },
        submission: { status: 'pending_badge', verificationAttempts: 1 }
      },
      status: 200
    })
    expect(await verify(wrong)).toMatchObject({
      body: {
        result: { code: 'wrong_destination', href: `${site.publicUrl}/`, ok: false },
        submission: { verificationAttempts: 1 }
      }
    })
    // A site that cannot be loaded never uses up a check.
    expect(await verify(down)).toMatchObject({
      body: { result: { code: 'http_503', ok: false }, submission: { verificationAttempts: 0 } }
    })
    // A page that tells crawlers to skip its links fails, however good the badge link is.
    expect(await verify(metaRobots)).toMatchObject({
      body: {
        result: { code: 'page_not_followed', ok: false, source: 'meta' },
        submission: { verificationAttempts: 1 }
      }
    })
    expect(await verify(headerRobots)).toMatchObject({
      body: { result: { code: 'page_not_followed', ok: false, source: 'header' } }
    })
    // One check every 30 seconds. A refusal carries the submission as it is now, so a page
    // that missed a check (another tab) can catch up (PR #84 review round 2, finding 4).
    expect(await verify(nofollow)).toMatchObject({
      body: { code: 'cooldown', submission: { id: nofollow, status: 'pending_badge' } },
      status: 429
    })
    const valid = await pendingBadge(`valid-${id}`, {
      badge: 'valid',
      description: 'Valid badge.',
      name: 'Valid'
    })
    expect(await verify(valid)).toMatchObject({
      body: { result: { ok: true }, submission: { status: 'verified' } },
      status: 200
    })
    expect(await verify(valid)).toMatchObject({
      body: { code: 'not_pending_badge', submission: { id: valid, status: 'verified' } },
      status: 409
    })

    // PR #84 review round 1, finding 2: parallel checks claim one check; the rest get 429.
    const racing = await pendingBadge(`race-${id}`, {
      badge: 'missing',
      description: 'Parallel checks.',
      name: 'Race'
    })
    const answers = await Promise.all(Array.from({ length: 6 }, () => verify(racing)))
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 429, 429, 429, 429, 429])
    for (const answer of answers.filter(item => item.status === 429)) {
      expect(answer.body).toMatchObject({ code: 'cooldown' })
    }
    expect(answers.find(answer => answer.status === 200)?.body).toMatchObject({
      result: { code: 'badge_missing' },
      submission: { verificationAttempts: 1 }
    })
    // Nobody else can check, choose a plan for, or edit the submission.
    const stranger = await newClient(browser)
    await signInContext(stranger, baseURL ?? '', `e2e-submit-stranger-${id}@example.com`)
    const foreign = await stranger.request.post(`/api/submissions/${nofollow}/verify`, {
      data: {},
      headers
    })
    expect(foreign.status()).toBe(404)
    const page = await stranger.newPage()
    const response = await page.goto(`/submit/${nofollow}/badge/`)
    expect(response?.status()).toBe(404)
    // A plan is chosen once.
    const again = await owner.request.post(`/api/submissions/${nofollow}/plan`, {
      data: { plan: 'free' },
      headers
    })
    expect(again.status()).toBe(409)
    await owner.close()
    await stranger.close()
  })

  test('starts one check per burst of clicks and keeps Verify disabled through every wait', async ({
    baseURL,
    browser
  }) => {
    // Owner decision on #84: the first click starts the check, later clicks are ignored, and
    // Verify stays disabled while the check runs and through any wait the server asks for,
    // with no copy beyond the approved countdown. PR #84 review round 2, finding 4: refusals
    // carry the submission, so the page catches up. A spent budget (20 checks an hour) and a
    // check that finished elsewhere are slow to provoke for real, so the test serves those
    // answers in their real shapes; the last check is real.
    const headers = { origin: new URL(baseURL ?? '').origin }
    const id = unique()
    const label = `stale-${id}`
    const owner = await newClient(browser)
    await signInContext(owner, baseURL ?? '', `e2e-submit-stale-${id}@example.com`)
    fixture.set(label, { badge: 'missing', description: 'Stale page.', name: 'Stale' })
    const created = await owner.request.post('/api/submissions', {
      data: {
        categorySlug: 'video-downloaders',
        content: '',
        description: 'Stale page.',
        logoUrl: `${fixture.website(label)}icon.png`,
        name: 'Stale',
        website: fixture.website(label)
      },
      headers
    })
    expect(created.status(), await created.text()).toBe(201)
    const { submission: draft } = (await created.json()) as { submission: { id: string } }
    const chosen = await owner.request.post(`/api/submissions/${draft.id}/plan`, {
      data: { plan: 'free' },
      headers
    })
    expect(chosen.status(), await chosen.text()).toBe(200)
    const { submission } = (await chosen.json()) as {
      submission: { id: string; status: string }
    }
    expect(submission.status).toBe('pending_badge')
    const verifyRoute = `**/api/submissions/${submission.id}/verify`
    const page = await owner.newPage()
    await page.goto(`/submit/${submission.id}/badge/`)
    const verifyButton = page.getByRole('button', { name: 'Verify badge' })
    const checkingButton = page.getByRole('button', { name: 'Checking…' })
    let requests = 0
    const slowly = () => new Promise(resolve => setTimeout(resolve, 1_000))

    // The outbound check budget is spent: a triple click sends one request, and Verify waits
    // out the server's 10 minutes behind the countdown.
    await page.route(verifyRoute, async route => {
      requests += 1
      await slowly()
      await route.fulfill({
        headers: { 'Retry-After': '600' },
        json: {
          code: 'check_budget',
          error: 'Too many checks for now. Try again later.',
          retryAfterSeconds: 600,
          submission
        },
        status: 429
      })
    })
    await verifyButton.click({ clickCount: 3 })
    await expect(checkingButton).toBeDisabled()
    await expect(page.getByRole('button', { name: /Check again in (9:5\d|10:00)/u })).toBeDisabled()
    expect(requests).toBe(1)
    await expect(page.getByText('Too many checks for now')).toHaveCount(0)
    await expect(page.getByText('10 of 10')).toBeVisible()

    // Another tab's check verified it first: three clicks in one tick, before the button can
    // re-render as disabled, still send one request, and the page shows it verified.
    await page.unroute(verifyRoute)
    await page.reload()
    requests = 0
    await page.route(verifyRoute, async route => {
      requests += 1
      await slowly()
      await route.fulfill({
        json: {
          code: 'verification_superseded',
          error: 'Another check of this badge finished first. Reload to see its result.',
          submission: { ...submission, status: 'verified' }
        },
        status: 409
      })
    })
    await verifyButton.evaluate(button => {
      for (let click = 0; click < 3; click += 1) (button as HTMLButtonElement).click()
    })
    await expect(checkingButton).toBeDisabled()
    await expect(page.getByText('Badge verified')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Stale is in the review queue' })).toBeVisible()
    expect(requests).toBe(1)

    // A real check: a double click sends one request, and Verify stays disabled while it runs
    // and through the 30-second cooldown after it.
    await page.unroute(verifyRoute)
    await page.reload()
    requests = 0
    await page.route(verifyRoute, async route => {
      requests += 1
      await slowly()
      await route.continue()
    })
    await verifyButton.dblclick()
    await expect(checkingButton).toBeDisabled()
    await expect(page.getByText('Page reached, badge not found')).toBeVisible()
    await expect(page.getByRole('button', { name: /Check again in 0:[0-3]\d/u })).toBeDisabled()
    await expect(page.getByText('9 of 10')).toBeVisible()
    expect(requests).toBe(1)
    await owner.close()
  })

  test('refuses writes without a session or from another origin', async ({ baseURL, request }) => {
    const body = {
      categorySlug: 'video-downloaders',
      content: '',
      description: 'x',
      logoUrl: 'https://example.com/logo.png',
      name: 'x',
      website: 'https://example.com/'
    }
    const signedOut = await request.post('/api/submissions', {
      data: body,
      headers: { origin: new URL(baseURL ?? '').origin }
    })
    expect(signedOut.status()).toBe(401)
    const crossSite = await request.post('/api/submissions', {
      data: body,
      headers: { origin: 'https://evil.example' }
    })
    expect(crossSite.status()).toBe(403)
    // The prefill reads pages for this site's form only.
    const prefill = await request.post('/api/submissions/prefill', {
      data: { url: 'https://example.com/' },
      headers: { origin: 'https://evil.example' }
    })
    expect(prefill.status()).toBe(403)
  })
})
