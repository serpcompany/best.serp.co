import { ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { TagForm } from '@/components/admin/taxonomy-forms'
import { RetireTaxonomy } from '@/components/admin/taxonomy-retire'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { buttonVariants } from '@/components/ui/button'
import { getAdminReads } from '@/lib/admin/runtime'
import { defaultRedirect, redirectChoices } from '@/lib/admin/taxonomy-view'
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
  const now = new Date().toISOString()
  const tag = await reads.getAdminTag(decodeURIComponent(slug), now)
  if (!tag) notFound()
  const [categories, tags, bestPages, options] = await Promise.all([
    reads.listAdminCategories(now),
    reads.listAdminTags(now),
    reads.listAdminBestPages(now),
    reads.listActiveCategories()
  ])
  const choices = redirectChoices({ bestPages, categories, tags }, { kind: 'tag', slug: tag.slug })
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
            {tag.renders ? (
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
              choices={choices}
              defaultTarget={defaultRedirect(choices, [`category:${tag.category}`])}
              doneHref="/admin/tags/"
              name={tag.name}
            />
          </>
        }
      />
      <TagForm key={JSON.stringify(initial)} categories={options} mode="edit" initial={initial} />
    </>
  )
}
