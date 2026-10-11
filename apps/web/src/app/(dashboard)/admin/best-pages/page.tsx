import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { BestPageForm } from '@/components/admin/taxonomy-forms'
import { TaxonomyTable } from '@/components/admin/taxonomy-table'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { getAdminReads } from '@/lib/admin/runtime'
import { countLabel, prefill } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'

/** Best pages, `/best/<keyword>/` (#405): the active ones, and the form that adds one. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Best pages' }

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function BestPagesPage({ searchParams }: Props) {
  await requireAdmin()
  const reads = await getAdminReads()
  const [pages, tags, params] = await Promise.all([
    reads.listAdminBestPages(),
    reads.listActiveTags(),
    searchParams
  ])
  const initial = prefill(params, ['intro', 'keyword', 'slug', 'tag', 'title'])
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Best pages' }]} />

      <DashboardPageHeader
        title="Best pages"
        description={countLabel(pages.length, 'best page', 'best pages')}
      />
      <TaxonomyTable
        columns={['Keyword', 'Slug', 'Tag', 'Pins']}
        nameLabel="Title"
        rows={pages.map(page => ({
          cells: [
            page.keyword,
            <span key="slug" className="font-mono">
              {page.slug}
            </span>,
            page.tagName ?? '',
            page.pinCount
          ],
          href: `/admin/best-pages/${encodeURIComponent(page.slug)}/`,
          key: page.slug,
          name: page.title
        }))}
      />
      <BestPageForm key={JSON.stringify(initial)} mode="create" initial={initial} tags={tags} />
    </>
  )
}
