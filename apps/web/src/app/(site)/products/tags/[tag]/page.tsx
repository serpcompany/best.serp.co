import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CollectionRoutePage,
  generateCategoryRouteMetadata
} from '@/components/category-routes/category-page'
import {
  ListingPagination,
  paginatedMetadata,
  parseListingPageParam
} from '@/components/directory/listing-pagination'
import { Badge } from '@/components/ui/badge'
import {
  getActiveCategories,
  getBestPages,
  getListingNamePage,
  getTagBySlug,
  type PublishedTag
} from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { type PageSearchParams, redirectMovedTaxonomyPage } from '@/lib/routing/taxonomy-redirect'
import { bestPageEntryCount, isTagIndexable } from '@/lib/seo/taxonomy-indexing'
import { formatListingCount } from '@/lib/site/site-copy'

interface TagPageProps {
  params: Promise<{ tag: string }>
  searchParams: Promise<PageSearchParams>
}

/** The active tag at `slug` when it has a public listing; an empty tag is a 404 (design 2.3). */
async function publicTag(slug: string): Promise<PublishedTag | null> {
  const tag = await getTagBySlug(slug)
  return tag && tag.count > 0 ? tag : null
}

export async function generateMetadata({ params, searchParams }: TagPageProps): Promise<Metadata> {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const tag = await publicTag(resolvedParams.tag)
  if (!tag) return { title: 'Tag Not Found', description: 'The requested tag could not be found.' }

  const metadata = await generateCategoryRouteMetadata({
    category: tag,
    count: tag.count,
    kind: 'tag',
    noindex: !isTagIndexable(tag, await getBestPages())
  })
  return paginatedMetadata(metadata, {
    basePath: getRoute('tag.page', { tag: tag.slug }),
    page: parseListingPageParam(resolvedSearchParams.page)
  })
}

/**
 * A tag page (#341, design 2.1 and 5.3): its hub in the breadcrumb, links to the best pages that
 * rank it, then its listings, 48 a page. An empty tag answers one 308 to where
 * `taxonomy_redirects` moved its URL, else 404.
 */
export default async function TagPage({ params, searchParams }: TagPageProps) {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const tag = await publicTag(resolvedParams.tag)
  if (!tag) {
    await redirectMovedTaxonomyPage('tag', resolvedParams.tag, resolvedSearchParams)
    notFound()
  }

  const page = parseListingPageParam(resolvedSearchParams.page)
  const [listingPage, firstPage, categories, bestPages] = await Promise.all([
    getListingNamePage({ page, tag: tag.slug }),
    // Structured data describes the whole tag, so every page repeats page 1's list.
    getListingNamePage({ page: 1, tag: tag.slug }),
    getActiveCategories(),
    getBestPages()
  ])
  if (page > listingPage.pageCount) notFound()

  const tagPath = getRoute('tag.page', { tag: tag.slug })
  // The hub is a link only while its page renders (it has a public listing).
  const hub = categories.find(category => category.slug === tag.category && category.count > 0)
  const rankedBy = bestPages.filter(
    bestPage => bestPage.tag === tag.slug && bestPageEntryCount(bestPage) > 0
  )

  const route = CollectionRoutePage({
    analyticsSource: 'tag',
    breadcrumb: [
      { href: getRoute('category.index'), name: 'Categories' },
      ...(hub ? [{ href: getRoute('category.page', { category: hub.slug }), name: hub.name }] : []),
      { href: tagPath, name: tag.name }
    ],
    chips: rankedBy.length
      ? rankedBy.map(bestPage => (
          <Badge
            key={bestPage.slug}
            variant="outline"
            render={<Link href={getRoute('best.page', { keyword: bestPage.slug })} />}
          >
            {bestPage.heading}
          </Badge>
        ))
      : undefined,
    collection: {
      count: listingPage.total,
      firstPublishedAt: listingPage.firstPublishedAt,
      lastModifiedAt: listingPage.lastModifiedAt,
      lastPublishedAt: listingPage.lastPublishedAt,
      leadingProjects: firstPage.items
    },
    description: tag.description,
    intro: tag.description,
    listSummary: (
      <p className="text-sm text-muted-foreground">
        Showing {formatListingCount(listingPage.items.length)}
      </p>
    ),
    name: tag.name,
    pageProjects: listingPage.items,
    pagination: (
      <ListingPagination
        basePath={tagPath}
        label={`${tag.name} pages`}
        page={listingPage.page}
        pageCount={listingPage.pageCount}
      />
    ),
    path: tagPath
  })

  return route.element
}
