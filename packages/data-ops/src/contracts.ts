import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'
import type { SiteDatabase } from './client'

export type CatalogOperation =
  | 'autocomplete'
  | 'canonical-redirect'
  | 'category-summaries'
  | 'featured-summaries'
  | 'listing-detail'
  | 'listing-page'
  | 'published-summaries'
  | 'publication-version'
  | 'search-summaries'
  | 'shell-stats'

export type CatalogQueryShape =
  | 'canonical-redirect'
  | 'category-summaries'
  | 'featured-summaries'
  | 'listing-detail'
  | 'listing-page-count'
  | 'listing-page-items'
  | 'navigation-next-display'
  | 'navigation-next-publication'
  | 'navigation-next-slug'
  | 'navigation-previous-display'
  | 'navigation-previous-publication'
  | 'navigation-previous-slug'
  | 'publication-version'
  | 'published-summaries'
  | 'related-logos'
  | 'related-ranked-seek'
  | 'related-single-category'
  | 'search-summaries'
  | 'shell-stats'

export interface CatalogQueryEvent {
  d1DurationMs: number | null
  event: 'd1_query'
  operation: CatalogOperation
  queryShape: CatalogQueryShape
  resultRows: number
  rowsRead: number | null
  rowsWritten: number | null
  siteId: ActiveCheckedInSiteId
  success: boolean
  wallDurationMs: number
}

export interface CatalogCacheEvent {
  event: 'catalog_cache'
  operation: 'listing-detail' | 'published-summaries' | 'shell-stats'
  siteId: ActiveCheckedInSiteId
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

export interface ListingDetail extends ListingSummary {
  content?: string
  entityType?: string
  media?: ListingMedia
  nextWebsite: ListingNavigation | null
  previousWebsite: ListingNavigation | null
  priority?: 'high' | 'medium' | 'low'
  relatedWebsites: RelatedListing[]
  resourceLinks?: ListingResourceLink[]
}

export interface ListingPage {
  items: ListingSummary[]
  page: number
  pageSize: number
  total: number
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
  getListingsByCategory(slug: string): Promise<ListingSummary[]>
  getPublicationVersion(): Promise<number>
  getPublishedListingPage(page?: number, pageSize?: number): Promise<ListingPage>
  getPublishedListings(): Promise<ListingSummary[]>
  getShellStats(): Promise<CatalogShellStats>
  getSitemapListings(): Promise<ListingSummary[]>
  searchListings(query: string, limit?: number): Promise<ListingSummary[]>
}

export interface CatalogOperationsConfig {
  cache: CatalogDataCache
  client: SiteDatabase
  clock: () => Date
  observe: CatalogObserver
}
