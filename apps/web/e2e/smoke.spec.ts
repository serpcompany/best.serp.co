import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { catalogSample, DIRECTORY_PAGE_SIZE, sitemapLocations } from './catalog-sample'
import {
  absoluteUrl,
  categoriesIndexPath,
  categoryPath,
  escapeRegExp,
  featuredBadgeUrls,
  isPlatformOrigin,
  site,
  writtenOrigin
} from './site-fixture'
import { test } from './test'

/**
 * The smoke suite runs locally on the fixture seed (`pnpm test:e2e`, CI's `e2e`) and against
 * staging after each deploy (`pnpm test:e2e:smoke`). Its catalog facts come from `catalogSample`,
 * which keeps the two apart (#313): locally the seed's exact facts, on a deployed Worker the live
 * catalog's counts and a listing read from it. A check that holds only for one of them says so
 * (`source`, or a fact only the seed knows).
 */

/**
 * The origin this Worker writes in its URLs, by the environment it reports: staging writes
 * `https://staging.best.serp.co` (#359), production and local `https://best.serp.co`.
 */
async function originOf(request: APIRequestContext): Promise<string> {
  return writtenOrigin((await request.get('/robots.txt')).headers()['x-site-environment'])
}

async function getSitemap(request: APIRequestContext, path: string): Promise<string[]> {
  const response = await request.get(path)
  expect(response.status(), path).toBe(200)
  expect(response.headers()['content-type']).toContain('xml')
  return sitemapLocations(await response.text())
}

/**
 * `from` answers one 308 whose Location is exactly `to` (path and query), and `to` answers 200
 * without another redirect: one hop to the canonical URL.
 */
async function expectOneHop(request: APIRequestContext, from: string, to: string) {
  const response = await request.get(from, { maxRedirects: 0 })
  expect(response.status(), from).toBe(308)
  const location = response.headers().location
  expect(location, `${from} Location header`).toBeTruthy()
  const target = new URL(location, 'http://placeholder.invalid')
  expect(`${target.pathname}${target.search}`, `${from} Location header`).toBe(to)
  const destination = await request.get(to, { maxRedirects: 0 })
  expect(destination.status(), `${from} -> ${to}`).toBe(200)
}

async function expectServedAsRequested(request: APIRequestContext, path: string) {
  const response = await request.get(path, { maxRedirects: 0 })
  expect(response.status(), path).toBe(200)
}

/**
 * Only best.serp.co (the production Worker on its canonical host) may be indexed or load
 * analytics; local and staging hosts must not (serp standards/environment-configuration.md).
 */
function isPublicProductionOrigin(baseURL: string | undefined): boolean {
  return baseURL !== undefined && new URL(baseURL).host === new URL(site.publicUrl).host
}

function structuredDataUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredDataUrls)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, entry]) =>
    (key === 'url' || key === 'item' || key === '@id') && typeof entry === 'string'
      ? [entry]
      : structuredDataUrls(entry)
  )
}

async function expectCanonical(page: Page, path: string, origin: string) {
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    absoluteUrl(path, origin)
  )
}

/**
 * Every URL on the Worker's own origin in the page's JSON-LD is canonical: the homepage is the
 * bare origin, pages end with a slash (node identifiers may add a `#fragment`), and files have
 * none. A file is a known extension, not any dot: a domain-name slug's page (`/products/<host>`)
 * is a page without its slash. On staging, no URL names best.serp.co (#359).
 */
async function expectCanonicalStructuredData(page: Page, origin: string): Promise<string[]> {
  const structuredData = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
  expect(structuredData.length).toBeGreaterThan(0)
  const linkedUrls = structuredDataUrls(structuredData)
  const canonicalForm = new RegExp(
    `^${escapeRegExp(origin)}(?:/(?:[^#?]*/)?(?:#[\\w-]+)?|/[^#?]*\\.(?:avif|gif|ico|jpe?g|json|png|svg|txt|webp|xml))?$`,
    'iu'
  )
  for (const url of linkedUrls.filter(url => url.startsWith(origin))) {
    expect(url, 'structured data writes the homepage as the bare origin').not.toBe(`${origin}/`)
    expect(url, `structured data should only use canonical ${origin} URLs`).toMatch(canonicalForm)
  }
  if (origin !== site.publicUrl)
    expect(linkedUrls.filter(url => url.startsWith(site.publicUrl))).toEqual([])
  return linkedUrls
}

test.describe('best.serp.co D1 Worker smoke', () => {
  test('renders the SERP homepage with the exact D1 catalog size', async ({
    baseURL,
    page,
    request
  }) => {
    const { listingCount } = await catalogSample(request, baseURL)
    const origin = await originOf(request)
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    // Only staging has a password, and a smoke-test request never meets it (#359).
    expect(response?.headers()['www-authenticate']).toBeUndefined()
    await expect(page).toHaveTitle(site.title)
    await expect(
      page.getByRole('heading', { level: 1, name: site.name, exact: true })
    ).toBeVisible()
    // The hero's eyebrow badge (#257).
    await expect(
      page.getByText(new RegExp(`^${listingCount}\\s+products in directory$`, 'i'))
    ).toBeVisible()
    // The homepage is the bare origin in its canonical, og:url, and structured data.
    await expectCanonical(page, '/', origin)
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', origin)
    await expect(page.locator('meta[property="og:url"]')).toHaveCount(1)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', origin)
    expect(await expectCanonicalStructuredData(page, origin)).toContain(origin)
  })

  test('renders a listing detail page at its canonical URL', async ({ baseURL, page, request }) => {
    const { listing, source } = await catalogSample(request, baseURL)
    const origin = await originOf(request)
    const response = await page.goto(listing.path, { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: listing.namePattern })).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(`${escapeRegExp(listing.name)}.*\\| SERP$`))
    await expectCanonical(page, listing.path, origin)
    // Claims are on (#67, #130): a listing without an owner offers the claim link. The seed's
    // sample listing has no owner; a deployed one may have been claimed.
    const claimLink = page.getByRole('button', { name: 'Claim this listing' })
    await expect(
      source === 'seed'
        ? claimLink
        : claimLink.or(page.getByText('Verified owner', { exact: true })).first()
    ).toBeVisible()

    const linkedUrls = await expectCanonicalStructuredData(page, origin)
    expect(linkedUrls).toContain(absoluteUrl(listing.path, origin))
    // The breadcrumb's Home item is the bare origin.
    expect(linkedUrls).toContain(origin)
  })

  test('answers the retired /news with 410 Gone, without a redirect (#166)', async ({
    request
  }) => {
    for (const path of ['/news', '/news/']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(410)
      expect(response.headers().location, path).toBeUndefined()
    }
  })

  test('permanently redirects the pre-D1 URL scheme to the current routes in one hop', async ({
    baseURL,
    request
  }) => {
    const { category, domainListing, listing } = await catalogSample(request, baseURL)
    const redirects: Array<[string, string]> = [
      [`/products/${listing.slug}/reviews/`, listing.path],
      [`/products/best/${category.slug}/`, categoryPath(category.slug)],
      [`/categories/${category.slug}/`, categoryPath(category.slug)],
      ['/products/best/featured/', categoriesIndexPath],
      ['/products/best/', categoriesIndexPath],
      // Top-level legal pages of the static site and the short legal URLs: each legal page has
      // one canonical URL under /legal/ (#166).
      ['/privacy/', '/legal/privacy-policy/'],
      ['/terms/', '/legal/terms-conditions/'],
      ['/cookies/', '/legal/cookies/'],
      ['/legal/privacy/', '/legal/privacy-policy/'],
      ['/legal/terms/', '/legal/terms-conditions/'],
      // The static site's root-level listing and category URLs (#168).
      [`/${domainListing.slug}/`, domainListing.path],
      [`/${listing.slug}/`, listing.path],
      [`/${category.slug}/`, categoryPath(category.slug)]
    ]
    for (const [from, to] of redirects) {
      // Both slash forms of a moved URL reach the canonical page directly.
      await expectOneHop(request, from, to)
      await expectOneHop(request, from.slice(0, -1), to)
    }
    await expectOneHop(
      request,
      `/${domainListing.slug}?ref=x%26y`,
      `${domainListing.path}?ref=x%26y`
    )
  })

  test('serves one canonical form per URL under the trailing-slash standard', async ({
    baseURL,
    request
  }) => {
    const { category, domainListing, listing, search } = await catalogSample(request, baseURL)
    for (const path of [
      '/',
      '/about/',
      '/products/',
      listing.path,
      domainListing.path,
      '/robots.txt',
      '/sitemap-index.xml',
      '/sitemap-pages.xml'
    ]) {
      await expectServedAsRequested(request, path)
    }

    // Pages gain the slash, files lose it, and the query string is kept exactly.
    const redirects: Array<[string, string]> = [
      ['/about', '/about/'],
      ['/products', '/products/'],
      [listing.path.slice(0, -1), listing.path],
      [domainListing.path.slice(0, -1), domainListing.path],
      [categoryPath(category.slug).slice(0, -1), categoryPath(category.slug)],
      ['/products?page=2', '/products/?page=2'],
      ['/about?q=c%23%20%2B%2B&x=a%26b', '/about/?q=c%23%20%2B%2B&x=a%26b'],
      ['/robots.txt/', '/robots.txt'],
      ['/sitemap-index.xml/', '/sitemap-index.xml'],
      ['/sitemap-pages.xml/', '/sitemap-pages.xml']
    ]
    for (const [from, to] of redirects) {
      await expectOneHop(request, from, to)
    }

    // /api is served exactly as requested, with or without a trailing slash.
    const query = encodeURIComponent(search.query)
    for (const path of [`/api/search?q=${query}`, `/api/search/?q=${query}`]) {
      await expectServedAsRequested(request, path)
    }
    for (const path of ['/api/submissions', '/api/submissions/']) {
      // An oversized body is refused before the handler touches D1, so this writes nothing.
      const response = await request.post(path, {
        data: 'x'.repeat(33_000),
        headers: { 'content-type': 'application/json' },
        maxRedirects: 0
      })
      expect(response.status(), `POST ${path}`).toBe(413)
    }

    // /.well-known paths are never redirected.
    for (const path of ['/.well-known/security.txt', '/.well-known/security.txt/']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status() >= 300 && response.status() < 400, path).toBe(false)
    }
  })

  test('renders category, categories index, product index, and search routes', async ({
    baseURL,
    page,
    request
  }) => {
    const { category, categoryCount, listing, search } = await catalogSample(request, baseURL)
    const origin = await originOf(request)
    const listingLinks = page.locator('main a[href^="/products/"]')

    await page.goto(categoryPath(category.slug), { waitUntil: 'networkidle' })
    // The seed knows the category's name; a deployed category is whatever its heading says.
    await expect(
      page.getByRole('heading', { level: 1, name: category.name ?? /\S/u, exact: true })
    ).toBeVisible()
    await expectCanonical(page, categoryPath(category.slug), origin)
    await expectCanonicalStructuredData(page, origin)
    await expect(page.locator(`main a[href="${listing.path}"]`).first()).toBeVisible()

    await page.goto(categoriesIndexPath, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
    await expectCanonical(page, categoriesIndexPath, origin)
    // Every published category is linked.
    expect(
      await page.locator('main a[href^="/products/categories/"]').count()
    ).toBeGreaterThanOrEqual(categoryCount)
    await expect(
      page.locator(`main a[href="${categoryPath(category.slug)}"]`).first()
    ).toBeVisible()

    await page.goto('/products/', { waitUntil: 'networkidle' })
    // The directory's first page is the homepage's content, so it canonicalizes to `/` (#167).
    await expectCanonical(page, '/', origin)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/u)
    expect(await listingLinks.count()).toBeGreaterThan(0)

    await page.goto(`/search/?q=${encodeURIComponent(search.query)}`, {
      waitUntil: 'networkidle'
    })
    // By name and href: a higher-ranked listing whose name contains this one's ("X Pro") is
    // another link (#313 review).
    await expect(
      page
        .getByRole('link', { name: search.listing.namePattern })
        .and(page.locator(`[href="${search.listing.path}"]`))
        .first()
    ).toHaveAttribute('href', search.listing.path)
  })

  test('paginates the directory and large categories with crawlable links', async ({
    baseURL,
    page,
    request
  }) => {
    const { listingCount, paginatedCategory } = await catalogSample(request, baseURL)
    const origin = await originOf(request)
    const lastDirectoryPage = Math.ceil(listingCount / DIRECTORY_PAGE_SIZE)
    const pagination = page.getByRole('navigation', { name: /pages$/i })

    // The homepage shows directory page 1 and links into /products/?page=N.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(pagination.getByRole('link', { name: 'Page 2' })).toHaveAttribute(
      'href',
      /^\/products\/\?page=2(?:#[\w-]+)?$/u
    )
    expect(await page.locator('main a[href^="/products/"]').count()).toBeGreaterThan(0)

    const second = await page.goto('/products/?page=2', { waitUntil: 'domcontentloaded' })
    expect(second?.status()).toBe(200)
    await expectCanonical(page, '/products/?page=2', origin)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u)
    await expect(page).toHaveTitle(/Page 2/u)
    await expect(pagination.getByRole('link', { name: /previous/i })).toHaveAttribute(
      'href',
      /^\/products\/(?:#[\w-]+)?$/u
    )
    // On to page 3 when there is one (a deployed catalog); the seed's page 2 is its last.
    const next = pagination.getByRole('link', { name: /next/i })
    if (lastDirectoryPage > 2) {
      await expect(next).toHaveAttribute('href', /^\/products\/\?page=3(?:#[\w-]+)?$/u)
    } else {
      await expect(next).toHaveCount(0)
    }

    const last = await request.get(`/products/?page=${lastDirectoryPage}`)
    expect(last.status()).toBe(200)
    expect((await request.get(`/products/?page=${lastDirectoryPage + 1}`)).status()).toBe(404)

    const largePath = categoryPath(paginatedCategory.slug)
    await page.goto(largePath, { waitUntil: 'domcontentloaded' })
    await expectCanonical(page, largePath, origin)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/u)
    await expect(pagination.getByRole('link', { name: 'Page 2' })).toHaveAttribute(
      'href',
      `${largePath}?page=2`
    )
    await page.goto(`${largePath}?page=2`, { waitUntil: 'domcontentloaded' })
    await expectCanonical(page, `${largePath}?page=2`, origin)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    expect(await page.locator('main a[href^="/products/"]').count()).toBeGreaterThan(0)
  })

  test('serves anonymous pages from the edge cache and bypasses private routes', async ({
    baseURL,
    request
  }) => {
    const { search } = await catalogSample(request, baseURL)
    // A unique query string gives this run its own cache entry.
    const path = `/about/?edge-cache-check=${Date.now()}`
    const first = await request.get(path)
    expect(first.status()).toBe(200)
    expect(first.headers()['x-edge-cache']).toBe('MISS')
    await expect(async () => {
      const repeat = await request.get(path)
      expect(repeat.headers()['x-edge-cache']).toBe('HIT')
      expect(repeat.headers()['cache-control']).toBe(first.headers()['cache-control'])
    }).toPass({ timeout: 10_000 })

    const results = await request.get(`/search/?q=${encodeURIComponent(search.query)}`)
    expect(results.headers()['x-edge-cache']).toBe('BYPASS')
  })

  test('never lets a request header reach a page the edge cache serves to others', async ({
    request
  }) => {
    // serpcompany/best.serp.co#41 review: a client's `x-nonce` was rendered into the stored
    // page and served to every later visitor for 24 hours.
    const probe = `e2e-cache-probe-${Date.now()}`
    const path = `/products/?cache-poisoning-check=${Date.now()}`
    const first = await request.get(path, {
      headers: {
        cookie: `theme=${probe}`,
        'x-forwarded-host': `${probe}.example`,
        'x-nonce': probe
      }
    })
    expect(first.status()).toBe(200)
    expect(first.headers()['x-edge-cache']).toBe('MISS')
    expect(await first.text()).not.toContain(probe)
    await expect(async () => {
      const later = await request.get(path)
      expect(later.headers()['x-edge-cache']).toBe('HIT')
      const html = await later.text()
      expect(html).not.toContain(probe)
      expect(html).not.toMatch(/\snonce="/u)
    }).toPass({ timeout: 10_000 })
  })

  test('keeps local and staging hosts out of search indexes and analytics', async ({
    baseURL,
    page,
    request
  }) => {
    test.skip(isPublicProductionOrigin(baseURL), 'best.serp.co is indexable and loads analytics')
    const { search } = await catalogSample(request, baseURL)
    for (const path of [
      '/',
      '/about/',
      '/about',
      '/robots.txt',
      '/sitemap-index.xml',
      '/rss.xml',
      `/api/search?q=${encodeURIComponent(search.query)}`,
      '/not-a-page/'
    ]) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.headers()['x-robots-tag'], path).toMatch(/\bnoindex\b/u)
      expect(response.headers()['x-worker-version'], path).toMatch(/^[\w-]+$/u)
      expect(response.headers()['x-site-environment'], path).toMatch(/^(?:local|staging)$/u)
    }
    const robots = await request.get('/robots.txt')
    const environment = robots.headers()['x-site-environment']
    const text = await robots.text()
    // Staging lets only its auditor in, with best.serp.co's rules (#359); local, nobody.
    if (environment === 'staging') expect(text).toMatch(/^User-agent: \*\nDisallow: \/\n\n/u)
    else expect(text).toBe('User-agent: *\nDisallow: /\n')

    // Neither Google Tag Manager nor the Cloudflare Web Analytics beacon (#170).
    const analyticsRequests: string[] = []
    page.on('request', sent => {
      if (/googletagmanager\.com|cloudflareinsights\.com/u.test(sent.url())) {
        analyticsRequests.push(sent.url())
      }
    })
    const home = await page.goto('/', { waitUntil: 'networkidle' })
    expect(home?.status()).toBe(200)
    const html = (await home?.text()) ?? ''
    expect(html).not.toContain('googletagmanager.com')
    expect(html).not.toContain('cloudflareinsights')
    await expect(page.locator('script#google-tag-manager')).toHaveCount(0)
    expect(analyticsRequests).toEqual([])
  })

  test('sends a workers.dev request without the smoke-test header to the canonical host', async ({
    baseURL,
    request
  }) => {
    test.skip(!isPlatformOrigin(baseURL), 'only a deployed Worker has a workers.dev host')
    // Every other request here carries the smoke-test header (playwright.config.ts); this one
    // must not, so it goes through fetch. The Worker's reported environment names the host its
    // workers.dev host redirects to (#323): staging.best.serp.co on staging.
    const environment = (await request.get('/robots.txt')).headers()['x-site-environment']
    const canonical =
      environment === 'production' || environment === 'staging'
        ? site.canonicalOrigins[environment]
        : undefined
    expect(canonical, `x-site-environment ${environment}`).toBeDefined()
    const from = new URL('/about?smoke=canonical-host', baseURL)
    await expect(async () => {
      const response = await fetch(from, { redirect: 'manual' })
      expect(response.status, from.href).toBe(308)
      expect(response.headers.get('location')).toBe(`${canonical}/about/?smoke=canonical-host`)
    }).toPass({ timeout: 10_000 })
  })

  test("asks for staging's password on staging.best.serp.co, and serves it indexable with it", async ({
    baseURL,
    request
  }) => {
    test.skip(!isPlatformOrigin(baseURL), 'only a deployed Worker has a workers.dev host')
    const environment = (await request.get('/robots.txt')).headers()['x-site-environment']
    test.skip(environment !== 'staging', 'only staging has the password (#359)')
    // Through fetch, so no request carries the smoke-test header (playwright.config.ts).
    const page = new URL('/about/?smoke=staging-access', site.canonicalOrigins.staging)
    const { password, username } = site.stagingAccess
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const probe = await fetch(page, { redirect: 'manual' })
    // Zone protection, not the Worker, can answer a runner (as on best.serp.co, #44).
    test.skip(!probe.headers.get('x-site-environment'), 'the Worker did not answer this runner')
    await expect(async () => {
      const refused = await fetch(page, { redirect: 'manual' })
      expect(refused.status, page.href).toBe(401)
      expect(refused.headers.get('www-authenticate')).toBe(
        'Basic realm="best.serp.co staging", charset="UTF-8"'
      )
      expect(refused.headers.get('cache-control')).toBe('no-store')
      const served = await fetch(page, { headers: { authorization }, redirect: 'manual' })
      expect(served.status).toBe(200)
      expect(served.headers.get('x-robots-tag')).toBeNull()
      expect(await served.text()).toContain(
        `<link rel="canonical" href="${site.canonicalOrigins.staging}/about/"/>`
      )
      const robots = await fetch(new URL('/robots.txt', page), { redirect: 'manual' })
      expect(robots.status).toBe(200)
      expect(await robots.text()).toMatch(/^User-agent: \*\nDisallow: \/\n\n/u)
    }).toPass({ timeout: 10_000 })
  })

  test('renders static, commercial, and legal pages', async ({ page, request }) => {
    const origin = await originOf(request)
    const pages: Array<{ path: string; heading: RegExp }> = [
      { path: '/about/', heading: /^about serp$/i },
      { path: '/brands/', heading: /^brands$/i },
      { path: '/contact/', heading: /^contact serp$/i },
      { path: '/pricing/', heading: /^serp pricing$/i },
      { path: '/sponsor/', heading: /^sponsor serp$/i },
      { path: '/submit/', heading: /^submit a product$/i },
      { path: '/legal/privacy-policy/', heading: /^privacy policy$/i },
      { path: '/legal/terms-conditions/', heading: /^terms of service$/i }
    ]

    for (const { path, heading } of pages) {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status(), path).toBe(200)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      await expect(page).toHaveTitle(/\| SERP$/)
      // Legal pages pass slashless paths to their breadcrumb; its JSON-LD must still be canonical.
      if (path.startsWith('/legal/')) await expectCanonicalStructuredData(page, origin)
    }
  })

  test('serves D1-derived sitemap contracts', async ({ baseURL, request }) => {
    const robots = await request.get('/robots.txt')
    expect(robots.status()).toBe(200)
    const origin = writtenOrigin(robots.headers()['x-site-environment'])
    const url = (path: string) => absoluteUrl(path, origin)
    const robotsText = await robots.text()
    // best.serp.co advertises its sitemaps; staging advertises its own, to its auditor only
    // (#359); every other host disallows crawling.
    if (isPublicProductionOrigin(baseURL))
      expect(robotsText).toContain(`Sitemap: ${url('/sitemap-index.xml')}`)
    else if (origin !== site.publicUrl) {
      expect(robotsText).toMatch(/^User-agent: \*\nDisallow: \/\n\nUser-agent: AhrefsSiteAudit\n/u)
      expect(robotsText).toContain(`Sitemap: ${url('/sitemap-index.xml')}`)
    } else expect(robotsText).toBe('User-agent: *\nDisallow: /\n')

    // Every index entry carries its newest child's lastmod, from D1 (#218).
    const index = await (await request.get('/sitemap-index.xml')).text()
    expect(index.match(/<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/gu)).toHaveLength(3)
    // Root-level child sitemaps (#167); the old URLs and /sitemap.xml answer one 308.
    expect(await getSitemap(request, '/sitemap-index.xml')).toEqual([
      url('/sitemap-pages.xml'),
      url('/sitemap-products.xml'),
      url('/sitemap-categories.xml')
    ])
    for (const [from, to] of [
      ['/sitemap.xml', '/sitemap-index.xml'],
      ['/sitemaps/pages/1.xml', '/sitemap-pages.xml'],
      ['/sitemaps/directory/1.xml', '/sitemap-products.xml'],
      ['/sitemaps/categories/1.xml', '/sitemap-categories.xml']
    ]) {
      await expectOneHop(request, from, to)
      await expectOneHop(request, `${from}/`, to)
    }

    const pages = await getSitemap(request, '/sitemap-pages.xml')
    // The homepage entry is the bare origin; every other page ends with a slash.
    expect(pages).toContain(origin)
    expect(pages).not.toContain(`${origin}/`)
    for (const location of pages.filter(location => location !== origin)) {
      expect(location).toMatch(new RegExp(`^${escapeRegExp(origin)}/.+/$`, 'u'))
    }
    expect(pages).toContain(url('/about/'))
    expect(pages).toContain(url(categoriesIndexPath))
    for (const excluded of [
      '/submit/',
      '/search/',
      '/products/',
      '/legal/privacy-policy/',
      '/legal/terms-conditions/'
    ]) {
      expect(pages).not.toContain(url(excluded))
    }

    const { category, categoryCount, listing, listingCount, paginatedCategory } =
      await catalogSample(request, baseURL)
    const listings = await getSitemap(request, '/sitemap-products.xml')
    expect(listings).toHaveLength(listingCount)
    expect(new Set(listings).size).toBe(listingCount)
    for (const location of listings) {
      expect(location).toMatch(new RegExp(`^${escapeRegExp(origin)}/products/[^/]+/$`, 'u'))
    }
    expect(listings).toContain(url(listing.path))

    const categories = await getSitemap(request, '/sitemap-categories.xml')
    expect(categories).toHaveLength(categoryCount)
    for (const location of categories) {
      expect(location).toMatch(
        new RegExp(`^${escapeRegExp(origin)}/products/categories/[^/]+/$`, 'u')
      )
    }
    expect(categories).toContain(url(categoryPath(category.slug)))
    expect(categories).toContain(url(categoryPath(paginatedCategory.slug)))
    expect(categories).not.toContain(url(categoryPath('featured')))
  })

  test('serves the D1-derived JSON feed', async ({ baseURL, request }) => {
    const feed = await request.get('/rss.xml')
    expect(feed.status()).toBe(200)
    const origin = writtenOrigin(feed.headers()['x-site-environment'])
    expect(feed.headers()['content-type']).toContain('application/json')
    const payload = await feed.json()
    expect(payload.title).toBe(site.name)
    expect(payload.home_page_url).toBe(origin)
    expect(payload.feed_url).toBe(absoluteUrl('/rss.xml', origin))
    const { listing, listingCount } = await catalogSample(request, baseURL)
    expect(payload.items).toHaveLength(listingCount)
    expect(payload.items).toContainEqual(
      expect.objectContaining({
        id: listing.slug,
        title: listing.name,
        url: absoluteUrl(listing.path, origin)
      })
    )
  })

  test('serves the featured-on badges', async ({ request }) => {
    for (const badgeUrl of Object.values(featuredBadgeUrls)) {
      const response = await request.get(new URL(badgeUrl).pathname)
      expect(response.status(), badgeUrl).toBe(200)
      expect(response.headers()['content-type']).toContain('image/svg+xml')
      expect(await response.text()).toContain('<svg')
    }
  })

  test('tags every serp.ly link with the Dub partner ID', async ({ baseURL, page, request }) => {
    // The footer's social links on every page, and a listing's "Visit Site" button and resource
    // links when they are serp.ly links (#169); a body-text link is the Markdown components'
    // unit test (`mdx-components.test.tsx`). The listing goes last for the check below.
    const { listing } = await catalogSample(request, baseURL)
    for (const path of ['/', '/brands/', listing.path]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      const hrefs = await page
        .locator('a[href]')
        .evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href))
      const shortLinks = hrefs.filter(href => new URL(href).hostname === 'serp.ly')
      expect(shortLinks.length, `${path} renders serp.ly links`).toBeGreaterThan(0)
      for (const href of shortLinks) {
        expect(new URL(href).searchParams.get('via'), href).toBe(site.dubPartnerId)
      }
    }
    const visitSite = page.getByRole('link', { name: /visit site/i }).first()
    await expect(visitSite).toHaveAttribute('href', /^https?:\/\//u)
    // The seed's website is no serp.ly link, so it is left exactly as stored.
    if (listing.website) await expect(visitSite).toHaveAttribute('href', listing.website)
  })

  test('has no horizontal overflow on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/', { waitUntil: 'networkidle' })
    const heroName = page.getByRole('heading', { level: 1, name: site.name, exact: true })
    expect(
      await heroName.evaluate(
        element => element.getBoundingClientRect().right <= document.documentElement.clientWidth
      )
    ).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      )
    ).toBe(false)
  })
})
