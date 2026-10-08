import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createCacheApiDataCache, noCatalogDataCache } from '@serpdirectory/data-ops/cache'
import { createCatalogOperations, MAX_SEARCH_LIMIT } from '@serpdirectory/data-ops/catalog'
import { sharedCatalogEpoch } from '@serpdirectory/data-ops/catalog-epoch'
import { createDatabase } from '@serpdirectory/data-ops/client'
import type {
  CatalogObserver,
  ListingNamePage,
  ListingNamePageQuery,
  PublishedCategory,
  UnpublishedListing
} from '@serpdirectory/data-ops/contracts'
import {
  resolveListingDetailMedia,
  resolveListingMedia,
  validateMediaBaseUrl
} from '@serpdirectory/data-ops/media-keys'
import type { WebsiteDetailMetadata, WebsiteMetadata } from '@/lib/directory/content-query'
import { cache } from 'react'

export type { ListingNamePage, PublishedCategory, UnpublishedListing }
/** Largest `limit` search and autocomplete honor (`/api/search` clamps to it). */
export { MAX_SEARCH_LIMIT }

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
    observe,
    // The Worker entry just read the epoch for the edge cache key; reuse it (#77).
    reuseEpoch: () => sharedCatalogEpoch()
  })
})

/**
 * The environment's media host (#95). The catalog and its data cache hold media keys; pages get
 * URLs on this host. A missing or malformed value fails closed, like the D1 binding.
 */
const getMediaBaseUrl = cache(async (): Promise<string> => {
  const { env } = await getCloudflareContext({ async: true })
  const cloudflareEnv = env as CloudflareEnv
  return validateMediaBaseUrl(cloudflareEnv.MEDIA_BASE_URL, cloudflareEnv.D1_RUNTIME_ENV)
})

async function withMediaUrls<T extends { media?: { images?: string[]; logo?: string } }>(
  listings: T[]
): Promise<T[]> {
  const base = await getMediaBaseUrl()
  return listings.map(listing => resolveListingMedia(listing, base))
}

const readPublishedListings = cache(
  async (): Promise<WebsiteMetadata[]> =>
    withMediaUrls(await (await getOperations()).getPublishedListings())
)

const readShellStats = cache(async () => (await getOperations()).getShellStats())

const readListingBySlug = cache(async (slug: string): Promise<WebsiteDetailMetadata | null> => {
  const detail = await (await getOperations()).getListingBySlug(slug)
  return detail && resolveListingDetailMedia(detail, await getMediaBaseUrl())
})

export const getPublishedListings = readPublishedListings

/**
 * One page of the directory (or of one category) in directory name order. This is how
 * list pages read the catalog; never load `getPublishedListings()` for display.
 */
const readListingNamePage = cache(
  async (category: string, page: number): Promise<ListingNamePage> => {
    const result = await (await getOperations()).getListingNamePage({
      category: category || undefined,
      page
    })
    return { ...result, items: await withMediaUrls(result.items) }
  }
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
  return withMediaUrls(await (await getOperations()).getFeaturedListings(limit))
}

export async function getFeaturedListingCount(): Promise<number> {
  return (await readShellStats()).featuredCount
}

export async function getLatestListings(limit = 12): Promise<WebsiteMetadata[]> {
  return withMediaUrls(await (await getOperations()).getLatestListings(limit))
}

export const getListingBySlug = readListingBySlug

export async function getCanonicalSlugForRedirect(oldSlug: string): Promise<string | null> {
  return (await getOperations()).getCanonicalSlugForRedirect(oldSlug)
}

/**
 * A listing that was published and is now unpublished, so its URL answers 410 Gone (#64);
 * null for a slug that was never published.
 */
export const getUnpublishedListing = cache(
  async (slug: string): Promise<UnpublishedListing | null> =>
    (await getOperations()).getUnpublishedListing(slug)
)

export async function getActiveCategories(): Promise<PublishedCategory[]> {
  return (await readShellStats()).categories
}

export async function getCategoryBySlug(slug: string): Promise<PublishedCategory | null> {
  return (await readShellStats()).categories.find(category => category.slug === slug) || null
}

export async function searchListings(query: string, limit = 50): Promise<WebsiteMetadata[]> {
  return withMediaUrls(await (await getOperations()).searchListings(query, limit))
}

export async function getAutocomplete(query: string, limit = 8): Promise<WebsiteMetadata[]> {
  return withMediaUrls(await (await getOperations()).getAutocomplete(query, limit))
}

export async function getPublicationVersion(): Promise<number> {
  return (await getOperations()).getPublicationVersion()
}

export async function getSitemapListings(): Promise<WebsiteMetadata[]> {
  return withMediaUrls(await (await getOperations()).getSitemapListings())
}
