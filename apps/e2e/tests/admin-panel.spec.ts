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
    because: 'unpublishing a listing makes its page answer 410',
    patterns: [expectedResponse(410, /\/products\//u)]
  }
})

/**
 * The admin panel (serpcompany/best.serp.co#64) against the local Worker and local D1: the
 * gate, approving (the listing page and the sitemap after the epoch bump), requesting changes,
 * rejecting, allowing resubmission, unpublishing (410, out of the sitemap and search) and
 * republishing, and the allowlist. Each decision (approve, request changes, reject, allow
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

/** Every `page.tsx` and `route.ts` under `dir`, relative to the app directory. */
function appFiles(dir: string, name: string): string[] {
  const app = resolve(__dirname, '../../web/app')
  return readdirSync(resolve(app, dir), { encoding: 'utf8', recursive: true })
    .filter(file => file === name || file.endsWith(`/${name}`))
    .map(file => `/${dir}/${file.slice(0, -name.length)}`)
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
    const app = resolve(__dirname, '../../web/app')
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
    await page.getByRole('radio', { name: 'follow', exact: true }).click()
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
        const sitemap = await visitor.get('/sitemaps/directory/1.xml')
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
        const sitemap = await visitor.get('/sitemaps/directory/1.xml')
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
    const relativeLogo = '/listing-logos/serpdownloaders.com/logo.png'
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
