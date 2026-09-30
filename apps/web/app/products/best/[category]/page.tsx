import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { getCategoryIcon } from '@serpdirectory/web-core/categories'
import { getCategoryDisplayName } from '@serpdirectory/web-core/category-display'
import {
  CategoryRoutePage,
  generateCategoryRouteMetadata
} from '@serpdirectory/web-core/category-routes/category-page'
import { CategoryWebsitesListRoute as CategoryWebsitesList } from '@serpdirectory/web-core/category-websites-list-route'
import { JsonLd } from '@serpdirectory/web-core/json-ld'
import { getRoute } from '@serpdirectory/web-core/routes'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@serpdirectory/web-core/sections/external-resources-section-route'
import { FeaturedGuidesSectionRoute as FeaturedGuidesSection } from '@serpdirectory/web-core/sections/featured-guides-section-route'
import { SITE_PUBLIC_URL } from '@serpdirectory/web-core/seo-config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  getActiveCategories,
  getCategoryBySlug,
  getFeaturedListings,
  getListingsByCategory
} from '@/lib/catalog/repository'
import { getGuides } from '@/lib/content-loader'

interface CategoryPageProps {
  params: Promise<{ category: string }>
}

/**
 * Generates static params for all category pages
 */
/**
 * Generates metadata for category pages with SEO-optimized descriptions
 */
export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const resolvedParams = await params
  const storedCategory = await getCategoryBySlug(resolvedParams.category)

  if (!storedCategory) {
    return {
      title: 'Category Not Found',
      description: 'The requested category could not be found.'
    }
  }

  const allProjects = await getListingsByCategory(storedCategory.slug)
  const category = {
    ...storedCategory,
    icon: getCategoryIcon(storedCategory.slug),
    priority: 'low' as const
  }
  return generateCategoryRouteMetadata({ allProjects, category })
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const resolvedParams = await params
  const storedCategory = await getCategoryBySlug(resolvedParams.category)

  if (!storedCategory) {
    notFound()
  }

  const [allProjects, featuredProjects, featuredGuides, activeCategories] = await Promise.all([
    getListingsByCategory(storedCategory.slug),
    getFeaturedListings(100),
    getGuides(),
    getActiveCategories()
  ])
  const category = {
    ...storedCategory,
    icon: getCategoryIcon(storedCategory.slug),
    priority: 'low' as const
  }
  const categoryPath = getRoute('category.page', { category: category.slug })
  const activeCategorySlugs = activeCategories.map(activeCategory => activeCategory.slug)
  const route = CategoryRoutePage({
    activeCategorySlugs,
    allProjects,
    category,
    featuredGuides,
    featuredProjects,
    slots: {
      CategoryWebsitesList,
      ExternalResourcesSection,
      FeaturedGuidesSection,
      JsonLd,
      breadcrumb: (
        <Breadcrumb
          items={[{ name: getCategoryDisplayName(category.slug), href: categoryPath }]}
          baseUrl={SITE_PUBLIC_URL}
        />
      )
    }
  })

  if (route.categoryProjects.length === 0) {
    notFound()
  }

  return route.element
}
