import type { CatalogEpoch } from './catalog-epoch'
import type { Database } from './client'

export type CatalogOperation =
  | 'autocomplete'
  | 'canonical-redirect'
  | 'category-summaries'
  | 'featured-summaries'
  | 'latest-summaries'
  | 'listing-detail'
  | 'listing-name-order'
  | 'listing-name-page'
  | 'published-summaries'
  | 'publication-version'
  | 'search-summaries'
  | 'shell-stats'
  | 'unpublished-listing'

export type CatalogQueryShape =
  | 'canonical-redirect'
  | 'category-summaries'
  | 'featured-summaries'
  | 'latest-summaries'
  | 'listing-detail'
  | 'listing-name-order'
  | 'listing-name-page-items'
  | 'navigation-next'
  | 'navigation-previous'
  | 'publication-version'
  | 'published-summaries'
  | 'related-shared-categories'
  | 'related-single-category-members'
  | 'related-single-category-seek'
  | 'search-summaries'
  | 'shell-stats'
  | 'unpublished-listing'

export interface CatalogQueryEvent {
  d1DurationMs: number | null
  /**
   * For a failed query: the SQLite result code and a stable reason, such as
   * `SQLITE_ERROR:too_many_variables`. Never the SQL text or bound values (they can hold user
   * input such as search terms).
   */
  errorCode?: string
  event: 'd1_query'
  operation: CatalogOperation
  queryShape: CatalogQueryShape
  resultRows: number
  rowsRead: number | null
  rowsWritten: number | null
  success: boolean
  wallDurationMs: number
}

export interface CatalogCacheEvent {
  event: 'catalog_cache'
  operation:
    | 'featured-summaries'
    | 'latest-summaries'
    | 'listing-detail'
    | 'listing-name-order'
    | 'listing-name-page'
    | 'published-summaries'
    | 'search-summaries'
    | 'shell-stats'
  state: 'corrupt' | 'error' | 'hit' | 'miss' | 'write-error' | 'written'
}

export type CatalogObserver = (event: CatalogCacheEvent | CatalogQueryEvent) => void

export interface CatalogDataCache {
  get(key: string): Promise<unknown | null>
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>
}

export interface ListingLogoMedia {
  logo?: string
}

export interface ListingMedia {
  images?: string[]
  logo?: string
  video?: string
}

export interface ListingResourceLink {
  label: string
  url: string
}

export interface ListingSummary {
  categories?: string[]
  category: string
  description: string
  featured?: boolean
  isUnofficial?: boolean
  media?: ListingLogoMedia
  name: string
  publishedAt: string
  slug: string
  website: string
}

export interface ListingNavigation {
  media?: ListingLogoMedia
  name: string
  slug: string
  website: string
}

export interface RelatedListing {
  description: string
  isUnofficial?: boolean
  media?: ListingLogoMedia
  name: string
  slug: string
  website: string
}

/** The `rel` of our outbound link to the listing's website (an admin setting per listing). */
export type ListingLinkRel = 'follow' | 'nofollow' | 'sponsored'

export interface ListingDetail extends ListingSummary {
  content?: string
  entityType?: string
  /** Rendered on the outbound "Visit Site" link; imported and admin listings are `follow`. */
  linkRel: ListingLinkRel
  media?: ListingMedia
  nextWebsite: ListingNavigation | null
  previousWebsite: ListingNavigation | null
  priority?: 'high' | 'medium' | 'low'
  relatedWebsites: RelatedListing[]
  resourceLinks?: ListingResourceLink[]
  /** Present when the listing has a current owner (`listing_owners`): the "Verified owner" badge. */
  verifiedOwner?: true
}

/**
 * A listing that was published and is now unpublished (`status = 'approved'`, `is_active = 0`).
 * Its URL answers 410 Gone, not 404, until it is republished.
 */
export interface UnpublishedListing {
  /** Primary category slug when that category is still active. */
  category: string | null
  name: string
  slug: string
}

/**
 * One page of listings in directory (name) order, optionally within one category.
 * `firstPublishedAt` / `lastPublishedAt` span the whole collection, not just the page.
 */
export interface ListingNamePage {
  category: string | null
  firstPublishedAt: string | null
  items: ListingSummary[]
  lastPublishedAt: string | null
  page: number
  pageCount: number
  pageSize: number
  total: number
}

export interface ListingNamePageQuery {
  /** Restrict to one active category slug; omit for the whole directory. */
  category?: string
  page?: number
  pageSize?: number
}

export interface PublishedCategory {
  count: number
  description: string
  name: string
  order: number
  slug: string
}

export interface CatalogShellStats {
  categories: PublishedCategory[]
  featuredCount: number
  /** Number of publicly visible listings. */
  listingCount: number
  publicationVersion: number
}

export interface CatalogOperations {
  getActiveCategories(): Promise<PublishedCategory[]>
  getAutocomplete(query: string, limit?: number): Promise<ListingSummary[]>
  getCanonicalSlugForRedirect(oldSlug: string): Promise<string | null>
  getCategoryBySlug(slug: string): Promise<PublishedCategory | null>
  getFeaturedListingCount(): Promise<number>
  getFeaturedListings(limit?: number): Promise<ListingSummary[]>
  getLatestListings(limit?: number): Promise<ListingSummary[]>
  getListingBySlug(slug: string): Promise<ListingDetail | null>
  getListingNamePage(query?: ListingNamePageQuery): Promise<ListingNamePage>
  getPublicationVersion(): Promise<number>
  getPublishedListings(): Promise<ListingSummary[]>
  getShellStats(): Promise<CatalogShellStats>
  getSitemapListings(): Promise<ListingSummary[]>
  /** The unpublished listing at `slug`, or null when the slug is live or never existed. */
  getUnpublishedListing(slug: string): Promise<UnpublishedListing | null>
  /**
   * Public listings whose name, short description, slug, website host, or an active category
   * (slug or name) contains every term of the normalized query (`normalizeSearchQuery`), at
   * most `MAX_SEARCH_LIMIT`.
   */
  searchListings(query: string, limit?: number): Promise<ListingSummary[]>
}

export interface CatalogOperationsConfig {
  cache: CatalogDataCache
  client: Database
  clock: () => Date
  observe: CatalogObserver
  /**
   * An epoch this isolate read moments ago (the Worker entry's, `sharedCatalogEpoch()`), so a
   * render reuses it instead of reading the epoch again; null falls back to D1.
   */
  reuseEpoch?: () => CatalogEpoch | null
}
