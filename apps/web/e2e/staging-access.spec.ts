import { type APIRequestContext, expect, request as playwrightRequest } from '@playwright/test'
import { categoryPath, listingPath, site } from './site-fixture'
import {
  STAGING_ACCESS_TEST_PASSWORD,
  seedStagingAccessCatalog,
  stagingAccessCategory,
  stagingAccessListing,
  stagingAccessOrigin,
  stagingAccessSuiteEnabled,
  stagingAuthorization
} from './staging-access-fixture'
import { expectedResponse, test } from './test'

/**
 * Staging's password (serpcompany/best.serp.co#359; serp `standards/staging-access.md`) in the
 * built Worker. A local Worker started with `LOCAL_STAGING_ACCESS=on` serves as staging does
 * (`e2e/staging-access-fixture.ts`): without the password every route answers 401, except
 * robots.txt, the billing webhook and smoke-test requests, which keep their noindex; with it, the
 * site is indexable and canonical on staging's own host, as best.serp.co is on its own.
 */

test.skip(
  !stagingAccessSuiteEnabled,
  'needs the local staging-access Worker from playwright.config.ts'
)
// One worker seeds the suite's D1 once, then the tests share it.
test.describe.configure({ mode: 'serial' })

const STAGING_ORIGIN = 'https://staging.best.serp.co'
const CHALLENGE = 'Basic realm="best.serp.co staging", charset="UTF-8"'
/** Staging's robots.txt: production's rules for its auditor, nothing for anyone else. */
const STAGING_ROBOTS_TXT = [
  'User-agent: *',
  'Disallow: /',
  '',
  'User-agent: AhrefsSiteAudit',
  'Allow: /',
  'Disallow: /search',
  'Disallow: /submit',
  '',
  `Sitemap: ${STAGING_ORIGIN}/sitemap-index.xml`,
  ''
].join('\n')

const listing = listingPath(stagingAccessListing.slug)
const category = categoryPath(stagingAccessCategory.slug)
const pages = ['/', '/about/', listing, category, '/products/categories/', '/brands/']
const files = ['/sitemap-index.xml', '/sitemap-products.xml', '/rss.xml']

let anonymous: APIRequestContext
let authorized: APIRequestContext

test.beforeAll(async () => {
  seedStagingAccessCatalog()
  anonymous = await playwrightRequest.newContext({ baseURL: stagingAccessOrigin() })
  authorized = await playwrightRequest.newContext({
    baseURL: stagingAccessOrigin(),
    extraHTTPHeaders: { authorization: stagingAuthorization() }
  })
})

test.afterAll(async () => {
  await anonymous?.dispose()
  await authorized?.dispose()
})

/** Every absolute URL a page writes in an attribute or its JSON-LD. */
function writtenUrls(html: string): string[] {
  const attributes = [...html.matchAll(/\s(?:href|src|content)="(https?:\/\/[^"]+)"/gu)].map(
    match => match[1] ?? ''
  )
  const structured = [
    ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/gu)
  ].flatMap(match => [...(match[1] ?? '').matchAll(/"(https?:\/\/[^"]+)"/gu)].map(url => url[1]))
  return [...attributes, ...structured].map(url => url ?? '')
}

function canonicalOf(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]+)"/u.exec(html)?.[1]
}

test.describe('without the password', () => {
  test('every route answers 401 with a Basic challenge, never the page', async () => {
    const routes = [
      ...pages,
      ...files,
      '/about',
      `/${stagingAccessListing.slug}/`,
      '/news',
      '/not-a-page/',
      '/robots.txt/',
      '/api/search?q=staging',
      '/api/auth/get-session',
      '/admin/',
      '/login/'
    ]
    for (const path of routes) {
      const attempts: Record<string, string>[] = [
        {},
        { authorization: stagingAuthorization('wrong') }
      ]
      for (const headers of attempts) {
        const response = await anonymous.get(path, { headers, maxRedirects: 0 })
        expect(response.status(), path).toBe(401)
        expect(response.headers()['www-authenticate'], path).toBe(CHALLENGE)
        expect(response.headers()['cache-control'], path).toBe('no-store')
        expect(response.headers()['x-robots-tag'], path).toBe('noindex, nofollow')
        expect(response.headers()['x-edge-cache'], path).toBeUndefined()
        expect(await response.text(), path).not.toContain(stagingAccessListing.name)
      }
    }
    const post = await anonymous.post('/api/submissions', { data: {}, maxRedirects: 0 })
    expect(post.status()).toBe(401)
  })

  test("serves robots.txt: production's rules for the auditor, nothing for anyone else", async () => {
    for (const context of [anonymous, authorized]) {
      const robots = await context.get('/robots.txt')
      expect(robots.status()).toBe(200)
      expect(await robots.text()).toBe(STAGING_ROBOTS_TXT)
      expect(robots.headers()['x-robots-tag']).toBe('noindex, nofollow')
    }
  })

  test('lets the billing webhook through to its own signature check', async () => {
    for (const path of ['/api/billing/webhook/', '/api/billing/webhook']) {
      const response = await anonymous.post(path, {
        data: '{}',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
        maxRedirects: 0
      })
      expect(response.status(), path).not.toBe(401)
      expect(response.headers()['www-authenticate'], path).toBeUndefined()
      expect(response.headers()['x-robots-tag'], path).toBe('noindex, nofollow')
    }
    expect((await anonymous.get('/api/billing/webhook/', { maxRedirects: 0 })).status()).toBe(401)
  })

  test("serves smoke-test requests as CI sends them: staging's page, noindex", async () => {
    const smokeRequests: Record<string, string>[] = [
      { [site.smokeTestHeader]: '1' },
      { [site.smokeTestHeader]: '1', authorization: stagingAuthorization() }
    ]
    for (const headers of smokeRequests) {
      const response = await anonymous.get('/about/', { headers })
      expect(response.status()).toBe(200)
      expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow')
      expect(canonicalOf(await response.text())).toBe(`${STAGING_ORIGIN}/about/`)
    }
  })
})

test.describe('with the password', () => {
  test('pages are indexable and canonical on staging, whatever the username', async () => {
    for (const username of ['staging', '', 'ahrefs']) {
      const response = await anonymous.get('/about/', {
        headers: { authorization: stagingAuthorization(STAGING_ACCESS_TEST_PASSWORD, username) }
      })
      expect(response.status(), username).toBe(200)
      expect(response.headers()['x-robots-tag'], username).toBeUndefined()
    }
    for (const path of pages) {
      const response = await authorized.get(path)
      expect(response.status(), path).toBe(200)
      expect(response.headers()['x-robots-tag'], path).toBeUndefined()
      expect(response.headers()['www-authenticate'], path).toBeUndefined()
      const html = await response.text()
      expect(html, path).toMatch(/<meta name="robots" content="index, follow"/u)
      expect(canonicalOf(html), path).toBe(
        path === '/' ? STAGING_ORIGIN : `${STAGING_ORIGIN}${path}`
      )
      expect(html, path).toContain(`<meta property="og:url" content="${canonicalOf(html)}"/>`)
      // Staging's own host in every absolute URL it writes about itself; none on best.serp.co.
      const urls = writtenUrls(html)
      expect(urls.filter(url => url.startsWith(STAGING_ORIGIN)).length, path).toBeGreaterThan(0)
      expect(
        urls.filter(url => url.startsWith(site.publicUrl)),
        path
      ).toEqual([])
    }
  })

  test("sitemaps and the feed list staging's own URLs", async () => {
    const index = await (await authorized.get('/sitemap-index.xml')).text()
    expect(index).toContain(`<loc>${STAGING_ORIGIN}/sitemap-products.xml</loc>`)
    const products = await authorized.get('/sitemap-products.xml')
    expect(products.headers()['x-robots-tag']).toBeUndefined()
    const productXml = await products.text()
    expect(productXml).toContain(`<loc>${STAGING_ORIGIN}${listing}</loc>`)
    expect(await (await authorized.get('/sitemap-categories.xml')).text()).toContain(
      `<loc>${STAGING_ORIGIN}${category}</loc>`
    )
    const pagesXml = await (await authorized.get('/sitemap-pages.xml')).text()
    expect(pagesXml).toContain(`<loc>${STAGING_ORIGIN}</loc>`)
    for (const xml of [index, productXml, pagesXml]) expect(xml).not.toContain(site.publicUrl)
    const feed = await (await authorized.get('/rss.xml')).json()
    expect(feed.home_page_url).toBe(STAGING_ORIGIN)
    expect(feed.feed_url).toBe(`${STAGING_ORIGIN}/rss.xml`)
    expect(feed.items).toContainEqual(
      expect.objectContaining({ url: `${STAGING_ORIGIN}${listing}` })
    )
  })

  test('redirects stay on staging', async () => {
    for (const [from, to] of [
      ['/about', '/about/'],
      [`/${stagingAccessListing.slug}/`, listing],
      ['/products/best/', '/products/categories/'],
      ['/sitemap.xml', '/sitemap-index.xml']
    ]) {
      const response = await authorized.get(from, { maxRedirects: 0 })
      expect(response.status(), from).toBe(308)
      const location = response.headers().location ?? ''
      // Relative, or absolute on staging: never best.serp.co.
      expect(new URL(location, STAGING_ORIGIN).href, from).toBe(`${STAGING_ORIGIN}${to}`)
      expect(response.headers()['x-robots-tag'], from).toBeUndefined()
    }
  })
})

test.describe('the edge cache', () => {
  test('never serves a stored page across the password, and never stores a 401', async () => {
    const path = `/about/?staging-cache-check=${Date.now()}`
    const refused = await anonymous.get(path)
    expect(refused.status()).toBe(401)
    const first = await authorized.get(path)
    expect(first.status()).toBe(200)
    expect(first.headers()['x-edge-cache']).toBe('MISS')
    await expect(async () => {
      const repeat = await authorized.get(path)
      expect(repeat.headers()['x-edge-cache']).toBe('HIT')
      expect(repeat.headers()['x-robots-tag']).toBeUndefined()
    }).toPass({ timeout: 10_000 })
    // Stored for a request with the password: still 401 without it, still noindex for CI.
    const after = await anonymous.get(path)
    expect(after.status()).toBe(401)
    expect(await after.text()).not.toContain('<html')
    const smoke = await anonymous.get(path, { headers: { [site.smokeTestHeader]: '1' } })
    expect(smoke.headers()['x-edge-cache']).toBe('HIT')
    expect(smoke.headers()['x-robots-tag']).toBe('noindex, nofollow')
  })
})

test.describe('in a browser', () => {
  test.use({
    allowedConsoleErrors: {
      because: 'the anonymous visit is refused on purpose',
      patterns: [expectedResponse(401, /\//u)]
    }
  })

  test('asks for the password, then serves the site with it', async ({ browser }) => {
    const refused = await browser.newContext()
    try {
      const page = await refused.newPage()
      const response = await page.goto(`${stagingAccessOrigin()}/`)
      expect(response?.status()).toBe(401)
    } finally {
      await refused.close()
    }

    const signedIn = await browser.newContext({
      httpCredentials: { password: STAGING_ACCESS_TEST_PASSWORD, username: 'staging' }
    })
    try {
      const page = await signedIn.newPage()
      const response = await page.goto(`${stagingAccessOrigin()}${category}`, {
        waitUntil: 'networkidle'
      })
      expect(response?.status()).toBe(200)
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${STAGING_ORIGIN}${category}`
      )
      // A client-side navigation fetches its RSC payload behind the same password.
      await page.locator(`main a[href="${listing}"]`).first().click()
      await expect(page).toHaveURL(new RegExp(`${listing.replaceAll('.', '\\.')}$`, 'u'))
      await expect(
        page.getByRole('heading', { level: 1, name: stagingAccessListing.name })
      ).toBeVisible()
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${STAGING_ORIGIN}${listing}`
      )
    } finally {
      await signedIn.close()
    }
  })
})
