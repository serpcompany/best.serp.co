import { ChevronRight } from 'lucide-react'
import type { Metadata } from 'next'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { Badge } from '@/components/ui/badge'
import { getActiveCategories } from '@/lib/catalog/repository'
import { getCategoryIcon } from '@/lib/directory/categories'
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
        <CardGrid as="ul">
          {categories.map(category => {
            const Icon = getCategoryIcon(category.slug)
            return (
              <li key={category.slug}>
                <ListCard
                  className="h-full"
                  href={getRoute('category.page', { category: category.slug })}
                  icon={<Icon />}
                  meta={
                    <>
                      <Badge variant="secondary">{category.count}</Badge>
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </>
                  }
                  title={category.name}
                />
              </li>
            )
          })}
        </CardGrid>
      </PageSection>
    </>
  )
}
