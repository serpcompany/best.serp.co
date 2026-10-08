import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import type { Category } from '../categories'
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
  composeMetaDescription,
  generateDynamicMetadata,
  SITE_LOGO_URL,
  SITE_NAME,
  SITE_PUBLIC_URL,
  SITE_WEBSITE_ID
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

/**
 * The whole category, independent of the page being shown: its size, publication span,
 * and first listings in directory order (structured data describes the collection, so
 * every page of a category emits the same JSON-LD as page 1).
 */
export interface CategoryCollection {
  count: number
  firstPublishedAt: string | null
  lastPublishedAt: string | null
  /** At least the first 20 listings of the category in directory (name) order. */
  leadingProjects: WebsiteMetadata[]
}

export async function generateCategoryRouteMetadata({
  category,
  count
}: {
  category: Category
  count: number
}): Promise<Metadata> {
  const seoContent = getCategorySEO(category.slug, category)

  const title = count > 0 ? `${count}+ ${seoContent.metaTitle}` : seoContent.metaTitle

  const description =
    count > 0
      ? `${count}+ ${siteCopy.listingName.plural}. ${seoContent.metaDescription}`
      : seoContent.metaDescription

  return generateDynamicMetadata({
    type: 'category',
    name: title,
    description: composeMetaDescription(description, [
      [
        `Each ${siteCopy.listingName.singular} has its own ${SITE_NAME} listing with links and details.`,
        `Each ${siteCopy.listingName.singular} has its own ${SITE_NAME} listing.`
      ]
    ]),
    slug: category.slug,
    additionalKeywords: seoContent.keywords
  })
}

export function CategoryRoutePage({
  activeCategorySlugs,
  category,
  collection,
  featuredGuides,
  pageProjects,
  pagination,
  slots
}: {
  activeCategorySlugs: string[]
  category: Category
  collection: CategoryCollection
  featuredGuides: GuideMetadata[]
  /** The listings on the requested page, in directory (name) order. */
  pageProjects: WebsiteMetadata[]
  pagination?: ReactNode
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
  const categoryDisplayName = seoContent.h1Title
  const categoryPath = getRoute('category.page', { category: category.slug })
  const categoryUrl = `${SITE_PUBLIC_URL}${categoryPath}`

  const categoryCount = collection.count
  const leadingProjects = collection.leadingProjects
  const listedCategoryProjectCards = pageProjects.map(toWebsiteBrowseCardMetadata)
  const schemaDates = resolveCollectionPageSchemaDates(
    [collection.firstPublishedAt, collection.lastPublishedAt]
      .filter((publishedAt): publishedAt is string => Boolean(publishedAt))
      .map(publishedAt => ({ publishedAt }))
  )

  return {
    element: (
      <>
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            '@id': categoryUrl,
            name: `${categoryDisplayName} - ${SITE_NAME}`,
            headline: `${categoryCount}+ ${categoryDisplayName} ${siteCopy.listingName.pluralTitle}`,
            description: `Explore ${categoryCount}+ curated ${categoryDisplayName.toLowerCase()} ${
              siteCopy.listingName.plural
            } from ${SITE_NAME}. ${category.description}`,
            url: categoryUrl,
            inLanguage: 'en-US',
            isPartOf: {
              '@type': 'WebSite',
              '@id': SITE_WEBSITE_ID,
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
                  name: 'Categories',
                  item: `${SITE_PUBLIC_URL}${getRoute('category.index')}`
                },
                {
                  '@type': 'ListItem',
                  position: 3,
                  name: categoryDisplayName,
                  item: categoryUrl
                }
              ]
            },
            // CollectionPage takes no list properties; the listings are its ItemList (#151).
            mainEntity: {
              '@type': 'ItemList',
              name: `${categoryDisplayName} ${siteCopy.listingName.pluralTitle}`,
              description: category.description,
              numberOfItems: categoryCount,
              itemListOrder: 'https://schema.org/ItemListOrderAscending',
              itemListElement: leadingProjects.slice(0, 20).map((project, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                url: `${SITE_PUBLIC_URL}${getRoute('listing.detail', { slug: project.slug })}`,
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
                {pagination}
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
