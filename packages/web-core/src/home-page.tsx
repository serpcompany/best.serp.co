import type { Metadata } from 'next'
import type { ComponentType, ReactElement } from 'react'
import { getActiveCategories, getFeaturedListingCount } from './category-navigation'
import {
  type GuideMetadata,
  toWebsiteBrowseCardMetadata,
  type WebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from './content-query'
import { AppSidebar } from './layout/app-sidebar'
import { HeroSection } from './sections/hero-section'
import { NewsletterSection } from './sections/newsletter-section'
import { generateBaseMetadata, generateWebsiteSchema, KEYWORDS } from './seo-config'
import { siteConfig } from './site-config'
import { siteCopy } from './site-copy'

export interface HomePageData {
  allProjects: WebsiteMetadata[]
  featuredGuides: GuideMetadata[]
  featuredProjects: WebsiteMetadata[]
  recentlyUpdatedProjects: WebsiteMetadata[]
  totalCount: number
}

interface BuildHomePageDataInput {
  guides: GuideMetadata[]
  websites: WebsiteMetadata[]
}

export function getFeaturedProjects(projects: WebsiteMetadata[]): WebsiteMetadata[] {
  const featuredProjects = projects.filter(project => project.featured === true)

  if (featuredProjects.length) {
    return featuredProjects.slice(0, 8)
  }

  return [...projects]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 8)
}

export function getRecentlyUpdatedProjects(
  projects: WebsiteMetadata[],
  limit = 5
): WebsiteMetadata[] {
  return [...projects]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, limit)
}

export function buildHomePageData({ guides, websites }: BuildHomePageDataInput): HomePageData {
  return {
    allProjects: websites,
    featuredGuides: guides,
    featuredProjects: getFeaturedProjects(websites),
    recentlyUpdatedProjects: getRecentlyUpdatedProjects(websites, 8),
    totalCount: websites.length
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

export const homePageMetadata: Metadata = generateBaseMetadata({
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

interface HomePageRouteProps {
  data: HomePageData
  slots: HomePageSlots
}

export function HomePageRoute({ data, slots }: HomePageRouteProps): ReactElement {
  const HOMEPAGE_SECTION_LIMIT = 200
  const { allProjects, featuredGuides, featuredProjects, recentlyUpdatedProjects, totalCount } =
    data
  const {
    CreatorProjectsSection,
    ExternalResourcesSection,
    FeaturedGuidesSection,
    FeaturedProjectsSection,
    JsonLd,
    RecentlyAddedSection,
    StaticWebsitesList
  } = slots

  const sortedProjects = [...allProjects].sort((a, b) => a.name.localeCompare(b.name))
  const homepageProjects = sortedProjects
    .slice(0, HOMEPAGE_SECTION_LIMIT)
    .map(toWebsiteBrowseCardMetadata)
  const featuredProjectCards = featuredProjects.map(toWebsiteBrowseCardMetadata)
  const recentlyUpdatedProjectCards = recentlyUpdatedProjects.map(toWebsiteBrowseCardMetadata)
  const homepageFeaturedGuides = featuredGuides.slice(0, HOMEPAGE_SECTION_LIMIT)
  const activeCategories = getActiveCategories(allProjects)
  const activeCategorySlugs = activeCategories.map(category => category.slug)

  return (
    <>
      <JsonLd data={generateWebsiteSchema()} />
      <div className="w-full space-y-16">
        <HeroSection websiteCount={totalCount} />
      </div>
      <div className="border-t">
        <div className="relative flex h-full w-full max-w-full flex-row flex-nowrap">
          <AppSidebar
            availableCategorySlugs={activeCategorySlugs}
            featuredCount={getFeaturedListingCount(featuredProjects)}
          />

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
                displayLimit={HOMEPAGE_SECTION_LIMIT}
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
