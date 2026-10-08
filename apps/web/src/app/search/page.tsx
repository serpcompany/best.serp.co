import type { Metadata } from 'next'
import { generateSearchPageMetadata, SearchIndexPage } from '@/components/search/index-page'
import { SearchResultsRoute as SearchResults } from '@/components/search/search-results-route'
import { getListedCategorySlugs } from '@/lib/catalog/repository'

/**
 * Generate metadata for the static search shell.
 * @returns Promise resolving to Next.js Metadata object
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateSearchPageMetadata()
}

export default async function SearchPage() {
  return (
    <SearchIndexPage
      activeCategorySlugs={await getListedCategorySlugs()}
      slots={{ SearchResults }}
    />
  )
}
