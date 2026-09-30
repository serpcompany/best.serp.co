import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { Heart } from 'lucide-react'
import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import { getActiveCategories } from '../category-navigation'
import {
  type GuideMetadata,
  toWebsiteBrowseCardMetadata,
  type WebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../content-query'
import { AppSidebar } from '../layout/app-sidebar'
import { NewsletterSection } from '../sections/newsletter-section'
import { generateBaseMetadata, SITE_NAME, SITE_PUBLIC_URL } from '../seo-config'
import { siteCopy } from '../site-copy'

type JsonLdProps = {
  data: Record<string, unknown>
}

type FeaturedGuidesSectionProps = {
  guides: GuideMetadata[]
}

type WebsitesListWithSearchProps = {
  initialShowFavoritesOnly?: boolean
  initialWebsites: WebsiteBrowseCardMetadata[]
  totalCount: number
}

type FavoritesPageSlots = {
  FeaturedGuidesSection: ComponentType<FeaturedGuidesSectionProps>
  JsonLd: (props: JsonLdProps) => ReactNode | Promise<ReactNode>
  WebsitesListWithSearch: ComponentType<WebsitesListWithSearchProps>
}

type FavoritesPageProps = {
  allProjects: WebsiteMetadata[]
  featuredGuides: GuideMetadata[]
  featuredProjects: WebsiteMetadata[]
  slots: FavoritesPageSlots
  totalCount: number
}

export const favoritesPageMetadata: Metadata = generateBaseMetadata({
  title: `Saved Favorites - ${SITE_NAME}`,
  description: `View and manage the ${siteCopy.listingName.plural} and related resources you have saved from the directory.`,
  keywords: [
    'favorites',
    `saved ${siteCopy.listingName.plural}`,
    'bookmarks',
    'directory listings',
    'resources'
  ],
  path: '/favorites'
})

export function FavoritesIndexPage({
  allProjects,
  featuredGuides,
  featuredProjects,
  slots,
  totalCount
}: FavoritesPageProps) {
  const activeCategories = getActiveCategories(allProjects)
  const activeCategorySlugs = activeCategories.map(category => category.slug)
  const { FeaturedGuidesSection, JsonLd, WebsitesListWithSearch } = slots
  const projectCards = allProjects.map(toWebsiteBrowseCardMetadata)

  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: `Favorites - ${SITE_NAME}`,
          description: `Your saved ${siteCopy.listingName.plural}`,
          url: `${SITE_PUBLIC_URL}/favorites`
        }}
      />

      <div className="border-t">
        <div className="relative flex h-full w-full max-w-full flex-row flex-nowrap">
          <AppSidebar
            availableCategorySlugs={activeCategorySlugs}
            featuredCount={featuredProjects.length}
          />

          <div className="relative flex h-full w-full flex-col gap-3 px-6 pt-6 pb-16">
            <Breadcrumb
              items={[{ name: 'Favorites', href: '/favorites' }]}
              baseUrl={SITE_PUBLIC_URL}
            />

            <div className="mb-6">
              <div className="mb-3 flex items-center gap-3">
                <Heart className="h-8 w-8 fill-red-500 text-red-500" />
                <h1 className="text-3xl font-bold">Saved Favorites</h1>
              </div>
              <p className="text-muted-foreground">
                Your saved {siteCopy.listingName.plural} and related resources from the directory
              </p>
            </div>

            <WebsitesListWithSearch
              initialWebsites={projectCards}
              initialShowFavoritesOnly={true}
              totalCount={totalCount}
            />

            <div className="mt-12 space-y-8">
              <FeaturedGuidesSection guides={featuredGuides} />
              <NewsletterSection />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
