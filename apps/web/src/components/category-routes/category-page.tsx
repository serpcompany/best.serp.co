import type { Metadata } from 'next'
import type { ComponentType, ReactNode } from 'react'
import type { Category } from '../../lib/directory/categories'
import { getCategorySEO } from '../../lib/directory/category-seo'
import {
  toWebsiteBrowseCardMetadata,
  type WebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import {
  composeMetaDescription,
  generateDynamicMetadata,
  SITE_LOGO_URL,
  SITE_NAME,
  SITE_PUBLIC_URL,
  SITE_WEBSITE_ID
} from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { formatListingCount, siteCopy } from '../../lib/site/site-copy'
import { PageHero } from '../layout/page-hero'
import { PageContainer, PageSection } from '../layout/page-shell'
import { resolveCollectionPageSchemaDates } from './schema-dates'

type JsonLdProps = {
  data: Record<string, unknown>
}

type CategoryWebsitesListProps = {
  initialWebsites: WebsiteBrowseCardMetadata[]
}

type CategoryRouteSlots = {
  CategoryWebsitesList: ComponentType<CategoryWebsitesListProps>
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
  /** The newest change among its listings (#218): the CollectionPage's `dateModified`. */
  lastModifiedAt?: string | null
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

/**
 * A category page (#268): the breadcrumb and a `PageHero` with the category's name, description
 * and size, then its listings in the shared card grid and the page links.
 */
export function CategoryRoutePage({
  category,
  collection,
  pageProjects,
  pagination,
  slots
}: {
  category: Category
  collection: CategoryCollection
  /** The listings on the requested page, in directory (name) order. */
  pageProjects: WebsiteMetadata[]
  pagination?: ReactNode
  slots: CategoryRouteSlots
}) {
  const { CategoryWebsitesList, JsonLd, breadcrumb } = slots

  const seoContent = getCategorySEO(category.slug, category)
  const categoryDisplayName = seoContent.h1Title
  const categoryPath = getRoute('category.page', { category: category.slug })
  const categoryUrl = `${SITE_PUBLIC_URL}${categoryPath}`

  const categoryCount = collection.count
  const leadingProjects = collection.leadingProjects
  const listedCategoryProjectCards = pageProjects.map(toWebsiteBrowseCardMetadata)
  const publicationDates = resolveCollectionPageSchemaDates(
    [collection.firstPublishedAt, collection.lastPublishedAt]
      .filter((publishedAt): publishedAt is string => Boolean(publishedAt))
      .map(publishedAt => ({ publishedAt }))
  )
  // The same value as the categories sitemap's `lastmod` (#218).
  const schemaDates = collection.lastModifiedAt
    ? { ...publicationDates, dateModified: collection.lastModifiedAt }
    : publicationDates

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
        <PageSection spacing="hero" className="border-b">
          {breadcrumb}
          <PageHero
            eyebrow={formatListingCount(categoryCount)}
            title={seoContent.h1Title}
            description={seoContent.introText}
          />
        </PageSection>
        <PageContainer className="flex flex-col gap-8 py-12">
          <CategoryWebsitesList initialWebsites={listedCategoryProjectCards} />
          {pagination}
        </PageContainer>
      </>
    )
  }
}
