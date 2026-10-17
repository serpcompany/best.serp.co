import { expect } from '@playwright/test'
import { seedCategories, seedFacts, seedListings } from './seed-facts'
import { test } from './test'

/**
 * The 404 page, the removed-listing page's alternatives, the HTML sitemap and the footer's
 * "Sitemap" link (#53; serp web-stack/404-pages.md and html-sitemap.md), on the seeded catalog.
 * Every request is made without following redirects.
 */

const noRedirects = { maxRedirects: 0 }

function robotsMetas(html: string): string[] {
  return [...html.matchAll(/<meta\s+name="robots"\s+content="([^"]*)"/gu)].map(
    match => match[1] ?? ''
  )
}

/** The page's `<main>`: its own links, without the header's and footer's. */
function mainOf(html: string): string {
  const match = /<main[\s>][\s\S]*<\/main>/u.exec(html)
  expect(match, 'the page has a <main>').not.toBeNull()
  return match?.[0] ?? ''
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*?href="([^"]+)"/gu)].map(match => match[1] ?? '')
}

const listingPath = (href: string) => /^\/products\/(?!categories\/|tags\/)[^/]+\/$/u.test(href)

/** The paths an XML sitemap lists, each as the site links it (the homepage as `/`). */
async function sitemapPaths(
  request: Parameters<Parameters<typeof test>[2]>[0]['request'],
  file: string
): Promise<string[]> {
  const response = await request.get(file, noRedirects)
  expect(response.status(), file).toBe(200)
  return [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => {
    const url = new URL(match[1] ?? '')
    return url.pathname || '/'
  })
}

test.describe('the 404 page (#53)', () => {
  test('a made-up URL answers 404 with one noindex tag and links onward', async ({ request }) => {
    const response = await request.get('/no-such-page-53/', noRedirects)
    expect(response.status()).toBe(404)
    const html = await response.text()
    expect(robotsMetas(html)).toEqual(['noindex'])
    const links = hrefs(mainOf(html))
    expect(links).toEqual(
      expect.arrayContaining([
        '/',
        '/sitemap/',
        '/products/categories/',
        '/brands/',
        ...[seedCategories.writing, seedCategories.design, seedCategories.developer].map(
          category => `/products/categories/${category.slug}/`
        )
      ])
    )
    // Only categories with a public listing.
    expect(links).not.toContain(`/products/categories/${seedCategories.empty.slug}/`)
    // The newest listings and the HTML sitemap's listing pages, each under its heading.
    for (const heading of ['Categories', 'Best of', 'Newest', 'Listings']) {
      expect(mainOf(html)).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`, 'u'))
    }
    expect(links.filter(listingPath).length).toBe(12)
    expect(links).toContain('/sitemap/listings/')
    expect(mainOf(html)).toMatch(/<form[^>]*action="\/search\/"[^>]*>[\s\S]*name="q"/u)
  })
})

test.describe('a removed listing (#53)', () => {
  test('answers 410 with six live listings from its category, then the rest of it as links', async ({
    request
  }) => {
    const response = await request.get(`/products/${seedListings.unlisted.slug}/`, noRedirects)
    expect(response.status()).toBe(410)
    const main = mainOf(await response.text())
    // React separates the name from the text after it with an empty comment.
    expect(main.replaceAll('<!-- -->', '')).toContain(
      `${seedListings.unlisted.name} is no longer listed`
    )
    const sectionAt = (id: string) => main.indexOf(`id="${id}"`)
    const alternativesAt = sectionAt('gone-listing-alternatives')
    const moreAt = sectionAt('gone-listing-more')
    expect(alternativesAt, 'the page shows alternatives').toBeGreaterThan(-1)
    expect(moreAt, 'and the rest of the category').toBeGreaterThan(alternativesAt)
    const alternatives = [...new Set(hrefs(main.slice(alternativesAt, moreAt)).filter(listingPath))]
    const more = hrefs(main.slice(moreAt)).filter(listingPath)
    expect(alternatives.length).toBe(6)
    for (const href of [...alternatives, ...more]) {
      expect(href).not.toBe(`/products/${seedListings.unlisted.slug}/`)
    }

    // Together they are every live listing of the removed listing's category (Writing Tools,
    // two pages of the category), each once.
    const categoryPath = `/products/categories/${seedCategories.writing.slug}/`
    const inCategory = new Set<string>()
    for (const path of [categoryPath, `${categoryPath}?page=2`]) {
      const page = await request.get(path)
      for (const href of hrefs(mainOf(await page.text())).filter(listingPath)) inCategory.add(href)
    }
    expect(inCategory.size).toBe(seedFacts.paginatedCategory.listingCount)
    expect([...alternatives, ...more].sort()).toEqual([...inCategory].sort())
    expect(hrefs(main)).toContain(categoryPath)
  })
})

test.describe('the HTML sitemap (#53)', () => {
  test('/sitemap/ is indexable and links exactly the indexable hubs', async ({ request }) => {
    const response = await request.get('/sitemap/', noRedirects)
    expect(response.status()).toBe(200)
    const html = await response.text()
    expect(robotsMetas(html).filter(content => content.includes('noindex'))).toEqual([])
    const links = new Set(hrefs(mainOf(html)))
    // Every category and best page the XML sitemaps list, and nothing they don't.
    const categories = await sitemapPaths(request, '/sitemap-categories.xml')
    const bestPages = await sitemapPaths(request, '/sitemap-best.xml')
    const pages = await sitemapPaths(request, '/sitemap-pages.xml')
    expect(categories).toHaveLength(seedFacts.categoryCount)
    for (const path of [...categories, ...bestPages]) expect(links.has(path), path).toBe(true)
    const indexable = new Set([...categories, ...bestPages, ...pages])
    for (const href of links) expect(indexable.has(href), href).toBe(true)
    expect(links.has('/sitemap/listings/')).toBe(true)
    expect([...links].some(href => href.startsWith('/products/tags/'))).toBe(false)
  })

  test('its listing pages list every listing; page 1 redirects and a page past the last is a 404', async ({
    request
  }) => {
    const response = await request.get('/sitemap/listings/', noRedirects)
    expect(response.status()).toBe(200)
    const html = await response.text()
    expect(robotsMetas(html).filter(content => content.includes('noindex'))).toEqual([])
    expect(html).toContain('<link rel="canonical" href="https://best.serp.co/sitemap/listings/"')
    const listed = hrefs(mainOf(html)).filter(listingPath)
    // 55 listings fit on one page of 200, and they are exactly the products sitemap's.
    expect(listed).toHaveLength(seedFacts.listingCount)
    expect([...listed].sort()).toEqual(
      (await sitemapPaths(request, '/sitemap-products.xml')).sort()
    )

    const pageOne = await request.get('/sitemap/listings/1/', noRedirects)
    expect(pageOne.status()).toBe(308)
    expect(pageOne.headers().location).toBe('/sitemap/listings/')
    for (const path of ['/sitemap/listings/2/', '/sitemap/listings/01/', '/sitemap/listings/x/']) {
      expect((await request.get(path, noRedirects)).status(), path).toBe(404)
    }
  })

  test('every page’s footer links it as "Sitemap"', async ({ request }) => {
    for (const path of ['/', '/about/', `/products/${seedListings.detail.slug}/`]) {
      const html = await (await request.get(path, noRedirects)).text()
      const footer = /<footer[\s>][\s\S]*<\/footer>/u.exec(html)?.[0] ?? ''
      expect(footer, path).toMatch(/<a [^>]*href="\/sitemap\/"[^>]*>Sitemap<\/a>/u)
    }
  })
})
