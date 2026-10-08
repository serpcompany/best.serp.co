import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  CategoryRoutePage,
  generateCategoryRouteMetadata
} from '@/components/category-routes/category-page'
import { CategoryWebsitesListRoute as CategoryWebsitesList } from '@/components/directory/category-websites-list-route'
import {
  ListingPagination,
  paginatedMetadata,
  parseListingPageParam
} from '@/components/directory/listing-pagination'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@/components/sections/external-resources-section-route'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@/components/sections/featured-guides-section-route'
import { JsonLd } from '@/components/seo/json-ld'
import {
  getActiveCategories,
  getCategoryBySlug,
  getListingNamePage,
  type PublishedCategory
} from '@/lib/catalog/repository'
import { getGuides } from '@/lib/content-loader'
import { getCategoryIcon } from '@/lib/directory/categories'
import { getRoute } from '@/lib/routing/routes'
import { SITE_PUBLIC_URL } from '@/lib/seo/seo-config'

interface CategoryPageProps {
  params: Promise<{ category: string }>
  searchParams: Promise<{ page?: string | string[] }>
}

function presentCategory(storedCategory: PublishedCategory) {
  return {
    ...storedCategory,
    icon: getCategoryIcon(storedCategory.slug),
    priority: 'low' as const
  }
}

/**
 * Generates metadata for category pages with SEO-optimized descriptions
 */
export async function generateMetadata({
  params,
  searchParams
}: CategoryPageProps): Promise<Metadata> {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const storedCategory = await getCategoryBySlug(resolvedParams.category)

  if (!storedCategory) {
    return {
      title: 'Category Not Found',
      description: 'The requested category could not be found.'
    }
  }

  const metadata = await generateCategoryRouteMetadata({
    category: presentCategory(storedCategory),
    count: storedCategory.count
  })
  return paginatedMetadata(metadata, {
    basePath: getRoute('category.page', { category: storedCategory.slug }),
    page: parseListingPageParam(resolvedSearchParams.page)
  })
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const [resolvedParams, resolvedSearchParams] = await Promise.all([params, searchParams])
  const storedCategory = await getCategoryBySlug(resolvedParams.category)

  if (!storedCategory || storedCategory.count === 0) {
    notFound()
  }

  const page = parseListingPageParam(resolvedSearchParams.page)
  const [listingPage, firstPage, featuredGuides, activeCategories] = await Promise.all([
    getListingNamePage({ category: storedCategory.slug, page }),
    // Structured data describes the whole category, so every page repeats page 1's list.
    getListingNamePage({ category: storedCategory.slug, page: 1 }),
    getGuides(),
    getActiveCategories()
  ])
  if (page > listingPage.pageCount) {
    notFound()
  }

  const category = presentCategory(storedCategory)
  const categoryPath = getRoute('category.page', { category: category.slug })
  const activeCategorySlugs = activeCategories.map(activeCategory => activeCategory.slug)
  const route = CategoryRoutePage({
    activeCategorySlugs,
    category,
    collection: {
      count: listingPage.total,
      firstPublishedAt: listingPage.firstPublishedAt,
      lastModifiedAt: listingPage.lastModifiedAt,
      lastPublishedAt: listingPage.lastPublishedAt,
      leadingProjects: firstPage.items
    },
    featuredGuides,
    pageProjects: listingPage.items,
    pagination: (
      <ListingPagination
        basePath={categoryPath}
        label={`${category.name} pages`}
        page={listingPage.page}
        pageCount={listingPage.pageCount}
      />
    ),
    slots: {
      CategoryWebsitesList,
      ExternalResourcesSection,
      FeaturedGuidesSection,
      JsonLd,
      breadcrumb: (
        <SiteBreadcrumb
          items={[
            { name: 'Categories', href: getRoute('category.index') },
            { name: category.name, href: categoryPath }
          ]}
          baseUrl={SITE_PUBLIC_URL}
        />
      )
    }
  })

  return route.element
}
