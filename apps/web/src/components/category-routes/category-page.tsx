import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import type { Category } from '../../lib/directory/categories'
import { getCategorySEO } from '../../lib/directory/category-seo'
import {
  toWebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import {
  composeMetaDescription,
  generateDynamicMetadata,
  SITE_NAME,
  siteLogoUrl,
  siteOrigin,
  siteWebsiteId
} from '../../lib/seo/seo-config'
import { siteConfig } from '../../lib/site/site-config'
import { formatListingCount, siteCopy } from '../../lib/site/site-copy'
import { CategoryWebsitesList } from '../directory/category-websites-list'
import { PageHero } from '../layout/page-hero'
import { PageContainer, PageSection } from '../layout/page-shell'
import { type BreadcrumbItemData, SiteBreadcrumb } from '../layout/site-breadcrumb'
import { JsonLd } from '../seo/json-ld'
import { resolveCollectionPageSchemaDates } from './schema-dates'

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
  count,
  kind = 'category',
  noindex
}: {
  category: Pick<Category, 'description' | 'name' | 'slug'>
  count: number
  /** A tag page (#341) writes its own canonical URL; its title and description read the same. */
  kind?: 'category' | 'tag'
  /** `noindex, follow` (`isCategoryIndexable`, `isTagIndexable`). */
  noindex?: boolean
}): Promise<Metadata> {
  const seoContent = getCategorySEO(category.slug, category)

  const title = count > 0 ? `${count}+ ${seoContent.metaTitle}` : seoContent.metaTitle

  const description =
    count > 0
      ? `${count}+ ${siteCopy.listingName.plural}. ${seoContent.metaDescription}`
      : seoContent.metaDescription

  return generateDynamicMetadata({
    type: kind,
    name: title,
    description: composeMetaDescription(description, [
      [
        `Each ${siteCopy.listingName.singular} has its own ${SITE_NAME} listing with links and details.`,
        `Each ${siteCopy.listingName.singular} has its own ${SITE_NAME} listing.`
      ]
    ]),
    slug: category.slug,
    additionalKeywords: seoContent.keywords,
    noindex
  })
}

/**
 * A category page (#268): the breadcrumb and a `PageHero` with the category's name, description
 * and size, then its listings in the shared card grid and the page links.
 */
export function CategoryRoutePage({
  beforeListings,
  category,
  chips,
  collection,
  pageProjects,
  pagination
}: {
  /** A hub's "Best {hub} lists", between its hero and its listings (#347). */
  beforeListings?: ReactNode
  category: Category
  /** A hub's tag chips under its hero (#347). */
  chips?: ReactNode
  collection: CategoryCollection
  /** The listings on the requested page, in directory (name) order. */
  pageProjects: WebsiteMetadata[]
  pagination?: ReactNode
}) {
  const seoContent = getCategorySEO(category.slug, category)
  const categoryPath = getRoute('category.page', { category: category.slug })
  return CollectionRoutePage({
    beforeListings,
    breadcrumb: [
      { name: 'Categories', href: getRoute('category.index') },
      { name: category.name, href: categoryPath }
    ],
    chips,
    collection,
    description: category.description,
    faqQuestions: seoContent.faqQuestions,
    intro: seoContent.introText,
    name: seoContent.h1Title,
    pageProjects,
    pagination,
    path: categoryPath
  })
}

/**
 * A page of one collection of listings, a category or a tag (#341): the breadcrumb and a
 * `PageHero` with its name, description and size, then its listings in the shared card grid and
 * the page links. Its JSON-LD is a `CollectionPage` whose `ItemList` is the collection's first
 * listings, the same on every page.
 */
export function CollectionRoutePage({
  analyticsSource,
  beforeListings,
  breadcrumb,
  chips,
  collection,
  description,
  faqQuestions,
  intro,
  listSummary,
  name,
  pageProjects,
  pagination,
  path
}: {
  /** The listing cards' `data-source` (`category` when unset). */
  analyticsSource?: string
  /** A band between the hero and the listings (a hub's best pages). */
  beforeListings?: ReactNode
  /** The trail below Home, ending with this page. */
  breadcrumb: BreadcrumbItemData[]
  /** Links under the hero (a tag page's best pages, a hub's tags). */
  chips?: ReactNode
  collection: CategoryCollection
  /** The collection's description, for its JSON-LD. */
  description: string
  faqQuestions?: Array<{ answer: string; question: string }>
  /** The hero's text. */
  intro: string
  /** The listing toolbar's summary, in place of the category's. */
  listSummary?: ReactNode
  /** The collection's display name: the `h1`. */
  name: string
  /** The listings on the requested page, in directory (name) order. */
  pageProjects: WebsiteMetadata[]
  pagination?: ReactNode
  /** The page's canonical path. */
  path: string
}) {
  const origin = siteOrigin()
  const pageUrl = `${origin}${path}`

  const count = collection.count
  const leadingProjects = collection.leadingProjects
  const listedProjectCards = pageProjects.map(toWebsiteBrowseCardMetadata)
  const publicationDates = resolveCollectionPageSchemaDates(
    [collection.firstPublishedAt, collection.lastPublishedAt]
      .filter((publishedAt): publishedAt is string => Boolean(publishedAt))
      .map(publishedAt => ({ publishedAt }))
  )
  // The same value as the collection's sitemap `lastmod` (#218).
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
            '@id': pageUrl,
            name: `${name} - ${SITE_NAME}`,
            headline: `${count}+ ${name} ${siteCopy.listingName.pluralTitle}`,
            description: `Explore ${count}+ curated ${name.toLowerCase()} ${
              siteCopy.listingName.plural
            } from ${SITE_NAME}. ${description}`,
            url: pageUrl,
            inLanguage: 'en-US',
            isPartOf: {
              '@type': 'WebSite',
              '@id': siteWebsiteId(),
              name: SITE_NAME,
              description: siteConfig.description,
              url: origin
            },
            breadcrumb: {
              '@type': 'BreadcrumbList',
              itemListElement: [
                {
                  '@type': 'ListItem',
                  position: 1,
                  name: 'Home',
                  item: origin
                },
                ...breadcrumb.map((item, index) => ({
                  '@type': 'ListItem',
                  position: index + 2,
                  // The page's own crumb is its display name, as the hero shows it.
                  name: index === breadcrumb.length - 1 ? name : item.name,
                  item: `${origin}${item.href}`
                }))
              ]
            },
            // CollectionPage takes no list properties; the listings are its ItemList (#151).
            mainEntity: {
              '@type': 'ItemList',
              name: `${name} ${siteCopy.listingName.pluralTitle}`,
              description,
              numberOfItems: count,
              itemListOrder: 'https://schema.org/ItemListOrderAscending',
              itemListElement: leadingProjects.slice(0, 20).map((project, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                url: `${origin}${getRoute('listing.detail', { slug: project.slug })}`,
                name: project.name
              }))
            },
            publisher: {
              '@type': 'Organization',
              name: SITE_NAME,
              url: origin,
              logo: {
                '@type': 'ImageObject',
                url: siteLogoUrl()
              }
            },
            ...schemaDates
          }}
        />
        {faqQuestions && faqQuestions.length > 0 && (
          <JsonLd
            data={{
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqQuestions.map(faq => ({
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
          <SiteBreadcrumb items={breadcrumb} baseUrl={origin} />
          <PageHero
            chips={chips}
            eyebrow={formatListingCount(count)}
            title={name}
            description={intro}
          />
        </PageSection>
        {beforeListings}
        <PageContainer className="flex flex-col gap-8 py-12">
          <CategoryWebsitesList
            analyticsSource={analyticsSource}
            initialWebsites={listedProjectCards}
            summary={listSummary}
          />
          {pagination}
        </PageContainer>
      </>
    )
  }
}
