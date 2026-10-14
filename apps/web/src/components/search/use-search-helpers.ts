import { logger } from '@/lib/logging'
import type { ErrorCode } from '@/lib/telemetry/sentry'
import type { SearchResult } from '../../lib/directory/search-contract'
import type { SearchWebsiteMetadata } from './search-utils'
import { canTransformToWebsiteMetadata, transformToWebsiteMetadata } from './search-utils'

interface EntryFailure {
  code: ErrorCode
  error: unknown
  entry?: SearchResult
}

/**
 * The entries one search response failed on (#401). A response holds up to 100 entries, and one
 * bad shape fails each of them, so the helpers record each failure here, and `report()` sends one
 * Sentry event for the response: the first failure's code, with its error as the cause. Every
 * failure and its entry go in `data`, which stays in the browser console.
 */
export class EntryFailures {
  private readonly failures: EntryFailure[] = []

  record(code: ErrorCode, error: unknown, entry?: SearchResult): void {
    this.failures.push({ code, error, ...(entry === undefined ? {} : { entry }) })
  }

  report(): void {
    const [first] = this.failures
    if (!first) return
    logger.error(first.code, {
      cause: first.error,
      data: this.failures,
      tags: { type: 'component' }
    })
  }
}

/**
 * The API's matches, best first. Every entry stays: the API matched the query on each listing's
 * name, description and slug and on its categories' and tags' names, and matching it again here on
 * the listing's own text hid the listings found through a category or tag name (#432).
 */
export function sortEntries(entries: SearchResult[], query: string): SearchResult[] {
  const queryLower = query.toLowerCase()

  return [...entries].sort((left, right) => {
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

export function validateEntries(entries: SearchResult[], failures: EntryFailures): SearchResult[] {
  return entries.filter(entry => {
    try {
      return canTransformToWebsiteMetadata(entry)
    } catch (validationError) {
      failures.record('search_entry_check_failed', validationError, entry)
      return false
    }
  })
}

export function transformAndSanitizeEntries(
  entries: SearchResult[],
  failures: EntryFailures
): SearchWebsiteMetadata[] {
  return entries
    .map(entry => {
      try {
        return transformToWebsiteMetadata(entry)
      } catch (transformError) {
        failures.record('search_entry_transform_failed', transformError, entry)
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

export function tryLenientProcessing(
  entries: SearchResult[],
  failures: EntryFailures
): SearchWebsiteMetadata[] {
  try {
    return entries
      .map(entry => {
        try {
          return transformToWebsiteMetadata(entry)
        } catch (transformError) {
          failures.record('search_entry_transform_failed', transformError, entry)
          return null
        }
      })
      .filter((item): item is SearchWebsiteMetadata => item !== null && item !== undefined)
  } catch (lenientError) {
    failures.record('search_lenient_processing_failed', lenientError)
    return []
  }
}
