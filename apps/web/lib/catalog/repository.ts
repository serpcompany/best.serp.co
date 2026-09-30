import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createCacheApiDataCache, noCatalogDataCache } from '@serpdirectory/data-ops/cache'
import { createCatalogOperations } from '@serpdirectory/data-ops/catalog'
import { createDatabase } from '@serpdirectory/data-ops/client'
import type {
  CatalogObserver,
  ListingNamePage,
  ListingNamePageQuery,
  ListingPage,
  PublishedCategory
} from '@serpdirectory/data-ops/contracts'
import type { WebsiteDetailMetadata, WebsiteMetadata } from '@serpdirectory/web-core/content-query'
import { cache } from 'react'

export type PublishedListingPage = ListingPage
export type { ListingNamePage, PublishedCategory }

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

function assertCatalogBinding(env: CloudflareEnv): D1Database {
  if (!env.DB) throw new Error('D1 binding DB is required; catalog reads fail closed.')
  if (!runtimeEnvironments.has(env.D1_RUNTIME_ENV)) {
    throw new Error(`Invalid D1 runtime environment: ${env.D1_RUNTIME_ENV || 'missing'}.`)
  }
  return env.DB
}

const observe: CatalogObserver = event => {
  console.info(JSON.stringify(event))
}

const getOperations = cache(async () => {
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as CloudflareEnv
  const dataCache =
    typeof caches === 'undefined'
      ? noCatalogDataCache
      : createCacheApiDataCache(await caches.open('catalog-data-ops'))
  return createCatalogOperations({
    cache: dataCache,
    client: createDatabase(assertCatalogBinding(cloudflareEnv)),
    clock: () => new Date(),
    observe
  })
})

const readPublishedListings = cache(
  async (): Promise<WebsiteMetadata[]> => (await getOperations()).getPublishedListings()
)

const readShellStats = cache(async () => (await getOperations()).getShellStats())

const readListingBySlug = cache(
  async (slug: string): Promise<WebsiteDetailMetadata | null> =>
    (await getOperations()).getListingBySlug(slug)
)

export const getPublishedListings = readPublishedListings

export async function getPublishedListingPage(
  page = 1,
  pageSize = 48
): Promise<PublishedListingPage> {
  return (await getOperations()).getPublishedListingPage(page, pageSize)
}

/**
 * One page of the directory (or of one category) in directory name order. This is how
 * list pages read the catalog; never load `getPublishedListings()` for display.
 */
const readListingNamePage = cache(
  async (category: string, page: number): Promise<ListingNamePage> =>
    (await getOperations()).getListingNamePage({ category: category || undefined, page })
)

export async function getListingNamePage(
  query: Pick<ListingNamePageQuery, 'category' | 'page'>
): Promise<ListingNamePage> {
  return readListingNamePage(query.category ?? '', query.page ?? 1)
}

/** Number of publicly visible listings (cached with the shell statistics). */
export async function getPublishedListingCount(): Promise<number> {
  return (await readShellStats()).listingCount
}

/** Categories that have public listings, in navigation (sort order, name) order. */
export async function getListedCategorySlugs(): Promise<string[]> {
  return (await readShellStats()).categories
    .filter(category => category.count > 0)
    .map(category => category.slug)
}

export async function getFeaturedListings(limit = 6): Promise<WebsiteMetadata[]> {
  return (await getOperations()).getFeaturedListings(limit)
}

export async function getFeaturedListingCount(): Promise<number> {
  return (await readShellStats()).featuredCount
}

export async function getLatestListings(limit = 12): Promise<WebsiteMetadata[]> {
  return (await getOperations()).getLatestListings(limit)
}

export const getListingBySlug = readListingBySlug

export async function getCanonicalSlugForRedirect(oldSlug: string): Promise<string | null> {
  return (await getOperations()).getCanonicalSlugForRedirect(oldSlug)
}

export async function getActiveCategories(): Promise<PublishedCategory[]> {
  return (await readShellStats()).categories
}

export async function getCategoryBySlug(slug: string): Promise<PublishedCategory | null> {
  return (await readShellStats()).categories.find(category => category.slug === slug) || null
}

export async function searchListings(query: string, limit = 50): Promise<WebsiteMetadata[]> {
  return (await getOperations()).searchListings(query, limit)
}

export async function getAutocomplete(query: string, limit = 8): Promise<WebsiteMetadata[]> {
  return (await getOperations()).getAutocomplete(query, limit)
}

export async function getPublicationVersion(): Promise<number> {
  return (await getOperations()).getPublicationVersion()
}

export async function getSitemapListings(): Promise<WebsiteMetadata[]> {
  return (await getOperations()).getSitemapListings()
}
