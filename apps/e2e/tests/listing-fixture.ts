const listingName = process.env.E2E_LISTING_NAME ?? '123Movies Video Downloader'
const listingSlug = process.env.E2E_LISTING_SLUG ?? '123movies-downloader'

export const detailListing = {
  name: listingName,
  namePattern: new RegExp(listingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  searchQuery: listingSlug.replace(/-downloader$/, '').replace(/-/g, ' '),
  slug: listingSlug
} as const
