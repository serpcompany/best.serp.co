import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { sitemapLocations } from './catalog-sample'
import {
  seedBestPages,
  seedCategories,
  seedListings,
  seedTags,
  seedTaxonomyRedirects,
  seedWebsite
} from './seed-facts'
import { absoluteUrl, categoryPath, listingPath } from './site-fixture'
import { test } from './test'

/**
 * The taxonomy's routes (#346; #341 design 2.1–2.3 and 5.1) on the fixture seed's tags, best
 * pages and redirects (`seed-facts.ts`). Local only: staging and production have no taxonomy data
 * until the owner publishes it (#349).
 */

const tagPath = (slug: string) => `/products/tags/${slug}/`
/** A best page's ranked entries (the breadcrumb is a list too). */
const ENTRIES = 'main ol[data-slot="best-page-entries"]'
const bestPath = (slug: string) => `/best/${slug}/`

/** The seed's best pages, as the seed titles them ("note taking app" → "Best Note Taking Apps"). */
const noteTakingApp = { ...seedBestPages.tag, heading: 'Best Note Taking Apps' }
const designApp = { ...seedBestPages.category, heading: 'Best Design Apps' }
const whiteboardApp = { ...seedBestPages.intersection, heading: 'Best Whiteboard Apps' }

/**
 * `from` answers one 308 whose Location is exactly `to` (path and query), and `to` answers 200
 * without another redirect.
 */
async function expectOneHop(request: APIRequestContext, from: string, to: string) {
  const response = await request.get(from, { maxRedirects: 0 })
  expect(response.status(), from).toBe(308)
  const target = new URL(response.headers().location ?? '', 'http://placeholder.invalid')
  expect(`${target.pathname}${target.search}`, `${from} Location header`).toBe(to)
  const destination = await request.get(to, { maxRedirects: 0 })
  expect(destination.status(), `${from} -> ${to}`).toBe(200)
}

async function expectRobots(page: Page, indexable: boolean) {
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    indexable ? /^index, follow/u : /^noindex, follow$/u
  )
}

async function expectCanonical(page: Page, path: string) {
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', absoluteUrl(path))
}

async function structuredData(page: Page): Promise<Array<Record<string, unknown>>> {
  return page
    .locator('script[type="application/ld+json"]')
    .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
}

test.describe('taxonomy routes on the fixture seed (#346)', () => {
  test('renders a best page: ranked entries, chips, Visit Site, See all and its JSON-LD', async ({
    page
  }) => {
    const response = await page.goto(bestPath(noteTakingApp.slug))
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(noteTakingApp.heading)
    await expect(page).toHaveTitle(`${noteTakingApp.heading} | SERP`)
    // 11 in its pool (12 tagged, one excluded), 10 shown: indexed from 5 entries.
    await expectRobots(page, true)
    await expectCanonical(page, bestPath(noteTakingApp.slug))
    await expect(page.locator('main time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/u)

    const entries = page.locator(`${ENTRIES} > li`)
    await expect(entries).toHaveCount(10)
    // The pins first, in position order; the first one's blurb instead of its description.
    const [first, second] = noteTakingApp.pins
    await expect(entries.nth(0).getByRole('heading', { level: 2 })).toHaveText(first.name)
    await expect(entries.nth(0)).toContainText(`${first.name} is the fixture pick`)
    await expect(entries.nth(1).getByRole('heading', { level: 2 })).toHaveText(second.name)
    await expect(page.locator(ENTRIES)).not.toContainText(noteTakingApp.excluded[0].name)
    // Its name links to its page; its chips to its hub and tags; "Visit Site" leaves with its rel.
    await expect(entries.nth(0).getByRole('link', { name: first.name })).toHaveAttribute(
      'href',
      listingPath(first.slug)
    )
    await expect(
      entries.nth(0).getByRole('link', { name: seedCategories.writing.name })
    ).toHaveAttribute('href', categoryPath(seedCategories.writing.slug))
    await expect(
      entries.nth(0).getByRole('link', { name: seedTags.noteTaking.name, exact: true })
    ).toHaveAttribute('href', tagPath(seedTags.noteTaking.slug))
    await expect(
      entries.nth(0).getByRole('link', { name: seedTags.documentEditors.name })
    ).toHaveAttribute('href', tagPath(seedTags.documentEditors.slug))
    const visit = entries.nth(0).getByRole('link', { name: 'Visit Site' })
    await expect(visit).toHaveAttribute('href', seedWebsite(first.slug))
    await expect(visit).toHaveAttribute('target', '_blank')
    await expect(visit).toHaveAttribute('rel', /noopener noreferrer/u)
    await expect(page.getByRole('link', { name: 'Visit Site' })).toHaveCount(10)
    // "See all" goes to the tag it ranks.
    await expect(
      page.getByRole('link', {
        name: `See all ${seedTags.noteTaking.listingCount} ${seedTags.noteTaking.name}`
      })
    ).toHaveAttribute('href', tagPath(seedTags.noteTaking.slug))

    const data = await structuredData(page)
    const collection = data.find(entry => entry['@type'] === 'CollectionPage') as {
      breadcrumb: { itemListElement: Array<{ item: string; name: string }> }
      mainEntity: {
        '@type': string
        itemListElement: Array<{ position: number; url: string }>
        numberOfItems: number
      }
      url: string
    }
    expect(collection.url).toBe(absoluteUrl(bestPath(noteTakingApp.slug)))
    expect(collection.mainEntity).toMatchObject({ '@type': 'ItemList', numberOfItems: 10 })
    expect(collection.mainEntity.itemListElement.slice(0, 2)).toEqual([
      expect.objectContaining({ position: 1, url: absoluteUrl(listingPath(first.slug)) }),
      expect.objectContaining({ position: 2, url: absoluteUrl(listingPath(second.slug)) })
    ])
    expect(collection.breadcrumb.itemListElement.map(item => item.name)).toEqual([
      'Home',
      'Best',
      noteTakingApp.heading
    ])
    expect(data.some(entry => entry['@type'] === 'BreadcrumbList')).toBe(true)
    // No ratings: D1 holds none.
    expect(JSON.stringify(data)).not.toMatch(/Review|Rating/u)
  })

  test('keeps a best page of 1 to 4 entries noindex, and links its hub and same-hub lists', async ({
    page
  }) => {
    // A category alone: 3 design listings. "See all" goes to the category.
    await page.goto(bestPath(designApp.slug))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(designApp.heading)
    await expectRobots(page, false)
    await expectCanonical(page, bestPath(designApp.slug))
    await expect(page.locator(`${ENTRIES} > li`)).toHaveCount(3)
    await expect(page.locator(`${ENTRIES} > li`).first()).toContainText(seedListings.detail.name)
    await expect(
      page.getByRole('link', { name: `See all 3 ${seedCategories.design.name}` })
    ).toHaveAttribute('href', categoryPath(seedCategories.design.slug))
    const related = page.getByRole('region', { name: `Best ${seedCategories.design.name} lists` })
    await expect(related.getByRole('link', { name: whiteboardApp.heading })).toHaveAttribute(
      'href',
      bestPath(whiteboardApp.slug)
    )

    // A tag within a category: 2 entries; "See all" goes to the tag.
    await page.goto(bestPath(whiteboardApp.slug))
    await expectRobots(page, false)
    await expect(page.locator(`${ENTRIES} > li`)).toHaveCount(2)
    await expect(
      page.getByRole('link', { name: `See all 2 ${seedTags.whiteboards.name}` })
    ).toHaveAttribute('href', tagPath(seedTags.whiteboards.slug))
  })

  test('renders tag pages under their hubs, noindex below 10 listings or under a best page', async ({
    page
  }) => {
    const noteTaking = seedTags.noteTaking
    const response = await page.goto(tagPath(noteTaking.slug))
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(noteTaking.name)
    await expectCanonical(page, tagPath(noteTaking.slug))
    // 12 listings, but a best page ranks the tag alone: the tag page links to it instead.
    await expectRobots(page, false)
    await expect(page.getByRole('link', { name: noteTakingApp.heading })).toHaveAttribute(
      'href',
      bestPath(noteTakingApp.slug)
    )
    const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' })
    await expect(
      breadcrumb.getByRole('link', { name: seedCategories.writing.name })
    ).toHaveAttribute('href', categoryPath(seedCategories.writing.slug))
    await expect(page.locator('main [data-analytics="website-click"]')).toHaveCount(
      noteTaking.listingCount
    )
    await expect(page.getByRole('link', { name: seedListings.submitted.name })).toHaveAttribute(
      'href',
      listingPath(seedListings.submitted.slug)
    )
    const collection = (await structuredData(page)).find(
      entry => entry['@type'] === 'CollectionPage'
    ) as { breadcrumb: { itemListElement: Array<{ name: string }> } }
    expect(collection.breadcrumb.itemListElement.map(item => item.name)).toEqual([
      'Home',
      'Categories',
      seedCategories.writing.name,
      noteTaking.name
    ])

    // Fewer than 10 listings.
    await page.goto(tagPath(seedTags.documentEditors.slug))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(seedTags.documentEditors.name)
    await expectRobots(page, false)
    // A best page that ranks the tag within a category is linked too.
    await page.goto(tagPath(seedTags.whiteboards.slug))
    await expect(page.getByRole('link', { name: whiteboardApp.heading })).toHaveAttribute(
      'href',
      bestPath(whiteboardApp.slug)
    )
  })

  test('lists linked tags and best pages on the indexes, grouped by hub', async ({ page }) => {
    await page.goto('/products/tags/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tags')
    await expectRobots(page, true)
    await expectCanonical(page, '/products/tags/')
    const main = page.locator('main')
    // Tags with 3 or more listings, under their hubs.
    for (const tag of [seedTags.noteTaking, seedTags.documentEditors, seedTags.apis]) {
      const hub = page.getByRole('region', { name: tag.category.name })
      await expect(hub.getByRole('link', { name: new RegExp(tag.name, 'u') })).toHaveAttribute(
        'href',
        tagPath(tag.slug)
      )
    }
    for (const tag of [seedTags.whiteboards, seedTags.mockups, seedTags.empty, seedTags.retired]) {
      await expect(main.locator(`a[href="${tagPath(tag.slug)}"]`)).toHaveCount(0)
    }

    await page.goto('/best/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Best')
    await expectRobots(page, true)
    await expectCanonical(page, '/best/')
    for (const [bestPage, hub] of [
      [noteTakingApp, seedCategories.writing],
      [designApp, seedCategories.design],
      [whiteboardApp, seedCategories.design]
    ] as const) {
      await expect(
        page
          .getByRole('region', { name: hub.name })
          .getByRole('link', { name: new RegExp(bestPage.heading, 'u') })
      ).toHaveAttribute('href', bestPath(bestPage.slug))
    }
  })

  test('answers 404 for an empty, retired or unknown tag or best page', async ({ request }) => {
    for (const path of [
      tagPath(seedTags.empty.slug),
      tagPath(seedTags.retired.slug),
      tagPath('no-such-tag'),
      bestPath('no-such-page'),
      categoryPath(seedCategories.empty.slug),
      categoryPath('no-such-category')
    ]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404)
    }
  })

  test('sends every moved taxonomy URL to its target in one 308, at the root too', async ({
    request
  }) => {
    const targetPath = ({ kind, slug }: { kind: string; slug: string | null }) =>
      kind === 'category'
        ? categoryPath(slug ?? '')
        : kind === 'tag'
          ? tagPath(slug ?? '')
          : kind === 'best'
            ? bestPath(slug ?? '')
            : '/products/'
    const sourcePath = ({ kind, slug }: { kind: string; slug: string }) =>
      kind === 'category' ? categoryPath(slug) : kind === 'tag' ? tagPath(slug) : bestPath(slug)
    for (const { from, to } of seedTaxonomyRedirects) {
      await expectOneHop(request, sourcePath(from), targetPath(to))
    }
    // An old category URL at the root (#168) answers the same one hop, in both slash forms.
    for (const { from, to } of seedTaxonomyRedirects.filter(r => r.from.kind === 'category')) {
      await expectOneHop(request, `/${from.slug}/`, targetPath(to))
      await expectOneHop(request, `/${from.slug}`, targetPath(to))
    }
    // The query string survives without `page` (design 2.2, rule 4).
    await expectOneHop(
      request,
      `${categoryPath('notebooks')}?page=2&utm_source=e2e`,
      `${tagPath(seedTags.noteTaking.slug)}?utm_source=e2e`
    )
    await expectOneHop(
      request,
      '/notebooks/?page=2&utm_source=e2e',
      `${tagPath('note-taking')}?utm_source=e2e`
    )
    // The old "best" index is the best-page index now.
    await expectOneHop(request, '/products/best/', '/best/')
    await expectOneHop(request, '/products/best', '/best/')
  })

  test('lists only indexable tags and best pages in their sitemaps', async ({ request }) => {
    const sitemap = async (path: string) => {
      const response = await request.get(path)
      expect(response.status(), path).toBe(200)
      expect(response.headers()['content-type'], path).toContain('xml')
      return sitemapLocations(await response.text())
    }
    expect(await sitemap('/sitemap-index.xml')).toEqual(
      [
        '/sitemap-pages.xml',
        '/sitemap-products.xml',
        '/sitemap-categories.xml',
        '/sitemap-tags.xml',
        '/sitemap-best.xml'
      ].map(path => absoluteUrl(path))
    )
    // Only the 10-entry best page; no seed tag is indexable (12 listings, but ranked alone).
    expect(await sitemap('/sitemap-best.xml')).toEqual([absoluteUrl(bestPath(noteTakingApp.slug))])
    expect(await sitemap('/sitemap-tags.xml')).toEqual([])
    const pages = await sitemap('/sitemap-pages.xml')
    expect(pages).toContain(absoluteUrl('/products/tags/'))
    expect(pages).toContain(absoluteUrl('/best/'))
  })

  test('serves the taxonomy pages and their redirects from the edge cache', async ({ request }) => {
    for (const path of [
      `${bestPath(noteTakingApp.slug)}?edge-cache-check=${Date.now()}`,
      `${tagPath(seedTags.noteTaking.slug)}?edge-cache-check=${Date.now()}`,
      `${categoryPath('notebooks')}?edge-cache-check=${Date.now()}`
    ]) {
      const first = await request.get(path, { maxRedirects: 0 })
      expect([200, 308], path).toContain(first.status())
      expect(first.headers()['x-edge-cache'], path).toBe('MISS')
      await expect(async () => {
        const repeat = await request.get(path, { maxRedirects: 0 })
        expect(repeat.status()).toBe(first.status())
        expect(repeat.headers()['x-edge-cache']).toBe('HIT')
      }).toPass({ timeout: 10_000 })
    }
  })
})
