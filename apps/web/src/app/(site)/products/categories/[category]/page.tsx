import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CategoryRoutePage,
  generateCategoryRouteMetadata
} from '@/components/category-routes/category-page'
import {
  ListingPagination,
  paginatedMetadata,
  parseListingPageParam
} from '@/components/directory/listing-pagination'
import { BestPagesSection } from '@/components/taxonomy/best-page'
import { Badge } from '@/components/ui/badge'
import {
  getActiveCategories,
  getActiveTags,
  getBestPages,
  getListingNamePage,
  type PublishedCategory
} from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { type PageSearchParams, redirectMovedTaxonomyPage } from '@/lib/routing/taxonomy-redirect'
import { categoryBestPages, linkedTags, renderingCategory } from '@/lib/seo/taxonomy-indexing'

interface CategoryPageProps {
  params: Promise<{ category: string }>
  searchParams: Promise<PageSearchParams>
}

/** The category at `slug` when its page renders (`renderingCategory`, #341 design 2.2). */
async function publicCategory(slug: string): Promise<PublishedCategory | null> {
  return renderingCategory(await getActiveCategories(), slug)
}

/**
 * Generates metadata for category pages with SEO-optimized descriptions
 */
export async function generateMetadata({
  params,
  searchParams
}: CategoryPageProps): Promise<Metadata> {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const storedCategory = await publicCategory(resolvedParams.category)

  if (!storedCategory) {
    return {
      title: 'Category Not Found',
      description: 'The requested category could not be found.'
    }
  }

  const metadata = await generateCategoryRouteMetadata({
    category: storedCategory,
    count: storedCategory.count
  })
  return paginatedMetadata(metadata, {
    basePath: getRoute('category.page', { category: storedCategory.slug }),
    page: parseListingPageParam(resolvedSearchParams.page)
  })
}

/**
 * A category (a hub, #341) with a public listing renders: its tags with 3 or more listings as
 * chips (most listings first), its best pages under "Best {hub} lists", then its listings (design
 * 5.3, #347), all from the cached tag stats and best index. Without tags or best pages it renders
 * as before. Otherwise its URL answers one 308 to where `taxonomy_redirects` moved it (an old
 * narrow category's tag or best page), else 404.
 */
export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const category = await publicCategory(resolvedParams.category)

  if (!category) {
    await redirectMovedTaxonomyPage('category', resolvedParams.category, resolvedSearchParams)
    notFound()
  }

  const page = parseListingPageParam(resolvedSearchParams.page)
  const [listingPage, firstPage, tags, bestPages] = await Promise.all([
    getListingNamePage({ category: category.slug, page }),
    // Structured data describes the whole category, so every page repeats page 1's list.
    getListingNamePage({ category: category.slug, page: 1 }),
    getActiveTags(),
    getBestPages()
  ])
  if (page > listingPage.pageCount) {
    notFound()
  }

  const categoryPath = getRoute('category.page', { category: category.slug })
  const hubTags = linkedTags(tags.filter(tag => tag.category === category.slug)).sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name)
  )
  const hubBestPages = categoryBestPages(bestPages, category.slug)
  const route = CategoryRoutePage({
    beforeListings: hubBestPages.length ? (
      <BestPagesSection
        className="border-b"
        hub={category}
        id="hub-best-pages"
        pages={hubBestPages}
      />
    ) : undefined,
    category,
    chips: hubTags.length
      ? hubTags.map(tag => (
          <Badge
            key={tag.slug}
            variant="outline"
            render={<Link href={getRoute('tag.page', { tag: tag.slug })} />}
          >
            {tag.name}
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
    pageProjects: listingPage.items,
    pagination: (
      <ListingPagination
        basePath={categoryPath}
        label={`${category.name} pages`}
        page={listingPage.page}
        pageCount={listingPage.pageCount}
      />
    )
  })

  return route.element
}
