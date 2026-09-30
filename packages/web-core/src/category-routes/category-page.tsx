import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import type { Category } from '../categories'
import { getCategoryDisplayName } from '../category-display'
import {
  type CategoryLike,
  getFeaturedListingCount,
  listingMatchesCategory
} from '../category-navigation'
import { getCategorySEO } from '../category-seo'
import {
  type GuideMetadata,
  toWebsiteBrowseCardMetadata,
  type WebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../content-query'
import { AppSidebar } from '../layout/app-sidebar'
import { getRoute } from '../routes'
import { NewsletterSection } from '../sections/newsletter-section'
import {
  generateDynamicMetadata,
  optimizeMetaDescription,
  SITE_LOGO_URL,
  SITE_NAME,
  SITE_PUBLIC_URL
} from '../seo-config'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'
import { resolveCollectionPageSchemaDates } from './schema-dates'

type JsonLdProps = {
  data: Record<string, unknown>
}

type CategoryWebsitesListProps = {
  initialWebsites: WebsiteBrowseCardMetadata[]
}

type FeaturedGuidesSectionProps = {
  guides: GuideMetadata[]
}

type CategoryRouteSlots = {
  CategoryWebsitesList: ComponentType<CategoryWebsitesListProps>
  ExternalResourcesSection: ComponentType
  FeaturedGuidesSection: ComponentType<FeaturedGuidesSectionProps>
  JsonLd: (props: JsonLdProps) => ReactNode | Promise<ReactNode>
  breadcrumb: ReactNode
}

export function generateCategoryRouteStaticParams(categories: Category[]) {
  return categories.map(category => ({
    category: category.slug
  }))
}

export async function generateCategoryRouteMetadata({
  allProjects,
  category
}: {
  allProjects: Array<WebsiteMetadata & CategoryLike>
  category: Category
}): Promise<Metadata> {
  const seoContent = getCategorySEO(category.slug, category)
  const categoryProjectsCount =
    category.slug === 'featured'
      ? allProjects.filter(project => project.featured === true).length
      : allProjects.filter(project => listingMatchesCategory(project, category.slug)).length

  const title =
    categoryProjectsCount > 0
      ? `${categoryProjectsCount}+ ${seoContent.metaTitle}`
      : seoContent.metaTitle

  const description =
    categoryProjectsCount > 0
      ? `${categoryProjectsCount}+ ${siteCopy.listingName.plural}. ${seoContent.metaDescription}`
      : seoContent.metaDescription

  return generateDynamicMetadata({
    type: 'category',
    name: title,
    description: optimizeMetaDescription(description),
    slug: category.slug,
    additionalKeywords: seoContent.keywords
  })
}

export function CategoryRoutePage({
  activeCategorySlugs,
  allProjects,
  category,
  featuredGuides,
  featuredProjects,
  slots
}: {
  activeCategorySlugs: string[]
  allProjects: Array<WebsiteMetadata & CategoryLike>
  category: Category
  featuredGuides: GuideMetadata[]
  featuredProjects: WebsiteMetadata[]
  slots: CategoryRouteSlots
}) {
  const {
    CategoryWebsitesList,
    ExternalResourcesSection,
    FeaturedGuidesSection,
    JsonLd,
    breadcrumb
  } = slots

  const seoContent = getCategorySEO(category.slug, category)
  const categoryDisplayName = getCategoryDisplayName(category.slug)
  const categoryPath = getRoute('category.page', { category: category.slug })
  const categoryUrl = `${SITE_PUBLIC_URL}${categoryPath}`

  const categoryProjects =
    category.slug === 'featured'
      ? allProjects
          .filter(project => project.featured === true)
          .sort((a, b) => a.name.localeCompare(b.name))
      : allProjects
          .filter(project => listingMatchesCategory(project, category.slug))
          .sort((a, b) => a.name.localeCompare(b.name))
  const listedCategoryProjects =
    category.slug === 'other' && categoryProjects.length > 200
      ? categoryProjects.slice(0, 200)
      : categoryProjects
  const listedCategoryProjectCards = listedCategoryProjects.map(toWebsiteBrowseCardMetadata)
  const schemaDates = resolveCollectionPageSchemaDates(categoryProjects)

  return {
    categoryProjects,
    element: (
      <>
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            '@id': categoryUrl,
            name: `${categoryDisplayName} - ${SITE_NAME}`,
            headline: `${categoryProjects.length}+ ${categoryDisplayName} ${siteCopy.listingName.pluralTitle}`,
            description: `Explore ${
              categoryProjects.length
            }+ curated ${categoryDisplayName.toLowerCase()} ${
              siteCopy.listingName.plural
            } from ${SITE_NAME}. ${category.description}`,
            url: categoryUrl,
            inLanguage: 'en-US',
            isPartOf: {
              '@type': 'WebSite',
              '@id': SITE_PUBLIC_URL,
              name: SITE_NAME,
              description: siteConfig.description,
              url: SITE_PUBLIC_URL
            },
            breadcrumb: {
              '@type': 'BreadcrumbList',
              itemListElement: [
                {
                  '@type': 'ListItem',
                  position: 1,
                  name: 'Home',
                  item: SITE_PUBLIC_URL
                },
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: categoryDisplayName,
                  item: categoryUrl
                }
              ]
            },
            numberOfItems: categoryProjects.length,
            itemListElement: categoryProjects.slice(0, 10).map((project, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              url: project.website,
              name: project.name,
              description: project.description
            })),
            mainEntity: {
              '@type': 'ItemList',
              name: `${categoryDisplayName} ${siteCopy.listingName.pluralTitle}`,
              description: category.description,
              numberOfItems: categoryProjects.length,
              itemListOrder: 'https://schema.org/ItemListOrderAscending',
              itemListElement: categoryProjects.slice(0, 20).map((project, index) => ({
                '@type': 'Thing',
                position: index + 1,
                url: project.website,
                name: project.name
              }))
            },
            publisher: {
              '@type': 'Organization',
              name: SITE_NAME,
              url: SITE_PUBLIC_URL,
              logo: {
                '@type': 'ImageObject',
                url: SITE_LOGO_URL
              }
            },
            ...schemaDates
          }}
        />
        {seoContent.faqQuestions && seoContent.faqQuestions.length > 0 && (
          <JsonLd
            data={{
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: seoContent.faqQuestions.map(faq => ({
                '@type': 'Question',
                name: faq.question,
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: faq.answer
                }
              }))
            }}
          />
        )}
        <div className="border-t">
          <div className="relative flex h-full w-full max-w-full flex-row flex-nowrap">
            <AppSidebar
              availableCategorySlugs={activeCategorySlugs}
              currentCategory={category.slug}
              featuredCount={getFeaturedListingCount(featuredProjects)}
            />

            <div className="relative flex h-full w-full flex-col gap-3 px-6 pt-6">
              {breadcrumb}

              <section className="space-y-6">
                <div className="sticky top-16 z-35 bg-background border-b py-4 -mx-6 px-6">
                  <div className="flex items-center gap-3">
                    <category.icon className="h-6 w-6" />
                    <h1 className="text-2xl font-bold">{seoContent.h1Title}</h1>
                  </div>
                  <p className="text-muted-foreground mt-1">{seoContent.introText}</p>
                </div>
                <CategoryWebsitesList initialWebsites={listedCategoryProjectCards} />
              </section>

              {siteConfig.features.showExternalResources && <ExternalResourcesSection />}
              {siteConfig.features.showFeaturedGuides && (
                <FeaturedGuidesSection guides={featuredGuides} />
              )}
              {siteConfig.features.showNewsletter && <NewsletterSection />}
            </div>
          </div>
        </div>
      </>
    )
  }
}
