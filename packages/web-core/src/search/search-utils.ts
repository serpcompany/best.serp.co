import { logger } from '@serpdirectory/logging'
import type { SearchResult } from '../search-contract'

export interface SearchWebsiteMetadata {
  url: string
  slug: string
  website: string
  name: string
  description: string
  categories: string[]
  tags: string[]
  category: string
  publishedAt: string
}

export function canTransformToWebsiteMetadata(entry: SearchResult): boolean {
  try {
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
  } catch (error) {
    logger.error('Error checking entry validity:', {
      data: { error, entry },
      tags: { type: 'component' }
    })
    return false
  }
}

export function transformToWebsiteMetadata(entry: SearchResult): SearchWebsiteMetadata {
  try {
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
      tags: [],
      category: uniqueCategories[0] || '',
      publishedAt: ''
    }
  } catch (error) {
    logger.error('Error transforming entry:', {
      data: { error, entry },
      tags: { type: 'component' }
    })

    return {
      url: '',
      slug: '',
      website: '',
      name: 'Unknown',
      description: '',
      categories: [],
      tags: [],
      category: '',
      publishedAt: ''
    }
  }
}

export function matchesSearchQuery(entry: SearchResult, query: string): boolean {
  try {
    if (!query) {
      return false
    }

    const searchTerms = query.toLowerCase().trim().split(/\s+/)
    const searchableFields = [
      entry.name?.toLowerCase(),
      entry.description?.toLowerCase(),
      entry.category?.toLowerCase(),
      entry.categories?.join(' ').toLowerCase(),
      entry.website?.toLowerCase(),
      entry.url?.toLowerCase()
    ].filter(Boolean)

    return searchTerms.every(term => searchableFields.some(field => field?.includes(term)))
  } catch (error) {
    logger.error('Error matching query:', {
      data: { error, entry, query },
      tags: { type: 'component' }
    })
    return false
  }
}
