import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { TagForm } from '@/components/admin/taxonomy-forms'
import { TaxonomyTable } from '@/components/admin/taxonomy-table'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { getAdminReads } from '@/lib/admin/runtime'
import { countLabel, prefill } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'

/** Tags (#405): the active ones with their categories, and the form that adds one. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Tags' }

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function TagsPage({ searchParams }: Props) {
  await requireAdmin()
  const reads = await getAdminReads()
  const [tags, categories, params] = await Promise.all([
    reads.listAdminTags(),
    reads.listActiveCategories(),
    searchParams
  ])
  const initial = prefill(params, ['category', 'description', 'name', 'slug'])
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Tags' }]} />

      <DashboardPageHeader title="Tags" description={countLabel(tags.length, 'tag', 'tags')} />
      <TaxonomyTable
        columns={['Slug', 'Category', 'Live listings']}
        rows={tags.map(tag => ({
          cells: [
            <span key="slug" className="font-mono">
              {tag.slug}
            </span>,
            tag.categoryName,
            tag.listingCount
          ],
          href: `/admin/tags/${encodeURIComponent(tag.slug)}/`,
          key: tag.slug,
          name: tag.name
        }))}
      />
      <TagForm
        key={JSON.stringify(initial)}
        categories={categories}
        mode="create"
        initial={initial}
      />
    </>
  )
}
