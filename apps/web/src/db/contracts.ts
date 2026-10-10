import type { CatalogEpoch } from './catalog-epoch'
import type { Database } from './client'

export type CatalogOperation =
  | 'autocomplete'
  | 'best-index'
  | 'best-page-items'
  | 'canonical-redirect'
  | 'featured-summaries'
  | 'latest-summaries'
  | 'legacy-root-target'
  | 'listing-detail'
  | 'listing-name-order'
  | 'listing-name-page'
  | 'published-summaries'
  | 'publication-version'
  | 'search-summaries'
  | 'shell-stats'
  | 'tag-stats'
  | 'taxonomy-redirect'
  | 'unpublished-listing'
  | 'unpublished-listing-status'

export type CatalogQueryShape =
  | 'best-index'
  | 'best-page-items'
  | 'canonical-redirect'
  | 'featured-summaries'
  | 'latest-summaries'
  | 'legacy-root-target'
  | 'listing-detail'
  | 'listing-name-order'
  | 'listing-name-page-items'
  | 'navigation-next'
  | 'navigation-previous'
  | 'publication-version'
  | 'published-summaries'
  | 'related-shared-categories'
  | 'related-shared-tags'
  | 'related-single-category-members'
  | 'related-single-category-seek'
  | 'search-summaries'
  | 'shell-stats'
  | 'tag-name-order'
  | 'tag-stats'
  | 'taxonomy-redirect'
  | 'unpublished-listing'
  | 'unpublished-listing-status'

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
    | 'best-index'
    | 'best-page-items'
    | 'featured-summaries'
    | 'latest-summaries'
    | 'listing-detail'
    | 'listing-name-order'
    | 'listing-name-page'
    | 'published-summaries'
    | 'search-summaries'
    | 'shell-stats'
    | 'tag-stats'
  state: 'corrupt' | 'error' | 'hit' | 'miss' | 'write-error' | 'written'
}

export type CatalogObserver = (event: CatalogCacheEvent | CatalogQueryEvent) => void

export interface CatalogDataCache {
  get(key: string): Promise<unknown | null>
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>
}

/**
 * A logo or image is a hosted media key (`best.serp.co/listings/…`, #95) or, until the legacy
 * migration repoints it, the imported reference. The web adapter resolves keys against the
 * environment's media host (`mediaUrl` in `media-keys.ts`); DTOs and their cache hold keys only.
 */
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

/** An approved question and answer on a listing (`listing_faqs`, #105). */
export interface ListingFaq {
  answer: string
  question: string
}

export interface ListingSummary {
  categories?: string[]
  category: string
  description: string
  featured?: boolean
  isUnofficial?: boolean
  media?: ListingLogoMedia
  /**
   * When the public listing last changed: the later of `published_at` and `updated_at`, as an
   * ISO instant. Sitemap `lastmod` and JSON-LD `dateModified` (#218).
   */
  modifiedAt: string
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

/** One of a listing's active tags (#341). */
export interface ListingTag {
  name: string
  slug: string
}

export interface ListingDetail extends ListingSummary {
  content?: string
  entityType?: string
  /** The listing's FAQs in order (#105); absent when it has none. */
  faqs?: ListingFaq[]
  /** Rendered on the outbound "Visit Site" link; imported and admin listings are `follow`. */
  linkRel: ListingLinkRel
  media?: ListingMedia
  nextWebsite: ListingNavigation | null
  previousWebsite: ListingNavigation | null
  priority?: 'high' | 'medium' | 'low'
  relatedWebsites: RelatedListing[]
  resourceLinks?: ListingResourceLink[]
  /**
   * Its active tags (#341), the most central first (`listing_tags.sort_order`, then slug); absent
   * when it has none. A listing with tags takes its related listings from them.
   */
  tags?: ListingTag[]
  /** Present when the listing has a current owner (`listing_owners`): the "Verified owner" badge. */
  verifiedOwner?: true
}

/**
 * A listing that was published and is now unpublished (`status = 'approved'`, `is_active = 0`).
 * Its URL answers 410 Gone, not 404, until it is republished, unless it is filed under a retired
 * category (#260): then it is not found.
 */
export interface UnpublishedListing {
  /** Primary category slug when that category is still active. */
  category: string | null
  /** That category's display name, for the 410 page's link (#64). */
  categoryName: string | null
  name: string
  slug: string
}

/**
 * One page of listings in directory (name) order, optionally within one category or one tag.
 * `firstPublishedAt` / `lastPublishedAt` / `lastModifiedAt` span the whole collection, not just
 * the page; `lastModifiedAt` is the newest `modifiedAt` among its listings (#218).
 */
export interface ListingNamePage {
  category: string | null
  firstPublishedAt: string | null
  items: ListingSummary[]
  lastModifiedAt: string | null
  lastPublishedAt: string | null
  page: number
  pageCount: number
  pageSize: number
  /** The tag the page is of (#341), or null. */
  tag: string | null
  total: number
}

/** One page of the whole directory, of one active category, or of one active tag (#341). */
export type ListingNamePageQuery = {
  page?: number
  pageSize?: number
} & (
  | {
      /** Restrict to one active category slug; omit for the whole directory. */
      category?: string
      tag?: undefined
    }
  | {
      category?: undefined
      /** Restrict to one active tag slug (#341). */
      tag?: string
    }
)

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

/** An active tag (#341, design 3.1) with its public listings. */
export interface PublishedTag {
  /** Its hub: the active category it sits under. */
  category: string
  /** Its public listings. */
  count: number
  description: string
  /** The newest `modifiedAt` among its public listings (its sitemap `lastmod`), or null. */
  lastModifiedAt: string | null
  name: string
  order: number
  slug: string
}

/**
 * An active best page (`/best/<slug>/`, #341, design 1.3) whose tag and category, where set, are
 * active. Its pool is the public listings with its tag, in its category, or both, less its
 * exclusions, plus its public pins; the page shows the first `min(listSize, poolSize)`.
 */
export interface PublishedBestPage {
  /** The category it ranks within, or null when it ranks a tag alone. */
  category: string | null
  heading: string
  /** The hub it belongs to: its category, else its tag's. */
  hub: string
  intro: string
  keyword: string
  /** The later of the page's own `updated_at` and the newest `modifiedAt` in its pool. */
  lastModifiedAt: string
  listSize: number
  order: number
  poolSize: number
  slug: string
  /** The tag it ranks, or null when it ranks a category alone. */
  tag: string | null
  title: string
}

/** One entry of a best page, in rank order (#341, design 1.3 and 5.1). */
export interface BestPageItem extends ListingSummary {
  /** The owner's "why it is here" for a pinned entry. */
  blurb?: string
  /** Rendered on the entry's "Visit site" link. */
  linkRel: ListingLinkRel
}

/** The kinds of taxonomy URL `taxonomy_redirects` can move (#341, design 2.2). */
export type TaxonomyKind = 'best' | 'category' | 'tag'

/** Where a moved taxonomy URL points: an active category, tag or best page, or the directory. */
export type TaxonomyTarget =
  | { kind: TaxonomyKind; slug: string }
  | { kind: 'directory'; slug: null }

export interface CatalogOperations {
  getActiveCategories(): Promise<PublishedCategory[]>
  /** Active tags with their hubs and public counts, cached per epoch (#341). */
  getActiveTags(): Promise<PublishedTag[]>
  getAutocomplete(query: string, limit?: number): Promise<ListingSummary[]>
  /** The active best page at `slug`, from the best index, or null (#341). */
  getBestPageBySlug(slug: string): Promise<PublishedBestPage | null>
  /**
   * The entries of the best page at `slug`, in rank order: pins by position, then tag
   * centrality, hosted logos first, then name and slug; at most its `listSize`. Empty for a slug
   * that is not an active best page (#341, design 1.3).
   */
  getBestPageItems(slug: string): Promise<BestPageItem[]>
  /** Every active best page (the best index), cached per epoch (#341). */
  getBestPages(): Promise<PublishedBestPage[]>
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
  getTagBySlug(slug: string): Promise<PublishedTag | null>
  /**
   * Where a retired or renamed category, tag or best page URL moved (`taxonomy_redirects`, #341
   * design 2.2), or null when it has no redirect or its target is no longer active. Uncached: one
   * primary-key seek, asked only after the page missed.
   */
  getTaxonomyRedirect(kind: TaxonomyKind, slug: string): Promise<TaxonomyTarget | null>
  /**
   * The unpublished listing at `slug`, or null when the slug is live, never existed, or is filed
   * under a retired category (#260).
   */
  getUnpublishedListing(slug: string): Promise<UnpublishedListing | null>
  /**
   * Public listings whose name, short description, slug, or an active category or tag (slug or
   * name) contains every term of the normalized query (`normalizeSearchQuery`), at most
   * `MAX_SEARCH_LIMIT`.
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
