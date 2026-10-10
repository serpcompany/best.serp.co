import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, request as playwrightRequest } from '@playwright/test'
import {
  ADMIN_EMAIL_PREFIXES,
  activeCategory,
  adminOrigin,
  adminSuiteEnabled,
  client,
  localD1,
  q,
  removeAdmin,
  removeLeftoverAdmins,
  seedAdminCatalog,
  seedImportedListing,
  seedVerifiedSubmission,
  signIn,
  signInAsNewAdmin,
  unique
} from './admin-fixture'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because:
      'unpublishing a listing makes its page answer 410, an invalid logo URL is refused with 422, and the listing editor intermittently hits a Server Components render error until #204 fixes it',
    patterns: [
      expectedResponse(410, /\/products\//u),
      expectedResponse(422, /\/api\/admin\/listings\/[^/]+\/details/u),
      // #204: remove once the listing editor's render error is fixed.
      /^console\.error on http:\/\/127\.0\.0\.1:\d+\/admin\/listings\/[^/]+\/: (?:\[ERROR\] )?(?:Error: )?Minified React error #441;/u
    ]
  }
})

/**
 * The admin panel (serpcompany/best.serp.co#64) against the local Worker and local D1: the
 * gate, approving (the listing page and the sitemap after the epoch bump), requesting changes,
 * rejecting, allowing resubmission, unpublishing (410, out of the sitemap and search) and
 * republishing, a listing's tags (#341), and the allowlist. Each decision (approve, request changes, reject, allow
 * resubmission, unpublish, republish, add and remove an admin) is replayed once to prove it is a
 * no-op. The gate is probed on every admin page and API action.
 *
 * Set ADMIN_SCREENSHOT_DIRECTORY to save the screens compared against the #70 mockups.
 */

test.skip(!adminSuiteEnabled, 'needs the local admin Worker from playwright.config.ts')
test.describe.configure({ mode: 'serial' })
test.use({ baseURL: adminOrigin() })

const screenshots = process.env.ADMIN_SCREENSHOT_DIRECTORY
  ? resolve(process.env.ADMIN_SCREENSHOT_DIRECTORY)
  : null

async function capture(page: Page, name: string): Promise<void> {
  if (!screenshots) return
  mkdirSync(screenshots, { recursive: true })
  // A tall viewport rather than `fullPage`, which the fixed sidebar makes unreliable.
  await page.setViewportSize({ height: 1200, width: 1280 })
  // Let logo fallbacks settle (fixture logos point at hosts that do not resolve).
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await page.screenshot({ path: resolve(screenshots, `${name}.png`) })
}

function submissionRow(id: string) {
  return localD1<Record<string, unknown>>(
    `SELECT status, listing_id, reviewer_note, rejection_category, reviewed_by
    FROM listing_submissions WHERE id = ${q(id)}`
  )[0]
}

/**
 * Publications this listing's decisions recorded. The suite shares its D1 with the account
 * dashboard suite, which publishes too, so the global version can move between two reads
 * (#102 review round 2); the runs for this listing's route cannot.
 */
function publicationsFor(slug: string): number {
  return Number(
    localD1<{ count: number }>(
      `SELECT COUNT(*) AS count FROM publication_runs WHERE affected_routes = ${q(`/products/${slug}/`)}`
    )[0]?.count
  )
}

const admins: string[] = []
test.beforeAll(() => {
  seedAdminCatalog()
  // Admins a run that was interrupted left behind (its own local D1 only).
  removeLeftoverAdmins([ADMIN_EMAIL_PREFIXES.adminPanel, ADMIN_EMAIL_PREFIXES.adminPanelAdded])
})
test.afterAll(() => {
  for (const email of admins) removeAdmin(email)
})

/** Every admin page (dynamic segments filled with ids that do not exist) and the catch-all. */
const ADMIN_PAGES = [
  '/admin/',
  '/admin/admins/',
  '/admin/listings/',
  '/admin/listings/e2e-missing/',
  '/admin/orders/',
  '/admin/revisions/e2e-missing/',
  '/admin/submissions/',
  '/admin/submissions/e2e-missing/',
  '/admin/not-a-page/'
]
/** Every admin API action, by method; the authorization runs before any action dispatch. */
const ADMIN_ACTIONS: Array<['DELETE' | 'POST', string]> = [
  ['POST', '/api/admin/admins'],
  ['DELETE', '/api/admin/admins'],
  ['POST', '/api/admin/not-an-action'],
  ...[
    'allow-resubmission',
    'details',
    'link-rel',
    'remove-owner',
    'republish',
    'tags',
    'transfer-owner',
    'unpublish'
  ].map((action): ['POST', string] => ['POST', `/api/admin/listings/lst_missing/${action}`]),
  ...['refund', 'refund-preview'].map((action): ['POST', string] => [
    'POST',
    `/api/admin/orders/ord_missing/${action}`
  ]),
  ...['approve', 'reject', 'request-changes'].map((action): ['POST', string] => [
    'POST',
    `/api/admin/revisions/rev_missing/${action}`
  ]),
  ...['allow-resubmission', 'approve', 'reject', 'request-changes'].map(
    (action): ['POST', string] => ['POST', `/api/admin/submissions/e2e-missing/${action}`]
  )
]

/**
 * Every `name` file whose URL path starts with `/<prefix>/`. Route groups such as `(dashboard)`
 * drop out first, so a file is found by its URL in any group or none.
 */
function appFiles(prefix: string, name: string): string[] {
  const app = resolve(__dirname, '../src/app')
  return readdirSync(app, { encoding: 'utf8', recursive: true })
    .filter(file => file === name || file.endsWith(`/${name}`))
    .map(file => `/${file.slice(0, -name.length)}`.replace(/\/\([^/)]+\)/gu, ''))
    .filter(path => path.startsWith(`/${prefix}/`))
}

/** A route file's path as a pattern: `[id]` matches one segment, `[...path]` one or more. */
function routePattern(route: string): RegExp {
  const pattern = route
    .replace(/\[\[\.\.\.[^\]]+\]\]\/$/u, '(?:.+/)?')
    .replace(/\[\.\.\.[^\]]+\]/gu, '.+')
    .replace(/\[[^\]]+\]/gu, '[^/]+')
  return new RegExp(`^${pattern}$`, 'u')
}

test.describe('admin gate', () => {
  test('lists every admin page, API route, and action', () => {
    for (const page of appFiles('admin', 'page.tsx')) {
      expect(
        ADMIN_PAGES.some(path => routePattern(page).test(path)),
        page
      ).toBe(true)
    }
    const app = resolve(__dirname, '../src/app')
    for (const route of appFiles('api/admin', 'route.ts')) {
      const paths = ADMIN_ACTIONS.map(([, path]) => `${path}/`)
      expect(
        paths.some(path => routePattern(route).test(path)),
        route
      ).toBe(true)
      if (!route.endsWith('/[action]/')) continue
      // Each action the route dispatches on (`case 'x'`, `action === 'x'`) is probed.
      const source = readFileSync(resolve(app, `.${route}route.ts`), 'utf8')
      for (const [, action] of source.matchAll(/(?:case|action [!=]==) '([a-z-]+)'/gu)) {
        const path = route.replace('[id]', '[^/]+').replace('[action]', action as string)
        expect(
          paths.some(probed => new RegExp(`^${path}$`, 'u').test(probed)),
          path
        ).toBe(true)
      }
    }
  })

  test('blocks anonymous visitors and signed-in users who are not admins', async ({
    baseURL,
    request
  }) => {
    test.setTimeout(120_000)
    const origin = new URL(baseURL ?? '').origin
    const anonymous = await playwrightRequest.newContext({ baseURL })
    try {
      for (const path of ADMIN_PAGES) {
        expect((await anonymous.get(path, { maxRedirects: 0 })).status(), path).toBe(401)
      }
      for (const [method, path] of ADMIN_ACTIONS) {
        const response = await anonymous.fetch(path, {
          data: { expectedContentVersion: 1 },
          headers: { origin },
          method
        })
        expect(response.status(), `${method} ${path}`).toBe(401)
      }
    } finally {
      await anonymous.dispose()
    }

    const member = client(request, baseURL)
    await signIn(member, `e2e-member-${unique()}@example.com`)
    for (const path of ADMIN_PAGES) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(403)
    }
    for (const [method, path] of ADMIN_ACTIONS) {
      const response = await request.fetch(path, {
        data: { expectedContentVersion: 1 },
        headers: member.headers,
        method
      })
      expect(response.status(), `${method} ${path}`).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'admin_required' })
    }
  })

  test('requires this site’s Origin on every admin write', async ({ baseURL, request }) => {
    const admin = client(request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    for (const origin of ['https://other.serp.co', undefined]) {
      const response = await request.post('/api/admin/admins', {
        data: { email: 'nobody@example.com' },
        headers: origin ? { origin } : {}
      })
      expect(response.status()).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'origin_rejected' })
    }
    expect(localD1("SELECT email FROM admin_allowlist WHERE email = 'nobody@example.com'")).toEqual(
      []
    )
  })
})

test.describe('shell', () => {
  test('serplists’ sidebar rows, theme row, account menu and sticky top bar (#261)', async ({
    baseURL,
    page
  }) => {
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    await page.goto('/admin/submissions/')
    const nav = page.getByRole('navigation', { name: 'Dashboard' })
    for (const name of ['Review queue', 'Listings', 'Admins', 'View best.serp.co']) {
      await expect(nav.getByRole('link', { name })).toHaveCSS('height', '44px')
    }
    await expect(nav.getByRole('link', { name: 'Review queue' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect(page.locator('main > header')).toHaveCSS('position', 'sticky')

    // The theme row switches the theme; it is a client component, so click until hydrated.
    const html = page.locator('html')
    await expect(async () => {
      await page.getByRole('button', { name: 'Switch to dark mode' }).click()
      await expect(html).toHaveClass(/\bdark\b/u, { timeout: 2_000 })
    }).toPass()
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(html).not.toHaveClass(/\bdark\b/u)

    await page.getByRole('button', { name: 'Account menu' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Switch to Account' })).toHaveAttribute(
      'href',
      '/account/'
    )
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  })
})

test.describe('review decisions', () => {
  test('approving publishes the listing to its page and the sitemap; a replay is a no-op', async ({
    baseURL,
    page
  }) => {
    test.setTimeout(180_000)
    const submission = seedVerifiedSubmission('approve', activeCategory())
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))

    await page.goto('/admin/submissions/')
    await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible()
    await page.getByPlaceholder('Filter by name or domain…').fill(submission.slug)
    await expect(page.getByRole('link', { name: submission.name })).toBeVisible()
    await capture(page, '10-queue')
    await page.getByRole('link', { name: submission.name }).click()

    await expect(page.getByRole('heading', { name: submission.name, level: 1 })).toBeVisible()
    await expect(page.getByText('not public yet')).toBeVisible()
    await capture(page, '11-review-free')
    await page.getByRole('button', { name: 'Edit, then approve' }).click()
    await page.getByLabel('Short description').fill('Edited by the reviewer before approval.')
    await expect(page.getByText('1 field edited.', { exact: false })).toBeVisible()
    await capture(page, '11-review-edit')
    await page.getByRole('button', { name: 'follow', exact: true }).click()
    expect(publicationsFor(submission.slug)).toBe(0)
    await page.getByRole('button', { name: 'Approve with edits' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByText(`Approve and publish ${submission.name}?`)).toBeVisible()
    await capture(page, '11-review-approve-confirm')
    await dialog.getByRole('button', { name: 'Approve and publish' }).click()
    await expect(page.getByText(`Approved. ${submission.name} is published.`)).toBeVisible()

    expect(submissionRow(submission.id)).toMatchObject({
      listing_id: `submission_${submission.id}`,
      status: 'approved'
    })
    expect(publicationsFor(submission.slug)).toBe(1)
    expect(
      localD1(
        `SELECT link_rel, description FROM listings WHERE id = ${q(`submission_${submission.id}`)}`
      )
    ).toEqual([{ description: 'Edited by the reviewer before approval.', link_rel: 'follow' }])

    // The same approval again (a double click or a retry) changes nothing.
    const replay = await page.request.post(`/api/admin/submissions/${submission.id}/approve`, {
      data: { expectedContentVersion: 1 },
      headers: admin.headers
    })
    expect(replay.status()).toBe(200)
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true })
    expect(publicationsFor(submission.slug)).toBe(1)

    // Public: the listing page now answers, and the sitemap lists it once the epoch turns over.
    const visitor = await playwrightRequest.newContext({ baseURL })
    try {
      await expect(async () => {
        const listing = await visitor.get(`/products/${submission.slug}/`)
        expect(listing.status()).toBe(200)
        const html = await listing.text()
        expect(html).toContain(submission.name)
        expect(html).toContain('rel="noopener noreferrer"')
      }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
      await expect(async () => {
        const sitemap = await visitor.get('/sitemap-products.xml')
        expect(await sitemap.text()).toContain(`/products/${submission.slug}/`)
      }).toPass({ intervals: [2_000, 5_000], timeout: 90_000 })
    } finally {
      await visitor.dispose()
    }
  })

  test('requests changes, rejects as prohibited, and allows resubmission; replays are no-ops', async ({
    baseURL,
    page
  }) => {
    test.setTimeout(120_000)
    const category = activeCategory()
    const changes = seedVerifiedSubmission('changes', category)
    const prohibited = seedVerifiedSubmission('prohibited', category)
    const admin = client(page.request, baseURL)
    const adminEmail = await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel)
    admins.push(adminEmail)

    await page.goto(`/admin/submissions/${changes.id}/`)
    await page.getByRole('button', { name: 'Request changes' }).click()
    const changesDialog = page.getByRole('dialog', { name: 'Request changes' })
    await changesDialog.getByLabel('Note to the submitter').fill('Please use a square logo.')
    await capture(page, '11-request-changes')
    await changesDialog.getByRole('button', { name: 'Send request' }).click()
    await expect(page.getByText('Changes requested.')).toBeVisible()
    expect(submissionRow(changes.id)).toMatchObject({
      reviewed_by: adminEmail,
      reviewer_note: 'Please use a square logo.',
      status: 'changes_requested'
    })
    const changesReplay = await page.request.post(
      `/api/admin/submissions/${changes.id}/request-changes`,
      { data: { note: 'Again.' }, headers: admin.headers }
    )
    expect(await changesReplay.json()).toMatchObject({ ok: true, replayed: true })
    expect(submissionRow(changes.id)?.reviewer_note).toBe('Please use a square logo.')

    await page.goto(`/admin/submissions/${prohibited.id}/`)
    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    const rejectDialog = page.getByRole('dialog', { name: `Reject ${prohibited.name}` })
    await rejectDialog.getByLabel('Reason').fill('Sells unlicensed software keys.')
    await rejectDialog.getByText('Prohibited by the Terms').click()
    await capture(page, '11-reject')
    await rejectDialog.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.getByText(`Rejected ${prohibited.name}.`)).toBeVisible()
    expect(submissionRow(prohibited.id)).toMatchObject({
      rejection_category: 'prohibited',
      status: 'rejected'
    })
    expect(
      localD1(
        `SELECT url_key FROM listing_submission_url_blocks WHERE url_key = ${q(prohibited.slug)} AND lifted_at IS NULL`
      )
    ).toHaveLength(1)
    const rejectReplay = await page.request.post(`/api/admin/submissions/${prohibited.id}/reject`, {
      data: { category: 'other', reason: 'Again.' },
      headers: admin.headers
    })
    expect(await rejectReplay.json()).toMatchObject({ ok: true, replayed: true })
    expect(submissionRow(prohibited.id)?.rejection_category).toBe('prohibited')

    await page.getByRole('button', { name: 'Allow resubmission' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Allow resubmission' }).click()
    await expect(page.getByText('Resubmission allowed.')).toBeVisible()
    expect(
      localD1(
        `SELECT lifted_by FROM listing_submission_url_blocks WHERE url_key = ${q(prohibited.slug)}`
      )
    ).toEqual([{ lifted_by: adminEmail }])
    const allowReplay = await page.request.post(
      `/api/admin/submissions/${prohibited.id}/allow-resubmission`,
      { data: {}, headers: admin.headers }
    )
    expect(await allowReplay.json()).toMatchObject({ ok: true, replayed: true })
    expect(
      localD1(
        `SELECT lifted_by FROM listing_submission_url_blocks WHERE url_key = ${q(prohibited.slug)}`
      )
    ).toEqual([{ lifted_by: adminEmail }])
  })
})

test.describe('listings', () => {
  test('unpublishing answers 410 and leaves the sitemap and search; republishing restores', async ({
    baseURL,
    page
  }) => {
    test.setTimeout(240_000)
    const submission = seedVerifiedSubmission('unpublish', activeCategory())
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    const approve = await page.request.post(`/api/admin/submissions/${submission.id}/approve`, {
      data: { expectedContentVersion: 1 },
      headers: admin.headers
    })
    expect(await approve.json()).toMatchObject({ ok: true, replayed: false })

    await page.goto(`/admin/listings/?q=${encodeURIComponent(submission.slug)}`)
    await expect(page.getByRole('link', { name: submission.name })).toBeVisible()
    await capture(page, '12-listings-search')
    await page.getByRole('link', { name: submission.name }).click()
    await expect(page.getByRole('heading', { name: submission.name, level: 1 })).toBeVisible()
    await capture(page, '12-listing-detail')
    await page.getByRole('button', { name: 'Unpublish' }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByLabel('Note for the activity log').fill('Owner asked to take it down.')
    await capture(page, '12-unpublish-confirm')
    await dialog.getByRole('button', { name: 'Unpublish' }).click()
    await expect(page.getByText(`${submission.name} was unpublished.`)).toBeVisible()
    await expect(
      page.getByText('Note: “Owner asked to take it down.”', { exact: false })
    ).toBeVisible()
    await capture(page, '12-listing-unpublished')

    const visitor = await playwrightRequest.newContext({ baseURL })
    try {
      await expect(async () => {
        const gone = await visitor.get(`/products/${submission.slug}/`)
        expect(gone.status()).toBe(410)
        expect(await gone.text()).toContain(`${submission.name} is no longer listed`)
      }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
      const gone = await page.goto(`/products/${submission.slug}/`)
      expect(gone?.status()).toBe(410)
      await expect(page.getByText('Is this your product?')).toBeVisible()
      await capture(page, '09-gone-410')
      await expect(async () => {
        const sitemap = await visitor.get('/sitemap-products.xml')
        expect(await sitemap.text()).not.toContain(`/products/${submission.slug}/`)
        const search = await visitor.get(`/api/search?q=${encodeURIComponent(submission.name)}`)
        expect(await search.text()).not.toContain(submission.slug)
      }).toPass({ intervals: [2_000, 5_000], timeout: 90_000 })

      const replay = await page.request.post(
        `/api/admin/listings/submission_${submission.id}/unpublish`,
        { data: {}, headers: admin.headers }
      )
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true })

      await page.goto(`/admin/listings/${submission.slug}/`)
      await page.getByRole('button', { name: 'Republish' }).click()
      await expect(page.getByText(`${submission.name} is live again.`)).toBeVisible()
      await expect(async () => {
        expect((await visitor.get(`/products/${submission.slug}/`)).status()).toBe(200)
      }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
      const published = publicationsFor(submission.slug)
      const republishReplay = await page.request.post(
        `/api/admin/listings/submission_${submission.id}/republish`,
        { data: {}, headers: admin.headers }
      )
      expect(await republishReplay.json()).toMatchObject({ ok: true, replayed: true })
      expect(publicationsFor(submission.slug)).toBe(published)
    } finally {
      await visitor.dispose()
    }
  })

  test('an unpublished listing filed under a retired category answers 404, as does the category, and stays down (#260)', async ({
    baseURL,
    page
  }) => {
    const retired = `e2e-retired-${unique()}`
    localD1(
      `INSERT INTO categories (slug, name, description, sort_order)
        VALUES (${q(retired)}, 'E2E Retired', 'A category the suite retires.', 9)`
    )
    const removed = seedImportedListing('retired', retired, null)
    const unpublished = seedImportedListing('unpublished', activeCategory(), null)
    // As 2026-10-09-adult-removal.yaml leaves the Adult category: its listings unpublished, then
    // the category retired.
    localD1(`
      UPDATE listings SET is_active = 0 WHERE id IN (${q(removed.id)}, ${q(unpublished.id)});
      UPDATE categories SET is_active = 0 WHERE slug = ${q(retired)};
    `)
    const visitor = await playwrightRequest.newContext({ baseURL })
    try {
      const notFound = await visitor.get(`/products/${removed.slug}/`)
      expect(notFound.status()).toBe(404)
      const body = await notFound.text()
      expect(body).not.toContain('is no longer listed')
      expect(body).not.toContain('Relist it')
      expect((await visitor.get(`/products/categories/${retired}/`)).status()).toBe(404)
      // Unpublished from an active category: still the 410 gone page.
      const gone = await visitor.get(`/products/${unpublished.slug}/`)
      expect(gone.status()).toBe(410)
      expect(await gone.text()).toContain(`${unpublished.name} is no longer listed`)
    } finally {
      await visitor.dispose()
    }

    // The admin panel says why and offers no Republish; the API refuses it too.
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    const reason =
      "It is filed under the retired E2E Retired category, so it stays off the site and can't be republished."
    await page.goto(`/admin/listings/${removed.slug}/`)
    await expect(page.getByRole('heading', { name: removed.name, level: 1 })).toBeVisible()
    await expect(page.getByText(reason, { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Republish' })).toHaveCount(0)
    const refused = await page.request.post(`/api/admin/listings/${removed.id}/republish`, {
      data: {},
      headers: admin.headers
    })
    expect(refused.status()).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: 'listing_category_retired',
      message: reason,
      ok: false
    })
    expect(localD1(`SELECT is_active FROM listings WHERE id = ${q(removed.id)}`)).toEqual([
      { is_active: 0 }
    ])
  })

  test('a retired duplicate answers 410, then 308 to the listing it duplicated once its redirect is published (#338)', async ({
    baseURL
  }) => {
    const kept = seedImportedListing('kept', activeCategory(), null)
    const retired = seedImportedListing('retired', activeCategory(), null)
    // Each step writes what its publisher operation writes (`scripts/d1-publisher.ts`, whose plans
    // and guards `scripts/d1-publisher.sqlite.test.ts` and the workerd suite run) and advances the
    // catalog version, as every publication does. Playwright can't load the publisher itself.
    const publish = (sql: string) =>
      localD1(`${sql}
        UPDATE publication_state SET version = version + 1 WHERE id = 1;`)
    const visitor = await playwrightRequest.newContext({ baseURL })
    try {
      // `listing-unpublish`, as 2026-10-10-duplicate-listings.yaml retires a duplicate: 410.
      publish(`UPDATE listings SET is_active = 0 WHERE id = ${q(retired.id)};`)
      await expect(async () => {
        expect((await visitor.get(`/products/${retired.slug}/`)).status()).toBe(410)
      }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })

      // `listing-slug-redirect`, as 2026-10-10-duplicate-listings-redirects.yaml sends it on.
      publish(`INSERT INTO listing_slug_redirects (listing_id, old_slug, new_slug, manifest_id, reason)
        VALUES (${q(kept.id)}, ${q(retired.slug)}, ${q(kept.slug)}, 'e2e-redirects',
          ${q(`duplicate of ${kept.slug}`)});`)
      await expect(async () => {
        const moved = await visitor.get(`/products/${retired.slug}/`, { maxRedirects: 0 })
        expect(moved.status()).toBe(308)
        expect(new URL(moved.headers().location ?? '', baseURL).pathname).toBe(
          `/products/${kept.slug}/`
        )
      }).toPass({ intervals: [1_000, 2_000, 5_000], timeout: 90_000 })
      expect((await visitor.get(`/products/${kept.slug}/`, { maxRedirects: 0 })).status()).toBe(200)
      // The retired row stays unpublished: out of the sitemap and search, which list the kept one.
      const sitemap = await (await visitor.get('/sitemap-products.xml')).text()
      expect(sitemap).toContain(`/products/${kept.slug}/`)
      expect(sitemap).not.toContain(`/products/${retired.slug}/`)
      const search = async (query: string) =>
        (await visitor.get(`/api/search?q=${encodeURIComponent(query)}`)).text()
      expect(await search(kept.name)).toContain(kept.slug)
      expect(await search(retired.name)).not.toContain(retired.slug)
    } finally {
      await visitor.dispose()
    }
  })

  test('edits imported listings with no logo or a site-relative logo; a new logo is checked and hosted', async ({
    baseURL,
    page
  }) => {
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    const logos = (id: string) =>
      localD1<{ url: string }>(
        `SELECT url FROM listing_media WHERE listing_id = ${q(id)} AND kind = 'logo'`
      )
    const relativeLogo = '/listing-logos/legacy-logo.test/logo.png'
    for (const [label, logo] of [
      ['no-logo', null],
      ['relative-logo', relativeLogo]
    ] as const) {
      const listing = seedImportedListing(label, activeCategory(), logo)
      await page.goto(`/admin/listings/${listing.slug}/`)
      await expect(page.getByRole('heading', { name: listing.name, level: 1 })).toBeVisible()
      await page.getByLabel('Name', { exact: true }).fill(`${listing.name} renamed`)
      await page.getByRole('button', { name: 'Save changes' }).click()
      await expect(page.getByText('Saved.')).toBeVisible()
      expect(localD1(`SELECT name FROM listings WHERE id = ${q(listing.id)}`)).toEqual([
        { name: `${listing.name} renamed` }
      ])
      expect(logos(listing.id)).toEqual(logo ? [{ url: logo }] : [])
      if (logo) {
        // A changed logo still follows the intake's rule: a public http(s) URL.
        await page.reload()
        await page.getByLabel('Logo', { exact: true }).fill('/listing-logos/other.png')
        await page.getByRole('button', { name: 'Save changes' }).click()
        await expect(
          page.getByText('The logo needs a public http or https image URL.').first()
        ).toBeVisible()
        expect(logos(listing.id)).toEqual([{ url: logo }])
        // A valid new logo is copied to the media host first, never stored as a hotlink (#95).
        // This source cannot be fetched, so the logo waits for the media cron behind the tile.
        const unreachable = 'https://unreachable.best-serp-co.test/new-logo.png'
        await page.reload()
        await page.getByLabel('Logo', { exact: true }).fill(unreachable)
        await page.getByRole('button', { name: 'Save changes' }).click()
        // Saved with a warning that names the reason, never a plain "Saved." (#96 review S4).
        await expect(
          page.getByText(
            /^Saved, but the new logo couldn't be copied yet: the site couldn't be reached \(site_unreachable\)/u
          )
        ).toBeVisible()
        await expect(page.getByText('Saved.', { exact: true })).toHaveCount(0)
        expect(logos(listing.id)).toEqual([])
        expect(
          localD1<{ attempts: number; source_url: string; status: string }>(
            `SELECT source_url, status, attempts FROM media_ingestions
              WHERE listing_id = ${q(listing.id)} AND kind = 'logo'`
          )
        ).toEqual([{ attempts: 1, source_url: unreachable, status: 'pending' }])
        await page.reload()
        await expect(page.getByLabel('Logo', { exact: true })).toHaveValue(unreachable)
        await expect(page.getByText(/^Waiting to be hosted after 1 failed attempt/u)).toBeVisible()
      }
    }
  })

  test('edits a listing’s tags grouped by hub, also while its submission is in review (#341)', async ({
    baseURL,
    page
  }) => {
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    const key = unique()
    const hub = { name: `E2E Hub ${key}`, slug: `e2e-hub-${key}` }
    const tag = (label: string) => ({ name: `${label} ${key}`, slug: `e2e-${label}-${key}` })
    const [alpha, beta, gamma, retired] = [tag('alpha'), tag('beta'), tag('gamma'), tag('gone')]
    localD1(`
      INSERT INTO categories (slug, name, description, sort_order)
        VALUES (${q(hub.slug)}, ${q(hub.name)}, '', 9);
      INSERT INTO tags (slug, name, category_id, sort_order)
        SELECT ${q(alpha.slug)}, ${q(alpha.name)}, id, 0 FROM categories WHERE slug = ${q(activeCategory())};
      INSERT INTO tags (slug, name, category_id, sort_order)
        SELECT ${q(beta.slug)}, ${q(beta.name)}, id, 1 FROM categories WHERE slug = ${q(activeCategory())};
      INSERT INTO tags (slug, name, category_id, sort_order)
        SELECT ${q(gamma.slug)}, ${q(gamma.name)}, id, 0 FROM categories WHERE slug = ${q(hub.slug)};
      INSERT INTO tags (slug, name, category_id, sort_order, is_active)
        SELECT ${q(retired.slug)}, ${q(retired.name)}, id, 2, 0 FROM categories WHERE slug = ${q(activeCategory())};
    `)
    const tagsOf = (id: string) =>
      localD1<{ slug: string }>(
        `SELECT t.slug FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
          WHERE lt.listing_id = ${q(id)} ORDER BY lt.sort_order, t.slug`
      ).map(row => row.slug)
    const listing = seedImportedListing('tags', activeCategory(), null)

    await page.goto(`/admin/listings/${listing.slug}/`)
    await expect(page.getByRole('heading', { name: listing.name, level: 1 })).toBeVisible()
    await page.getByLabel('Tags', { exact: true }).click()
    // Active tags only, grouped by hub: the listing's own hub first.
    const listbox = page.getByRole('listbox')
    await expect(listbox.getByRole('option', { name: retired.name })).toHaveCount(0)
    await expect(listbox.getByRole('group', { name: hub.name })).toContainText(gamma.name)
    await expect(listbox.getByRole('group').first()).toContainText(alpha.name)
    await listbox.getByRole('option', { name: gamma.name }).click()
    await listbox.getByRole('option', { name: alpha.name }).click()
    await page.keyboard.press('Escape')
    await capture(page, '12-listing-tags')
    expect(publicationsFor(listing.slug)).toBe(0)
    await page.getByRole('button', { name: 'Save tags' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    expect(tagsOf(listing.id)).toEqual([gamma.slug, alpha.slug])
    expect(publicationsFor(listing.slug)).toBe(1)
    expect(
      localD1<{ detail: string }>(
        `SELECT detail FROM listing_events WHERE listing_id = ${q(listing.id)} AND event_type = 'edited'`
      ).map(row => JSON.parse(row.detail))
    ).toEqual([{ fields: ['tags'], from: [], to: [gamma.slug, alpha.slug] }])

    // A replay is a no-op; a stale view, or a retired tag, changes nothing.
    const post = (data: { expectedTags: string[]; tags: string[] }) =>
      page.request.post(`/api/admin/listings/${listing.id}/tags`, { data, headers: admin.headers })
    const replay = await post({ expectedTags: [], tags: [gamma.slug, alpha.slug] })
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true })
    expect((await post({ expectedTags: [], tags: [beta.slug] })).status()).toBe(409)
    const refused = await post({ expectedTags: [gamma.slug, alpha.slug], tags: [retired.slug] })
    expect(refused.status()).toBe(422)
    expect(tagsOf(listing.id)).toEqual([gamma.slug, alpha.slug])
    expect(publicationsFor(listing.slug)).toBe(1)

    // While its paid submission is in review the details are read-only, but the tags are not:
    // they leave the checksum the approval compares (design 4.3).
    const userId = `e2e-user-tags-${key}`
    localD1(`
      INSERT INTO users (id, name, email, email_verified)
        VALUES (${q(userId)}, 'E2E submitter', ${q(`tags-${key}@example.com`)}, 1);
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, paid_at, listing_id, published_checksum,
        owner_user_id, block_key, block_covers_subdomains)
      SELECT ${q(`e2e-tags-${key}`)}, ${q(`tags-${key}.example`)}, name, description,
        ${q(`https://tags-${key}.example/`)}, content, ${q(activeCategory())},
        ${q(`https://tags-${key}.example/logo.png`)}, 'paid_pending_review', 'paid',
        ${q(new Date().toISOString())}, id, checksum, ${q(userId)}, ${q(`tags-${key}.example`)}, 1
      FROM listings WHERE id = ${q(listing.id)};
    `)
    await page.reload()
    await expect(page.getByText('Its submission is in review')).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled()
    await page.getByLabel('Tags', { exact: true }).click()
    await page.getByRole('listbox').getByRole('option', { name: beta.name }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Save tags' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()
    expect(tagsOf(listing.id)).toEqual([gamma.slug, alpha.slug, beta.slug])
  })

  test('the allowlist adds an admin once and removes it', async ({ baseURL, page }) => {
    const admin = client(page.request, baseURL)
    admins.push(await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.adminPanel))
    const added = `${ADMIN_EMAIL_PREFIXES.adminPanelAdded}-${unique()}@example.com`
    admins.push(added)
    await page.goto('/admin/admins/')
    await expect(page.getByRole('heading', { name: 'Admins' })).toBeVisible()
    await page.getByLabel('Email').fill(added)
    await page.getByRole('button', { name: 'Add admin' }).click()
    await expect(page.getByRole('cell', { name: added })).toBeVisible()
    await page.getByLabel('Email').fill(added)
    await page.getByRole('button', { name: 'Add admin' }).click()
    await expect(page.getByText(`${added} is already an admin.`)).toBeVisible()
    await capture(page, '14-admins-add-error')
    await page.getByRole('row', { name: added }).getByRole('button', { name: 'Remove' }).click()
    await expect(
      page.getByRole('alertdialog').getByText(`Remove ${added} as an admin?`)
    ).toBeVisible()
    await capture(page, '14-admins-remove-confirm')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove admin' }).click()
    await expect(page.getByText(`${added} is no longer an admin.`)).toBeVisible()
    expect(localD1(`SELECT email FROM admin_allowlist WHERE email = ${q(added)}`)).toEqual([])
    const removeReplay = await page.request.delete('/api/admin/admins', {
      data: { email: added },
      headers: admin.headers
    })
    expect(await removeReplay.json()).toMatchObject({ ok: true, replayed: true })
  })
})
