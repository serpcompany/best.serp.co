import { seedFacts, seedListings, seedResourceLinks, seedWebsite } from './seed-facts'
import { escapeRegExp, listingPath } from './site-fixture'

/**
 * The listing, category and search the local suite samples, from the fixture seed's facts
 * (`seed-facts.ts`, serpcompany/best.serp.co#313), never from the real catalog. The deployed
 * smoke run samples the live catalog instead (`catalog-sample.ts`).
 */
export interface SampleListing {
  name: string
  /** The name as a case-insensitive pattern, for accessible names that may add words. */
  namePattern: RegExp
  path: string
  slug: string
}

export function sampleListing(listing: { name: string; slug: string }): SampleListing {
  return {
    name: listing.name,
    namePattern: new RegExp(escapeRegExp(listing.name), 'i'),
    path: listingPath(listing.slug),
    slug: listing.slug
  }
}

/** `seedListings.detail`: hosted logo and featured image, FAQs, resource links, no owner. */
export const detailListing = {
  ...sampleListing(seedListings.detail),
  /** Its first resource link's label. */
  resourceLink: seedResourceLinks[0].label,
  website: seedWebsite(seedListings.detail.slug)
} as const

/** The detail listing's primary category. */
export const sampleCategory = seedListings.detail.category

const [searchMatch] = seedFacts.search.listings

/** `seedFacts.search`: a query and the one listing it finds. */
export const searchSample = {
  listing: sampleListing(searchMatch),
  query: seedFacts.search.query
} as const
