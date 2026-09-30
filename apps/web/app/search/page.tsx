import {
  generateSearchPageMetadata,
  SearchIndexPage
} from '@serpdirectory/web-core/search/index-page'
import { SearchResultsRoute as SearchResults } from '@serpdirectory/web-core/search/search-results-route'
import type { Metadata } from 'next'
import { getWebsites } from '@/lib/content-loader'

/**
 * Generate metadata for the static search shell.
 * @returns Promise resolving to Next.js Metadata object
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateSearchPageMetadata()
}

export default async function SearchPage() {
  return <SearchIndexPage allProjects={await getWebsites()} slots={{ SearchResults }} />
}
