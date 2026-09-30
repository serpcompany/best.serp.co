import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { getRoute } from '@serpdirectory/web-core/routes'
import { SITE_NAME, SITE_PUBLIC_URL } from '@serpdirectory/web-core/seo-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import type { Metadata } from 'next'
import Link from 'next/link'
import { getActiveCategories } from '@/lib/catalog/repository'

const categoriesPath = getRoute('category.index')

export const metadata: Metadata = {
  title: `${siteCopy.listingName.pluralTitle} by Category | ${SITE_NAME}`,
  description: `Browse every ${SITE_NAME} ${siteCopy.listingName.singular} category.`,
  alternates: {
    canonical: `${SITE_PUBLIC_URL}${categoriesPath}`
  }
}

export default async function CategoriesPage() {
  const categories = (await getActiveCategories())
    .filter(category => category.count > 0)
    .sort((left, right) => left.name.localeCompare(right.name))

  return (
    <main className="container mx-auto max-w-6xl px-6 py-12">
      <Breadcrumb
        items={[{ name: 'Categories', href: categoriesPath }]}
        baseUrl={SITE_PUBLIC_URL}
      />
      <div className="mt-6 space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">Categories</h1>
        <p className="text-lg text-muted-foreground">
          {categories.length} categories of {siteCopy.listingName.plural} on {SITE_NAME}.
        </p>
      </div>
      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map(category => (
          <li key={category.slug}>
            <Link
              className="flex h-full items-start justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
              href={getRoute('category.page', { category: category.slug })}
            >
              <span className="font-medium">{category.name}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {category.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
