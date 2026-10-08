import { expect } from '@playwright/test'
import { adminSuiteEnabled, client, signIn, unique } from './admin-fixture'
import { detailListing } from './listing-fixture'
import { categoryPath, sampleCategory } from './site-fixture'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because:
      'the dashboards answer a stale session with 401, a member with 403, and an unknown id with 404',
    patterns: [401, 403, 404].map(status => expectedResponse(status, /\/(?:account|admin)\//u))
  }
})

/**
 * Every page renders exactly one `<main>` (#242): the public site's from `SiteChrome`, the
 * dashboards' from their shells, and the 404, 401 and 403 pages from their own boundaries.
 * Counted exactly, so a nested `<main>` fails where `getByRole('main').first()` would pass.
 */
function mainCount(html: string): number {
  return html.match(/<main[\s>]/gu)?.length ?? 0
}

const publicPages = [
  '/',
  '/about/',
  '/brands/',
  '/contact/',
  '/legal/',
  '/legal/privacy-policy/',
  '/pricing/',
  '/sponsor/',
  '/products/',
  '/products/categories/',
  categoryPath(sampleCategory.slug),
  detailListing.path,
  `/search/?q=${detailListing.searchQuery}`,
  '/login/',
  '/submit/'
]

test.describe('one <main> per page', () => {
  test('public pages', async ({ request }) => {
    for (const path of publicPages) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
      expect(mainCount(await response.text()), path).toBe(1)
    }
  })

  test('an unknown URL’s 404', async ({ request }) => {
    const response = await request.get('/no-such-page/')
    expect(response.status()).toBe(404)
    expect(mainCount(await response.text())).toBe(1)
  })

  test('the dashboards, their 404, and their 401 and 403 pages', async ({ baseURL, page }) => {
    test.skip(!adminSuiteEnabled, 'signs in with the local dev code sender')
    if (!baseURL) throw new Error('Playwright baseURL is required.')

    // Next renders these boundaries on the client, so the count is of the hydrated page.
    // A session cookie the Worker's gate lets through, but that names no session: Next's 401.
    await page
      .context()
      .addCookies([{ name: 'better-auth.session_token', url: baseURL, value: 'stale' }])
    expect((await page.goto('/admin/'))?.status()).toBe(401)
    await expect(page.getByText(/not authorized to access this page/u)).toBeVisible()
    await expect(page.locator('main')).toHaveCount(1)
    await page.context().clearCookies()

    await signIn(client(page.request, baseURL), `e2e-landmarks-${unique()}@example.com`)
    const pages: [path: string, status: number, text: RegExp][] = [
      ['/account/', 200, /submissions/iu],
      ['/account/submissions/', 200, /submissions/iu],
      ['/account/submissions/999999999/', 404, /page not found/iu],
      ['/admin/', 403, /could not be accessed/iu]
    ]
    for (const [path, status, text] of pages) {
      expect((await page.goto(path))?.status(), path).toBe(status)
      await expect(page.getByText(text).first(), path).toBeVisible()
      await expect(page.locator('main'), path).toHaveCount(1)
    }
  })
})
