import { escapeRegExp, listingPath } from './site-fixture'

const listingName = '123Movies Video Downloader'
const listingSlug = '123movies-downloader'

export const detailListing = {
  name: listingName,
  namePattern: new RegExp(escapeRegExp(listingName), 'i'),
  path: listingPath(listingSlug),
  searchQuery: '123movies',
  slug: listingSlug
} as const
