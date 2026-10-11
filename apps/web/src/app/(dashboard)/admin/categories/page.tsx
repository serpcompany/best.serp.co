import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { CategoryForm } from '@/components/admin/taxonomy-forms'
import { TaxonomyTable } from '@/components/admin/taxonomy-table'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { getAdminReads } from '@/lib/admin/runtime'
import { countLabel, prefill } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'

/** Categories, the hubs (#405): the active ones, and the form that adds one. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Categories' }

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CategoriesPage({ searchParams }: Props) {
  await requireAdmin()
  const [categories, params] = await Promise.all([
    (await getAdminReads()).listAdminCategories(new Date().toISOString()),
    searchParams
  ])
  const initial = prefill(params, ['description', 'name', 'slug'])
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Categories' }]} />

      <DashboardPageHeader
        title="Categories"
        description={countLabel(categories.length, 'category', 'categories')}
      />
      <TaxonomyTable
        columns={['Slug', 'Order', 'Tags', 'Live listings']}
        rows={categories.map(category => ({
          cells: [
            <span key="slug" className="font-mono">
              {category.slug}
            </span>,
            category.order,
            category.tagCount,
            category.listingCount
          ],
          href: `/admin/categories/${encodeURIComponent(category.slug)}/`,
          key: category.slug,
          name: category.name
        }))}
      />
      <CategoryForm key={JSON.stringify(initial)} mode="create" initial={initial} />
    </>
  )
}
