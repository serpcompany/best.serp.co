import { type Category, normalizeCategorySlug, resolveCategories } from './categories'

export type CategoryLike = {
  categories?: string[]
  category?: string
  featured?: boolean
}

function normalizeListingCategory(category: string): string {
  return normalizeCategorySlug(category)
}

export function getListingCategories(listing: CategoryLike): string[] {
  const normalizedCategories = [
    ...(listing.category ? [listing.category] : []),
    ...(listing.categories || [])
  ]
    .map(category => category.trim())
    .filter(Boolean)
    .map(normalizeListingCategory)

  return [...new Set(normalizedCategories)]
}

export function listingMatchesCategory(listing: CategoryLike, categorySlug: string): boolean {
  return getListingCategories(listing).includes(normalizeListingCategory(categorySlug))
}

export function getActiveCategories(listings: CategoryLike[]): Category[] {
  return resolveCategories(listings.flatMap(getListingCategories))
}

export function getFeaturedListingCount(listings: CategoryLike[]): number {
  return listings.filter(listing => listing.featured === true).length
}

export function hasFeaturedListings(listings: CategoryLike[]): boolean {
  return getFeaturedListingCount(listings) > 0
}
