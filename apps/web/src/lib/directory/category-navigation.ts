export type CategoryLike = {
  categories?: string[]
  category?: string
}

/** A listing's category slugs, its primary first, each once. */
export function getListingCategories(listing: CategoryLike): string[] {
  const categories = [
    ...(listing.category ? [listing.category] : []),
    ...(listing.categories || [])
  ]
    .map(category => category.trim())
    .filter(Boolean)

  return [...new Set(categories)]
}
