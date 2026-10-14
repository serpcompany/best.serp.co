/**
 * One search entry at a time. These throw on an entry they can't read; the loops in
 * `use-search-helpers.ts` catch each failure and report a response's failures once (#401).
 */
import type { SearchResult } from '../../lib/directory/search-contract'

export interface SearchWebsiteMetadata {
  url: string
  slug: string
  website: string
  name: string
  description: string
  categories: string[]
  /** D1's names for its category slugs, from the search API (#416). */
  categoryNames?: Record<string, string>
  tags: string[]
  category: string
  publishedAt: string
}

export function canTransformToWebsiteMetadata(entry: SearchResult): boolean {
  if (entry.slug.includes('.DS_Store') || entry.url.includes('.DS_Store')) {
    return false
  }

  if (!entry.url || !entry.website) {
    return false
  }

  if (!entry.name && !entry.description) {
    return false
  }

  return true
}

export function transformToWebsiteMetadata(entry: SearchResult): SearchWebsiteMetadata {
  const website = entry.website || ''
  const name = entry.name || 'Untitled'
  const description = entry.description || ''
  const categories = [
    ...(entry.category ? [entry.category] : []),
    ...(entry.categories || [])
  ].filter(Boolean)
  const uniqueCategories = [...new Set(categories)]

  return {
    url: entry.url,
    slug: entry.slug || '',
    website,
    name,
    description,
    categories: uniqueCategories,
    ...(entry.categoryNames ? { categoryNames: entry.categoryNames } : {}),
    tags: [],
    category: uniqueCategories[0] || '',
    publishedAt: ''
  }
}
