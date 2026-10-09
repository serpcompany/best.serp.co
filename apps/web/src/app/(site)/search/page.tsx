import type { Metadata } from 'next'
import { generateSearchPageMetadata, SearchIndexPage } from '@/components/search/index-page'

/**
 * Generate metadata for the static search shell.
 * @returns Promise resolving to Next.js Metadata object
 */
export async function generateMetadata(): Promise<Metadata> {
  return generateSearchPageMetadata()
}

export default function SearchPage() {
  return <SearchIndexPage />
}
