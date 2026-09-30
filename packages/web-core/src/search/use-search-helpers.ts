import { logger } from '@serpdirectory/logging'
import type { SearchResult } from '../search-contract'
import type { SearchWebsiteMetadata } from './search-utils'
import {
  canTransformToWebsiteMetadata,
  matchesSearchQuery,
  transformToWebsiteMetadata
} from './search-utils'

export function filterAndSortEntries(entries: SearchResult[], query: string): SearchResult[] {
  const queryLower = query.toLowerCase()

  return entries
    .filter(entry => {
      try {
        return matchesSearchQuery(entry, query)
      } catch (matchError) {
        logger.error('Error matching entry:', {
          data: { matchError, entry },
          tags: { type: 'component' }
        })
        return false
      }
    })
    .sort((left, right) => {
      const leftTitle = left.name.toLowerCase()
      const rightTitle = right.name.toLowerCase()

      if (leftTitle === queryLower && rightTitle !== queryLower) return -1
      if (rightTitle === queryLower && leftTitle !== queryLower) return 1

      if (leftTitle.startsWith(queryLower) && !rightTitle.startsWith(queryLower)) return -1
      if (rightTitle.startsWith(queryLower) && !leftTitle.startsWith(queryLower)) return 1

      if (leftTitle.includes(queryLower) && !rightTitle.includes(queryLower)) return -1
      if (rightTitle.includes(queryLower) && !leftTitle.includes(queryLower)) return 1

      return leftTitle.localeCompare(rightTitle)
    })
}

export function validateEntries(entries: SearchResult[]): SearchResult[] {
  return entries.filter(entry => {
    try {
      return canTransformToWebsiteMetadata(entry)
    } catch (validationError) {
      logger.error('Error validating entry:', {
        data: { validationError, entry },
        tags: { type: 'component' }
      })
      return false
    }
  })
}

export function transformAndSanitizeEntries(entries: SearchResult[]): SearchWebsiteMetadata[] {
  return entries
    .map(entry => {
      try {
        return transformToWebsiteMetadata(entry)
      } catch (transformError) {
        logger.error('Error transforming entry:', {
          data: { transformError, entry },
          tags: { type: 'component' }
        })
        return {
          url: '',
          slug: 'error',
          name: 'Error processing result',
          description: '',
          website: '#',
          category: '',
          publishedAt: '',
          categories: [],
          tags: []
        }
      }
    })
    .map(result => {
      if (!result.website || result.website === '#') {
        return result
      }

      try {
        new URL(result.website.startsWith('http') ? result.website : `https://${result.website}`)
        return result
      } catch {
        return {
          ...result,
          website: '#'
        }
      }
    })
}

export function tryLenientProcessing(entries: SearchResult[]): SearchWebsiteMetadata[] {
  try {
    return entries
      .map(entry => {
        try {
          return transformToWebsiteMetadata(entry)
        } catch {
          return null
        }
      })
      .filter((item): item is SearchWebsiteMetadata => item !== null && item !== undefined)
  } catch (lenientError) {
    logger.error('Error during lenient processing:', {
      data: lenientError,
      tags: { type: 'component' }
    })
    return []
  }
}
