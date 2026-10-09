import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import { Suspense } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { generateBaseMetadata } from '../../lib/seo/seo-config'
import { externalResources } from '../../lib/site/external-resources'
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

function showExternalSearchResources(): boolean {
  return siteConfig.features.showExternalResources && externalResources.length > 0
}

export function generateSearchPageMetadata(): Metadata {
  const showExternalResources = showExternalSearchResources()

  return generateBaseMetadata({
    title: 'Search',
    description: showExternalResources
      ? `Search for listings and external resources in ${siteConfig.name}.`
      : `Search for listings and resources in ${siteConfig.name}.`,
    path: '/search',
    keywords: showExternalResources
      ? ['search', 'find', 'directory listings', 'external resources', 'resources']
      : ['search', 'find', 'directory listings', 'resources']
  })
}

/**
 * The search page (#268): a `PageHero` holding the page's own search field, then the results in
 * the shared card grid.
 */
export function SearchIndexPage({ slots }: SearchIndexPageProps) {
  const showExternalResources = showExternalSearchResources()
  const { SearchResults } = slots

  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <PageHero
          title="Search"
          description={
            showExternalResources
              ? `Searching across all ${siteCopy.listingName.plural} and resources`
              : `Searching across all ${siteCopy.listingName.plural}`
          }
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
