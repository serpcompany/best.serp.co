import { type APIRequestContext, expect } from '@playwright/test'
import {
  detailListing,
  type SampleListing,
  sampleCategory,
  sampleListing,
  searchSample
} from './listing-fixture'
import { seedFacts, seedListings } from './seed-facts'
import { categoryPath } from './site-fixture'

/**
 * The catalog facts of the specs that also run against a deployed Worker (`smoke.spec.ts` and
 * `public-parity.spec.ts`: `pnpm test:e2e:smoke`, after each staging deploy), split by where they
 * run (serpcompany/best.serp.co#313):
 *
 * - **Local** (`pnpm test:e2e`, CI's `e2e`): the fixture seed's facts (`seed-facts.ts`), exactly.
 * - **Deployed** (staging): the live catalog, read from its public surfaces. The counts come from
 *   the JSON feed and the categories sitemap, held to floors and ceilings so a lost or duplicated
 *   catalog fails; the sample listing is one the homepage links, and the rest follows from the
 *   feed. No listing or category is named, so a legitimate catalog change can't break the run.
 *
 * Fields marked "seed only" are facts only the seed knows; a deployed run skips what needs them.
 */
export interface CatalogSample {
  /** A category the sample listing is in, whose first page links it. */
  category: { /** Seed only. */ name?: string; slug: string }
  /** Categories with a published listing: the categories sitemap and index. */
  categoryCount: number
  /** A listing whose slug is a domain name: its dot is not a file extension. */
  domainListing: { path: string; slug: string }
  /** A listing the homepage's first page links (its cards and favorites can find it). */
  listing: SampleListing & {
    /** Seed only: the label of one of its resource links. */
    resourceLink?: string
    /** Seed only: its website, which is not a serp.ly link. */
    website?: string
  }
  /** Live listings: the homepage badge, the directory pages, the feed and the sitemap. */
  listingCount: number
  /** An indexable category with a second directory page. */
  paginatedCategory: { slug: string }
  /** A query `/search/` answers with `listing` among its results. */
  search: { listing: SampleListing; query: string }
  source: 'live' | 'seed'
}

/** The directory's page size: a category with more listings has a second page. */
export const DIRECTORY_PAGE_SIZE = 48

/**
 * Bounds on a deployed catalog. #260 left 2,690 live listings in 139 categories on staging; the
 * floors leave headroom for admin unpublishes, the ceilings for new listings.
 */
const deployedCatalog = {
  maximumCategoryCount: 200,
  maximumListingCount: 4500,
  minimumCategoryCount: 130,
  minimumListingCount: 2500
} as const

/** A local Worker, which serves the fixture seed (`pnpm test:e2e`, CI). */
export function isLocalOrigin(baseURL: string | undefined): boolean {
  const host = new URL(baseURL ?? 'http://127.0.0.1').hostname
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')
}

const seedSample: CatalogSample = {
  category: sampleCategory,
  categoryCount: seedFacts.categoryCount,
  domainListing: sampleListing(seedListings.submitted),
  listing: detailListing,
  listingCount: seedFacts.listingCount,
  paginatedCategory: seedFacts.paginatedCategory,
  search: searchSample,
  source: 'seed'
}

export function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1] ?? '')
}

interface FeedItem {
  /** `[listing type, primary category slug]` (`app/(files)/rss.xml/route.ts`). */
  categories: string[]
  id: string
  title: string
}

async function readLiveSample(request: APIRequestContext): Promise<CatalogSample> {
  const feed = await request.get('/rss.xml')
  expect(feed.status(), '/rss.xml').toBe(200)
  const items = ((await feed.json()) as { items: FeedItem[] }).items
  expect(items.length, 'live listings').toBeGreaterThanOrEqual(deployedCatalog.minimumListingCount)
  expect(items.length, 'live listings').toBeLessThanOrEqual(deployedCatalog.maximumListingCount)

  const categoriesSitemap = await request.get('/sitemap-categories.xml')
  expect(categoriesSitemap.status(), '/sitemap-categories.xml').toBe(200)
  const listedCategories = sitemapLocations(await categoriesSitemap.text())
  const categoryCount = listedCategories.length
  expect(categoryCount, 'listed categories').toBeGreaterThanOrEqual(
    deployedCatalog.minimumCategoryCount
  )
  expect(categoryCount, 'listed categories').toBeLessThanOrEqual(
    deployedCatalog.maximumCategoryCount
  )

  // Only the categories the sitemap lists are samples: an indexable one, never the transitional
  // `other` (noindex and out of the sitemap, #346), which the specs expect to find there.
  const indexable = new Set(
    listedCategories.map(location => new URL(location).pathname.split('/').at(-2) ?? '')
  )

  // The sample: the first listing the homepage links whose category (an indexable one) has a
  // first page that links it too. At most 10 category pages are read.
  const bySlug = new Map(items.map(item => [item.id, item]))
  const home = await (await request.get('/')).text()
  const homeSlugs = [
    ...new Set([...home.matchAll(/href="\/products\/([^/"?#]+)\/"/gu)].map(match => match[1]))
  ].filter((slug): slug is string => slug !== undefined && bySlug.has(slug))
  const candidates = homeSlugs
    .map(slug => ({ category: bySlug.get(slug)?.categories[1], slug }))
    .filter((candidate): candidate is { category: string; slug: string } =>
      Boolean(candidate.category && indexable.has(candidate.category))
    )
  let sample: { category: string; item: FeedItem } | undefined
  for (const { category, slug } of candidates.slice(0, 10)) {
    const item = bySlug.get(slug) as FeedItem
    const page = await (await request.get(categoryPath(category))).text()
    if (page.includes(`href="/products/${slug}/"`)) {
      sample = { category, item }
      break
    }
  }
  if (!sample) throw new Error('No listing the homepage links is on its category’s first page.')
  const listing = sampleListing({ name: sample.item.title, slug: sample.item.id })

  const domain = items.find(item => item.id.includes('.'))
  if (!domain) throw new Error('No live listing has a domain-name slug.')

  // The largest category the sitemap lists: indexable too, since the pagination check expects
  // its page 1 to be `index`.
  const perCategory = new Map<string, number>()
  for (const item of items) {
    const category = item.categories[1]
    if (category && indexable.has(category))
      perCategory.set(category, (perCategory.get(category) ?? 0) + 1)
  }
  const [paginated, paginatedCount] = [...perCategory].sort((a, b) => b[1] - a[1])[0] ?? []
  expect(paginatedCount ?? 0, 'the largest category').toBeGreaterThan(DIRECTORY_PAGE_SIZE)

  return {
    category: { slug: sample.category },
    categoryCount,
    domainListing: sampleListing({ name: domain.title, slug: domain.id }),
    listing,
    listingCount: items.length,
    paginatedCategory: { slug: paginated as string },
    search: { listing, query: listing.name },
    source: 'live'
  }
}

const liveSamples = new Map<string, Promise<CatalogSample>>()

/**
 * The catalog the specs assert: the seed's facts on a local Worker, the live catalog's (read once
 * per worker process) on a deployed one.
 */
export function catalogSample(
  request: APIRequestContext,
  baseURL: string | undefined
): Promise<CatalogSample> {
  if (isLocalOrigin(baseURL)) return Promise.resolve(seedSample)
  const key = baseURL ?? ''
  let sample = liveSamples.get(key)
  if (!sample) {
    sample = readLiveSample(request)
    liveSamples.set(key, sample)
    sample.catch(() => liveSamples.delete(key))
  }
  return sample
}
