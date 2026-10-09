import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { Suspense } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { generateBaseMetadata } from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { PageHero } from '../layout/page-hero'
import { PageContainer, PageSection } from '../layout/page-shell'
import { SearchPageForm } from './search-page-form'

type SearchResultsSlot = ComponentType

type SearchIndexPageProps = {
  slots: {
    SearchResults: SearchResultsSlot
  }
}

export function generateSearchPageMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Search',
    description: `Search for listings and resources in ${siteConfig.name}.`,
    path: '/search',
    keywords: ['search', 'find', 'directory listings', 'resources']
  })
}

/**
 * The search page (#268): a `PageHero` holding the page's own search field, then the results in
 * the shared card grid.
 */
export function SearchIndexPage({ slots }: SearchIndexPageProps) {
  const { SearchResults } = slots

  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <PageHero
          title="Search"
          description={`Searching across all ${siteCopy.listingName.plural}`}
          search={
            <Suspense>
              <SearchPageForm />
            </Suspense>
          }
        />
      </PageSection>
      <PageContainer className="py-12">
        <Suspense
          fallback={
            <div className="flex justify-center py-8">
              <Spinner className="size-8" />
            </div>
          }
        >
          <SearchResults />
        </Suspense>
      </PageContainer>
    </>
  )
}
