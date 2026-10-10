import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { cache } from 'react'
import { createCacheApiDataCache, noCatalogDataCache } from '@/db/cache'
import { createCatalogOperations, MAX_SEARCH_LIMIT } from '@/db/catalog'
import { sharedCatalogEpoch } from '@/db/catalog-epoch'
import { createDatabase } from '@/db/client'
import type {
  BestPageItem,
  CatalogObserver,
  ListingNamePage,
  ListingNamePageQuery,
  PublishedBestPage,
  PublishedCategory,
  PublishedTag,
  TaxonomyKind,
  TaxonomyTarget,
  UnpublishedListing
} from '@/db/contracts'
import {
  resolveListingDetailMedia,
  resolveListingMedia,
  validateMediaBaseUrl
} from '@/db/media-keys'
import type { WebsiteDetailMetadata, WebsiteMetadata } from '@/lib/directory/content-query'

export type {
  BestPageItem,
  ListingNamePage,
  PublishedBestPage,
  PublishedCategory,
  PublishedTag,
  TaxonomyKind,
  TaxonomyTarget,
  UnpublishedListing
}
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
 * One page of the directory, or of one category or one tag (#341), in directory name order.
 * This is how list pages read the catalog; never load `getPublishedListings()` for display.
 */
const readListingNamePage = cache(
  async (category: string, tag: string, page: number): Promise<ListingNamePage> => {
    const operations = await getOperations()
    const result = await operations.getListingNamePage(
      tag ? { page, tag } : { category: category || undefined, page }
    )
    return { ...result, items: await withMediaUrls(result.items) }
  }
)

export async function getListingNamePage(
  query: Omit<ListingNamePageQuery, 'pageSize'>
): Promise<ListingNamePage> {
  if (query.category && query.tag) {
    throw new Error('A name page lists one category or one tag, not both.')
  }
  return readListingNamePage(query.category ?? '', query.tag ?? '', query.page ?? 1)
}

/** Number of publicly visible listings (cached with the shell statistics). */
export async function getPublishedListingCount(): Promise<number> {
  return (await readShellStats()).listingCount
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

const readActiveTags = cache(async () => (await getOperations()).getActiveTags())

/** Active tags with their hubs and public counts (#341), cached per epoch. */
export async function getActiveTags(): Promise<PublishedTag[]> {
  return readActiveTags()
}

export async function getTagBySlug(slug: string): Promise<PublishedTag | null> {
  return (await readActiveTags()).find(tag => tag.slug === slug) || null
}

const readBestPages = cache(async () => (await getOperations()).getBestPages())

/** Every active best page with its pool size (the best index, #341), cached per epoch. */
export async function getBestPages(): Promise<PublishedBestPage[]> {
  return readBestPages()
}

export async function getBestPageBySlug(slug: string): Promise<PublishedBestPage | null> {
  return (await readBestPages()).find(page => page.slug === slug) || null
}

/** A best page's entries in rank order, with media URLs on the media host (#341). */
export const getBestPageItems = cache(
  async (slug: string): Promise<BestPageItem[]> =>
    withMediaUrls(await (await getOperations()).getBestPageItems(slug))
)

/**
 * Where a retired or renamed category, tag or best page URL moved (#341), or null; ask only
 * after the page missed.
 */
export async function getTaxonomyRedirect(
  kind: TaxonomyKind,
  slug: string
): Promise<TaxonomyTarget | null> {
  return (await getOperations()).getTaxonomyRedirect(kind, slug)
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
