import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { detailListing } from './listing-fixture'
import {
  absoluteUrl,
  categoriesIndexPath,
  categoryPath,
  escapeRegExp,
  featuredBadgeUrls,
  listingPath,
  sampleCategory,
  site
} from './site-fixture'
import { test } from './test'

/** Most listing slugs are domain names; their dot is not a file extension. */
const domainSlugListingPath = listingPath('autoenhance.ai')

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
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

/** A local Worker, which serves the reviewed import as is (`pnpm test:e2e`, CI). */
function isLocalOrigin(baseURL: string | undefined): boolean {
  const host = new URL(baseURL ?? 'http://127.0.0.1').hostname
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')
}

/**
 * The live listing count every catalog surface must show. Locally it is exactly the import's.
 * A deployed environment has published reviewed manifests and admin decisions since (#100
 * unpublished 95 listings on staging, release blocker 4), so the count is read from the
 * D1-derived JSON feed there, held to a floor, and the homepage, directory pagination, and
 * sitemap must all agree with it.
 */
async function liveListingCount(
  request: APIRequestContext,
  baseURL: string | undefined
): Promise<number> {
  if (isLocalOrigin(baseURL)) return site.listingCount
  const feed = await request.get('/rss.xml')
  expect(feed.status()).toBe(200)
  const count = ((await feed.json()) as { items: unknown[] }).items.length
  expect(count, 'live listings').toBeGreaterThanOrEqual(site.minimumDeployedListingCount)
  expect(count, 'live listings').toBeLessThanOrEqual(site.listingCount + 1000)
  return count
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

async function expectCanonical(page: Page, path: string) {
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', absoluteUrl(path))
}

/**
 * Every best.serp.co URL in the page's JSON-LD is canonical: the homepage is the bare origin,
 * pages end with a slash (node identifiers may add a `#fragment`), and files have none. A
 * file is a known extension, not any dot: `/products/autoenhance.ai` is a page without its
 * slash.
 */
async function expectCanonicalStructuredData(page: Page): Promise<string[]> {
  const structuredData = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
  expect(structuredData.length).toBeGreaterThan(0)
  const linkedUrls = structuredDataUrls(structuredData)
  for (const url of linkedUrls.filter(url => url.startsWith(site.publicUrl))) {
    expect(url, 'structured data writes the homepage as the bare origin').not.toBe(
      `${site.publicUrl}/`
    )
    expect(url, 'structured data should only use canonical best.serp.co URLs').toMatch(
      /^https:\/\/best\.serp\.co(?:\/(?:[^#?]*\/)?(?:#[\w-]+)?|\/[^#?]*\.(?:avif|gif|ico|jpe?g|json|png|svg|txt|webp|xml))?$/iu
    )
  }
  return linkedUrls
}

test.describe('best.serp.co D1 Worker smoke', () => {
  test('renders the SERP homepage with the exact D1 catalog size', async ({
    baseURL,
    page,
    request
  }) => {
    const listingCount = await liveListingCount(request, baseURL)
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(page).toHaveTitle(site.title)
    await expect(
      page.getByRole('heading', { level: 1, name: site.name, exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: new RegExp(`^${listingCount}\\s+products in directory$`, 'i')
      })
    ).toBeVisible()
    // The homepage is the bare origin in its canonical, og:url, and structured data.
    await expectCanonical(page, '/')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', site.publicUrl)
    await expect(page.locator('meta[property="og:url"]')).toHaveCount(1)
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', site.publicUrl)
    expect(await expectCanonicalStructuredData(page)).toContain(site.publicUrl)
  })

  test('renders a listing detail page at its canonical URL', async ({ baseURL, page }) => {
    const response = await page.goto(detailListing.path, { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(
      page.getByRole('heading', { level: 1, name: detailListing.namePattern })
    ).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(`${escapeRegExp(detailListing.name)}.*\\| SERP$`))
    await expectCanonical(page, detailListing.path)
    // Claims are on (#67, #130): a listing without an owner offers the claim link. The import
    // has no owners; on a deployed Worker someone may have claimed it since.
    const claimLink = page.getByRole('button', { name: 'Claim this listing' })
    await expect(
      isLocalOrigin(baseURL)
        ? claimLink
        : claimLink.or(page.getByText('Verified owner', { exact: true })).first()
    ).toBeVisible()

    const linkedUrls = await expectCanonicalStructuredData(page)
    expect(linkedUrls).toContain(absoluteUrl(detailListing.path))
    // The breadcrumb's Home item is the bare origin.
    expect(linkedUrls).toContain(site.publicUrl)
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
    request
  }) => {
    const redirects: Array<[string, string]> = [
      [`/products/${detailListing.slug}/reviews/`, detailListing.path],
      [`/products/best/${sampleCategory.slug}/`, categoryPath(sampleCategory.slug)],
      [`/categories/${sampleCategory.slug}/`, categoryPath(sampleCategory.slug)],
      ['/products/best/featured/', categoriesIndexPath],
      ['/products/best/', categoriesIndexPath],
      // Top-level legal pages of the static site and the short legal URLs: each legal page has
      // one canonical URL under /legal/ (#166).
      ['/privacy/', '/legal/privacy-policy/'],
      ['/terms/', '/legal/terms-conditions/'],
      ['/cookies/', '/legal/cookies/'],
      ['/legal/privacy/', '/legal/privacy-policy/'],
      ['/legal/terms/', '/legal/terms-conditions/']
    ]
    for (const [from, to] of redirects) {
      // Both slash forms of a moved URL reach the canonical page directly.
      await expectOneHop(request, from, to)
      await expectOneHop(request, from.slice(0, -1), to)
    }
  })

  test('serves one canonical form per URL under the trailing-slash standard', async ({
    request
  }) => {
    for (const path of [
      '/',
      '/about/',
      '/products/',
      detailListing.path,
      domainSlugListingPath,
      '/robots.txt',
      '/sitemap-index.xml',
      '/sitemaps/pages/1.xml'
    ]) {
      await expectServedAsRequested(request, path)
    }

    // Pages gain the slash, files lose it, and the query string is kept exactly.
    const redirects: Array<[string, string]> = [
      ['/about', '/about/'],
      ['/products', '/products/'],
      [detailListing.path.slice(0, -1), detailListing.path],
      [domainSlugListingPath.slice(0, -1), domainSlugListingPath],
      [categoryPath(sampleCategory.slug).slice(0, -1), categoryPath(sampleCategory.slug)],
      ['/products?page=2', '/products/?page=2'],
      ['/about?q=c%23%20%2B%2B&x=a%26b', '/about/?q=c%23%20%2B%2B&x=a%26b'],
      ['/robots.txt/', '/robots.txt'],
      ['/sitemap-index.xml/', '/sitemap-index.xml'],
      ['/sitemaps/pages/1.xml/', '/sitemaps/pages/1.xml']
    ]
    for (const [from, to] of redirects) {
      await expectOneHop(request, from, to)
    }

    // /api is served exactly as requested, with or without a trailing slash.
    for (const path of ['/api/search?q=video', '/api/search/?q=video']) {
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

  test('renders category, categories index, product index, and search routes', async ({ page }) => {
    const listingLinks = page.locator('main a[href^="/products/"]')

    await page.goto(categoryPath(sampleCategory.slug), { waitUntil: 'networkidle' })
    await expect(
      page.getByRole('heading', { level: 1, name: sampleCategory.name, exact: true })
    ).toBeVisible()
    await expectCanonical(page, categoryPath(sampleCategory.slug))
    await expectCanonicalStructuredData(page)
    await expect(page.locator(`main a[href="${detailListing.path}"]`).first()).toBeVisible()

    await page.goto(categoriesIndexPath, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible()
    await expectCanonical(page, categoriesIndexPath)
    // Every published category is linked, including `other`, which the sitemap omits.
    expect(
      await page.locator('main a[href^="/products/categories/"]').count()
    ).toBeGreaterThanOrEqual(site.categoryCount)
    await expect(
      page.locator(`main a[href="${categoryPath(sampleCategory.slug)}"]`).first()
    ).toBeVisible()

    await page.goto('/products/', { waitUntil: 'networkidle' })
    await expectCanonical(page, '/products/')
    expect(await listingLinks.count()).toBeGreaterThan(0)

    await page.goto(`/search/?q=${encodeURIComponent(detailListing.searchQuery)}`, {
      waitUntil: 'networkidle'
    })
    await expect(
      page.getByRole('link', { name: detailListing.namePattern }).first()
    ).toHaveAttribute('href', detailListing.path)
  })

  test('paginates the directory and large categories with crawlable links', async ({
    baseURL,
    page,
    request
  }) => {
    const pageSize = 48
    const lastDirectoryPage = Math.ceil((await liveListingCount(request, baseURL)) / pageSize)
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
    await expectCanonical(page, '/products/?page=2')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u)
    await expect(page).toHaveTitle(/Page 2/u)
    await expect(pagination.getByRole('link', { name: /previous/i })).toHaveAttribute(
      'href',
      /^\/products\/(?:#[\w-]+)?$/u
    )
    await expect(pagination.getByRole('link', { name: /next/i })).toHaveAttribute(
      'href',
      /^\/products\/\?page=3(?:#[\w-]+)?$/u
    )

    const last = await request.get(`/products/?page=${lastDirectoryPage}`)
    expect(last.status()).toBe(200)
    expect((await request.get(`/products/?page=${lastDirectoryPage + 1}`)).status()).toBe(404)

    const otherPath = categoryPath('other')
    await page.goto(otherPath, { waitUntil: 'domcontentloaded' })
    await expectCanonical(page, otherPath)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/u)
    await expect(pagination.getByRole('link', { name: 'Page 2' })).toHaveAttribute(
      'href',
      `${otherPath}?page=2`
    )
    await page.goto(`${otherPath}?page=2`, { waitUntil: 'domcontentloaded' })
    await expectCanonical(page, `${otherPath}?page=2`)
    await expect(page.getByRole('heading', { level: 1, name: /other/i }).first()).toBeVisible()
    expect(await page.locator('main a[href^="/products/"]').count()).toBeGreaterThan(0)
  })

  test('serves anonymous pages from the edge cache and bypasses private routes', async ({
    request
  }) => {
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

    const search = await request.get('/search/?q=video')
    expect(search.headers()['x-edge-cache']).toBe('BYPASS')
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
    for (const path of [
      '/',
      '/about/',
      '/about',
      '/robots.txt',
      '/sitemap-index.xml',
      '/rss.xml',
      '/api/search?q=video',
      '/not-a-page/'
    ]) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.headers()['x-robots-tag'], path).toMatch(/\bnoindex\b/u)
      expect(response.headers()['x-worker-version'], path).toMatch(/^[\w-]+$/u)
      expect(response.headers()['x-site-environment'], path).toMatch(/^(?:local|staging)$/u)
    }
    const robots = await request.get('/robots.txt')
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')

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

  test('renders static, commercial, and legal pages', async ({ page }) => {
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
      if (path.startsWith('/legal/')) await expectCanonicalStructuredData(page)
    }
  })

  test('serves D1-derived sitemap contracts', async ({ baseURL, request }) => {
    const robots = await request.get('/robots.txt')
    expect(robots.status()).toBe(200)
    // Only best.serp.co advertises its sitemaps; every other host disallows crawling.
    if (isPublicProductionOrigin(baseURL))
      expect(await robots.text()).toContain(`Sitemap: ${absoluteUrl('/sitemap-index.xml')}`)
    else expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')

    expect(await getSitemap(request, '/sitemap-index.xml')).toEqual([
      absoluteUrl('/sitemaps/pages/1.xml'),
      absoluteUrl('/sitemaps/directory/1.xml'),
      absoluteUrl('/sitemaps/categories/1.xml')
    ])

    const pages = await getSitemap(request, '/sitemaps/pages/1.xml')
    // The homepage entry is the bare origin; every other page ends with a slash.
    expect(pages).toContain(site.publicUrl)
    expect(pages).not.toContain(`${site.publicUrl}/`)
    for (const location of pages.filter(location => location !== site.publicUrl)) {
      expect(location).toMatch(/^https:\/\/best\.serp\.co\/.+\/$/u)
    }
    expect(pages).toContain(absoluteUrl('/about/'))
    expect(pages).toContain(absoluteUrl(categoriesIndexPath))
    for (const excluded of ['/submit/', '/legal/privacy-policy/', '/legal/terms-conditions/']) {
      expect(pages).not.toContain(absoluteUrl(excluded))
    }

    const listingCount = await liveListingCount(request, baseURL)
    const listings = await getSitemap(request, '/sitemaps/directory/1.xml')
    expect(listings).toHaveLength(listingCount)
    expect(new Set(listings).size).toBe(listingCount)
    for (const location of listings) {
      expect(location).toMatch(/^https:\/\/best\.serp\.co\/products\/[^/]+\/$/u)
    }
    expect(listings).toContain(absoluteUrl(detailListing.path))

    const categories = await getSitemap(request, '/sitemaps/categories/1.xml')
    expect(categories).toHaveLength(site.categoryCount)
    for (const location of categories) {
      expect(location).toMatch(/^https:\/\/best\.serp\.co\/products\/categories\/[^/]+\/$/u)
    }
    expect(categories).toContain(absoluteUrl(categoryPath(sampleCategory.slug)))
    expect(categories).not.toContain(absoluteUrl(categoryPath('featured')))
    expect(categories).not.toContain(absoluteUrl(categoryPath('other')))
  })

  test('serves the D1-derived JSON feed', async ({ baseURL, request }) => {
    const feed = await request.get('/rss.xml')
    expect(feed.status()).toBe(200)
    expect(feed.headers()['content-type']).toContain('application/json')
    const payload = await feed.json()
    expect(payload.title).toBe(site.name)
    expect(payload.home_page_url).toBe(site.publicUrl)
    expect(payload.feed_url).toBe(absoluteUrl('/rss.xml'))
    expect(payload.items).toHaveLength(await liveListingCount(request, baseURL))
    expect(payload.items).toContainEqual(
      expect.objectContaining({
        id: detailListing.slug,
        title: detailListing.name,
        url: absoluteUrl(detailListing.path)
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

  test('has no horizontal overflow on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/', { waitUntil: 'networkidle' })
    const heroName = page
      .getByRole('heading', { level: 1, name: site.name, exact: true })
      .locator('> span')
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
