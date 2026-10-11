import { ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { TagForm } from '@/components/admin/taxonomy-forms'
import { RetireTaxonomy } from '@/components/admin/taxonomy-retire'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { buttonVariants } from '@/components/ui/button'
import { getAdminReads } from '@/lib/admin/runtime'
import { redirectChoices } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'
import { getRoute } from '@/lib/routing/routes'

/** One tag (#405): edit, move, or rename it, or retire it with a redirect. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Tag' }

interface Props {
  params: Promise<{ slug: string }>
}

export default async function TagPage({ params }: Props) {
  await requireAdmin()
  const { slug } = await params
  const reads = await getAdminReads()
  const tag = await reads.getAdminTag(decodeURIComponent(slug))
  if (!tag) notFound()
  const [categories, tags, bestPages] = await Promise.all([
    reads.listActiveCategories(),
    reads.listActiveTags(),
    reads.listAdminBestPages()
  ])
  const path = getRoute('tag.page', { tag: tag.slug })
  const initial = {
    category: tag.category,
    description: tag.description,
    name: tag.name,
    slug: tag.slug
  }
  return (
    <>
      <AdminCrumbs
        crumbs={[
          { href: '/admin/', label: 'Admin' },
          { href: '/admin/tags/', label: 'Tags' },
          { label: tag.name }
        ]}
      />

      <DashboardPageHeader
        title={tag.name}
        description={path}
        actions={
          <>
            {tag.listingCount > 0 ? (
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
              action={`/api/admin/tags/${encodeURIComponent(tag.slug)}/retire`}
              choices={redirectChoices(
                { bestPages, categories, tags },
                { kind: 'tag', slug: tag.slug }
              )}
              defaultTarget={`category:${tag.category}`}
              doneHref="/admin/tags/"
              name={tag.name}
            />
          </>
        }
      />
      <TagForm
        key={JSON.stringify(initial)}
        categories={categories}
        mode="edit"
        initial={initial}
      />
    </>
  )
}
