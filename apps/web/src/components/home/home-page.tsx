import type { Metadata } from 'next'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import {
  type GuideMetadata,
  toWebsiteBrowseCardMetadata,
  type WebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import {
  generateBaseMetadata,
  generateWebsiteSchema,
  KEYWORDS,
  siteUrl
} from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { type ListingPageInfo, ListingPagination } from '../directory/listing-pagination'
import { AppSidebar } from '../layout/app-sidebar'
import { HeroSection } from '../sections/hero-section'
import { NewsletterSection } from '../sections/newsletter-section'

/** One page of the directory, already in directory (name) order. */
export interface DirectoryPage extends ListingPageInfo {
  items: WebsiteMetadata[]
  pageSize: number
}

export interface HomePageData {
  /** Categories with public listings, in navigation order. */
  activeCategorySlugs: string[]
  browse: DirectoryPage
  featuredGuides: GuideMetadata[]
  featuredProjects: WebsiteMetadata[]
  recentlyUpdatedProjects: WebsiteMetadata[]
  totalCount: number
}

interface BuildHomePageDataInput {
  activeCategorySlugs: string[]
  browse: DirectoryPage
  /** Featured listings in publication order (the `is_featured` placement flag). */
  featured: WebsiteMetadata[]
  guides: GuideMetadata[]
  /** Latest listings in publication order. */
  latest: WebsiteMetadata[]
  totalCount: number
}

const HOMEPAGE_CARD_SECTION_SIZE = 8

export function buildHomePageData({
  activeCategorySlugs,
  browse,
  featured,
  guides,
  latest,
  totalCount
}: BuildHomePageDataInput): HomePageData {
  return {
    activeCategorySlugs,
    browse,
    featuredGuides: guides,
    // Without featured listings the section falls back to the newest ones, as before.
    featuredProjects: (featured.length ? featured : latest).slice(0, HOMEPAGE_CARD_SECTION_SIZE),
    recentlyUpdatedProjects: latest.slice(0, HOMEPAGE_CARD_SECTION_SIZE),
    totalCount
  }
}

interface JsonLdProps {
  data: Record<string, any>
}

interface FeaturedGuidesSectionProps {
  guides: GuideMetadata[]
}

interface FeaturedProjectsSectionProps {
  projects: WebsiteBrowseCardMetadata[]
}

interface RecentlyAddedSectionProps {
  websites: WebsiteBrowseCardMetadata[]
}

interface StaticWebsitesListProps {
  displayLimit: number
  pagination?: ReactNode
  totalCount: number
  websites: WebsiteBrowseCardMetadata[]
}

export interface HomePageSlots {
  CreatorProjectsSection: ComponentType
  ExternalResourcesSection: ComponentType
  FeaturedGuidesSection: ComponentType<FeaturedGuidesSectionProps>
  FeaturedProjectsSection: ComponentType<FeaturedProjectsSectionProps>
  JsonLd: (props: JsonLdProps) => ReactElement | Promise<ReactElement>
  RecentlyAddedSection: ComponentType<RecentlyAddedSectionProps>
  StaticWebsitesList: ComponentType<StaticWebsitesListProps>
}

/** The homepage URL is the bare origin, `https://best.serp.co`, never `https://best.serp.co/`. */
const HOME_URL = siteUrl('/')

const {
  alternates: _homeAlternates,
  openGraph: homeOpenGraph,
  ...homeMetadata
} = generateBaseMetadata({
  title: `${siteConfig.name} Directory of ${siteCopy.listingName.pluralTitle} and Resources`,
  description: `${siteConfig.tagline}. Browse curated ${siteCopy.listingName.plural}, resources, and documentation links in one searchable directory.`,
  keywords: [
    ...KEYWORDS.homepage,
    ...KEYWORDS.global,
    'directory listings',
    'curated resources',
    'documentation links',
    'resource directory',
    'searchable directory'
  ],
  path: '/'
})

/**
 * With `trailingSlash`, the Next.js metadata API appends `/` to every same-origin URL, so it
 * would write the homepage canonical and `og:url` as `https://best.serp.co/`. The homepage
 * therefore leaves both unset here and renders `HomePageCanonicalTags` instead. See the URL
 * trailing-slash standard.
 */
export const homePageMetadata: Metadata = {
  ...homeMetadata,
  openGraph: { ...homeOpenGraph, url: undefined }
}

/**
 * The homepage canonical and `og:url`, written as the bare origin. React hoists both tags
 * into `<head>`. The homepage renders it, and so does `/products/`'s first page, whose canonical
 * is `/` (#167); its later pages keep their own canonical metadata.
 */
export function HomePageCanonicalTags(): ReactElement {
  return (
    <>
      <link rel="canonical" href={HOME_URL} />
      <meta property="og:url" content={HOME_URL} />
    </>
  )
}

interface HomePageRouteProps {
  data: HomePageData
  slots: HomePageSlots
}

export function HomePageRoute({ data, slots }: HomePageRouteProps): ReactElement {
  const HOMEPAGE_SECTION_LIMIT = 200
  const {
    activeCategorySlugs,
    browse,
    featuredGuides,
    featuredProjects,
    recentlyUpdatedProjects,
    totalCount
  } = data
  const {
    CreatorProjectsSection,
    ExternalResourcesSection,
    FeaturedGuidesSection,
    FeaturedProjectsSection,
    JsonLd,
    RecentlyAddedSection,
    StaticWebsitesList
  } = slots

  const homepageProjects = browse.items.map(toWebsiteBrowseCardMetadata)
  const featuredProjectCards = featuredProjects.map(toWebsiteBrowseCardMetadata)
  const recentlyUpdatedProjectCards = recentlyUpdatedProjects.map(toWebsiteBrowseCardMetadata)
  const homepageFeaturedGuides = featuredGuides.slice(0, HOMEPAGE_SECTION_LIMIT)

  return (
    <>
      <JsonLd data={generateWebsiteSchema()} />
      <div className="w-full space-y-16">
        <HeroSection websiteCount={totalCount} />
      </div>
      <div className="border-t">
        <div className="relative flex h-full w-full max-w-full flex-row flex-nowrap">
          <AppSidebar availableCategorySlugs={activeCategorySlugs} />

          <div className="relative flex h-full w-full flex-col px-6 pt-6 pb-16 space-y-8">
            <section>
              <FeaturedProjectsSection projects={featuredProjectCards} />
            </section>

            <section>
              <RecentlyAddedSection websites={recentlyUpdatedProjectCards} />
            </section>

            <section>
              <StaticWebsitesList
                websites={homepageProjects}
                totalCount={totalCount}
                displayLimit={browse.pageSize}
                pagination={
                  <ListingPagination
                    basePath={getRoute('listing.list')}
                    fragment={siteCopy.allAnchorId}
                    page={browse.page}
                    pageCount={browse.pageCount}
                  />
                }
              />
            </section>

            {siteConfig.features.showExternalResources && <ExternalResourcesSection />}
            {siteConfig.features.showFeaturedGuides && (
              <FeaturedGuidesSection guides={homepageFeaturedGuides} />
            )}
            {siteConfig.features.showCreatorProjects && <CreatorProjectsSection />}
            {siteConfig.features.showNewsletter && <NewsletterSection />}
          </div>
        </div>
      </div>
    </>
  )
}
