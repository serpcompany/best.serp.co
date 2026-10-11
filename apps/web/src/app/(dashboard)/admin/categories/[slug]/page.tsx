import { ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { CategoryForm } from '@/components/admin/taxonomy-forms'
import { RetireTaxonomy } from '@/components/admin/taxonomy-retire'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { buttonVariants } from '@/components/ui/button'
import { getAdminReads } from '@/lib/admin/runtime'
import { redirectChoices } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'
import { getRoute } from '@/lib/routing/routes'

/** One category, a hub (#405): edit or rename it, or retire it with a redirect. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Category' }

interface Props {
  params: Promise<{ slug: string }>
}

export default async function CategoryPage({ params }: Props) {
  await requireAdmin()
  const { slug } = await params
  const reads = await getAdminReads()
  const category = await reads.getAdminCategory(decodeURIComponent(slug))
  if (!category) notFound()
  const [categories, tags, bestPages] = await Promise.all([
    reads.listActiveCategories(),
    reads.listActiveTags(),
    reads.listAdminBestPages()
  ])
  const path = getRoute('category.page', { category: category.slug })
  const initial = {
    description: category.description,
    name: category.name,
    order: category.order,
    slug: category.slug
  }
  return (
    <>
      <AdminCrumbs
        crumbs={[
          { href: '/admin/', label: 'Admin' },
          { href: '/admin/categories/', label: 'Categories' },
          { label: category.name }
        ]}
      />

      <DashboardPageHeader
        title={category.name}
        description={path}
        actions={
          <>
            {category.listingCount > 0 ? (
              <a
                href={path}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                View live
                <ExternalLink />
              </a>
            ) : null}
            <RetireTaxonomy
              action={`/api/admin/categories/${encodeURIComponent(category.slug)}/retire`}
              choices={redirectChoices(
                { bestPages, categories, tags },
                { kind: 'category', slug: category.slug }
              )}
              defaultTarget="directory"
              doneHref="/admin/categories/"
              name={category.name}
            />
          </>
        }
      />
      <CategoryForm key={JSON.stringify(initial)} mode="edit" initial={initial} />
    </>
  )
}
