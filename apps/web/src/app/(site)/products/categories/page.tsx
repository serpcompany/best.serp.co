import type { Metadata } from 'next'
import { CategoryCards } from '@/components/category-routes/category-cards'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { getActiveCategories } from '@/lib/catalog/repository'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata, SITE_NAME, siteOrigin } from '@/lib/seo/seo-config'
import { siteCopy } from '@/lib/site/site-copy'

const categoriesPath = getRoute('category.index')

// The root layout's title template adds ` | SERP`.
export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: `${siteCopy.listingName.pluralTitle} by Category`,
    description: `Browse every ${SITE_NAME} ${siteCopy.listingName.singular} category to find curated software, AI tools, companies, and resources listed in each one.`,
    path: categoriesPath
  })
}

/** The categories index (#268): a `PageHero`, then each category as a `ListCard` in the grid. */
export default async function CategoriesPage() {
  const categories = (await getActiveCategories())
    .filter(category => category.count > 0)
    .sort((left, right) => left.name.localeCompare(right.name))

  return (
    <>
      <PageSection spacing="hero" className="border-b">
        <SiteBreadcrumb
          items={[{ name: 'Categories', href: categoriesPath }]}
          baseUrl={siteOrigin()}
        />
        <PageHero
          title="Categories"
          description={`${categories.length} categories of ${siteCopy.listingName.plural} on ${SITE_NAME}.`}
        />
      </PageSection>
      <PageSection spacing="spacious">
        <CategoryCards categories={categories} />
      </PageSection>
    </>
  )
}
