import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

import { detailListing } from './listing-fixture'
import {
  absoluteUrl,
  categoriesIndexPath,
  categoryPath,
  escapeRegExp,
  featuredBadgeUrls,
  sampleCategory,
  site
} from './site-fixture'

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
}

async function getSitemap(request: APIRequestContext, path: string): Promise<string[]> {
  const response = await request.get(path)
  expect(response.status(), path).toBe(200)
  expect(response.headers()['content-type']).toContain('xml')
  return sitemapLocations(await response.text())
}

async function expectRedirect(request: APIRequestContext, from: string, to: RegExp) {
  const response = await request.get(from, { maxRedirects: 0 })
  expect(response.status(), from).toBe(308)
  const location = response.headers().location
  expect(location, `${from} Location header`).toBeTruthy()
  expect(new URL(location, 'http://placeholder.invalid').pathname).toMatch(to)
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
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', absoluteUrl(path))
}

test.describe('best.serp.co D1 Worker smoke', () => {
  test('renders the SERP homepage with the exact D1 catalog size', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(page).toHaveTitle(site.title)
    await expect(
      page.getByRole('heading', { level: 1, name: site.name, exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: new RegExp(`^${site.listingCount}\\s+products in directory$`, 'i')
      })
    ).toBeVisible()
    await expectCanonical(page, '/')
  })

  test('renders a listing detail page at its canonical URL', async ({ page }) => {
    const response = await page.goto(detailListing.path, { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(
      page.getByRole('heading', { level: 1, name: detailListing.namePattern })
    ).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(`${escapeRegExp(detailListing.name)}.*\\| SERP$`))
    await expectCanonical(page, detailListing.path)

    const structuredData = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
    expect(structuredData.length).toBeGreaterThan(0)
    const linkedUrls = structuredDataUrls(structuredData)
    expect(linkedUrls).toContain(absoluteUrl(detailListing.path))
    for (const url of linkedUrls.filter(url => url.startsWith('https://best.serp.co/'))) {
      expect(url, 'structured data should only use trailing-slash best.serp.co URLs').toMatch(
        /\/(?:#[^/]*)?$|\.[a-z0-9]+$/iu
      )
    }
  })

  test('permanently redirects the pre-D1 URL scheme to the current routes', async ({ request }) => {
    const redirects: Array<[string, string]> = [
      [`/products/${detailListing.slug}/reviews/`, detailListing.path],
      [`/products/best/${sampleCategory.slug}/`, categoryPath(sampleCategory.slug)],
      [`/categories/${sampleCategory.slug}/`, categoryPath(sampleCategory.slug)],
      ['/products/best/featured/', categoriesIndexPath],
      ['/products/best/', categoriesIndexPath]
    ]
    for (const [from, to] of redirects) {
      await expectRedirect(request, from, new RegExp(`^${escapeRegExp(to)}$`))
    }
  })

  test('renders category, categories index, product index, and search routes', async ({ page }) => {
    const listingLinks = page.locator('main a[href^="/products/"]')

    await page.goto(categoryPath(sampleCategory.slug), { waitUntil: 'networkidle' })
    await expect(
      page.getByRole('heading', { level: 1, name: sampleCategory.name, exact: true })
    ).toBeVisible()
    await expectCanonical(page, categoryPath(sampleCategory.slug))
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
    page,
    request
  }) => {
    const pageSize = 48
    const lastDirectoryPage = Math.ceil(site.listingCount / pageSize)
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

  test('renders static, commercial, and legal pages', async ({ page }) => {
    const pages: Array<{ path: string; heading: RegExp }> = [
      { path: '/about/', heading: /^about serp$/i },
      { path: '/brands/', heading: /^brands$/i },
      { path: '/contact/', heading: /^contact serp$/i },
      { path: '/pricing/', heading: /^serp pricing$/i },
      { path: '/sponsor/', heading: /^sponsor serp$/i },
      { path: '/submit/', heading: /^submit$/i },
      { path: '/legal/privacy-policy/', heading: /^privacy policy$/i },
      { path: '/legal/privacy/', heading: /^privacy policy$/i },
      { path: '/legal/terms-conditions/', heading: /^terms of service$/i },
      { path: '/legal/terms/', heading: /^terms of service$/i }
    ]

    for (const { path, heading } of pages) {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status(), path).toBe(200)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      await expect(page).toHaveTitle(/\| SERP$/)
    }
  })

  test('serves D1-derived sitemap contracts', async ({ request }) => {
    const robots = await request.get('/robots.txt')
    expect(robots.status()).toBe(200)
    expect(await robots.text()).toContain(`Sitemap: ${absoluteUrl('/sitemap-index.xml')}`)

    expect(await getSitemap(request, '/sitemap-index.xml')).toEqual([
      absoluteUrl('/sitemaps/pages/1.xml'),
      absoluteUrl('/sitemaps/directory/1.xml'),
      absoluteUrl('/sitemaps/categories/1.xml')
    ])

    const pages = await getSitemap(request, '/sitemaps/pages/1.xml')
    expect(pages).toContain(absoluteUrl('/'))
    expect(pages).toContain(absoluteUrl('/about/'))
    expect(pages).toContain(absoluteUrl(categoriesIndexPath))
    for (const excluded of ['/submit/', '/legal/privacy-policy/', '/legal/terms-conditions/']) {
      expect(pages).not.toContain(absoluteUrl(excluded))
    }

    const listings = await getSitemap(request, '/sitemaps/directory/1.xml')
    expect(listings).toHaveLength(site.listingCount)
    expect(new Set(listings).size).toBe(site.listingCount)
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

  test('serves the D1-derived JSON feed', async ({ request }) => {
    const feed = await request.get('/rss.xml')
    expect(feed.status()).toBe(200)
    expect(feed.headers()['content-type']).toContain('application/json')
    const payload = await feed.json()
    expect(payload.title).toBe(site.name)
    expect(payload.home_page_url).toBe(site.publicUrl)
    expect(payload.feed_url).toBe(absoluteUrl('/rss.xml'))
    expect(payload.items).toHaveLength(site.listingCount)
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
