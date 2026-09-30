import { expect, test } from '@playwright/test'

import { detailListing } from './listing-fixture'

const siteId = process.env.E2E_SITE_ID ?? 'serp.software'
const siteName = process.env.E2E_SITE_NAME ?? 'SERP Software'
const categorySlug = process.env.E2E_CATEGORY_SLUG ?? 'video-downloaders'
const expectedListingCount = Number(process.env.E2E_LISTING_COUNT ?? 339)

test.describe(`${siteId} D1 Worker smoke`, () => {
  test('renders the selected tenant and exact D1 catalog', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: siteName })).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: new RegExp(`${expectedListingCount}\\s+products in directory`, 'i')
      })
    ).toBeVisible()
    await expect(page).toHaveTitle(new RegExp(siteName, 'i'))
  })

  test('renders representative listing, category, search, and canonical metadata', async ({
    page
  }) => {
    await page.goto(`/products/${detailListing.slug}/`, { waitUntil: 'networkidle' })
    await expect(
      page.getByRole('heading', { level: 1, name: detailListing.namePattern })
    ).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://${siteId}/products/${detailListing.slug}/`
    )
    expect(await page.locator('script[type="application/ld+json"]').count()).toBeGreaterThan(0)

    await page.goto(`/categories/${categorySlug}/`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await page.locator('a[href^="/products/"]').count()).toBeGreaterThan(0)

    await page.goto(`/search/?q=${encodeURIComponent(detailListing.searchQuery)}`, {
      waitUntil: 'networkidle'
    })
    await expect(page.getByRole('link', { name: detailListing.namePattern }).first()).toBeVisible()
  })

  test('serves D1-derived sitemap and feed contracts', async ({ request }) => {
    const listingsSitemap = await request.get('/listings-sitemap.xml')
    expect(listingsSitemap.status()).toBe(200)
    expect((await listingsSitemap.text()).match(/<loc>/gu)).toHaveLength(expectedListingCount)

    const taxonomySitemap = await request.get('/taxonomies-sitemap.xml')
    expect(taxonomySitemap.status()).toBe(200)
    expect(await taxonomySitemap.text()).toContain(`/categories/${categorySlug}/`)

    const feed = await request.get('/rss.xml')
    expect(feed.status()).toBe(200)
    expect(feed.headers()['content-type']).toContain('application/json')
    const payload = await feed.json()
    expect(payload.home_page_url).toBe(`https://${siteId}`)
    expect(payload.items).toHaveLength(expectedListingCount)
  })

  test('has no horizontal overflow on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/', { waitUntil: 'networkidle' })
    const heroName = page.getByRole('heading', { level: 1, name: siteName }).locator('> span')
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
