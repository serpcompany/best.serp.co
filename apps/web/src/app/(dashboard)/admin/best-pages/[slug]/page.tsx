import { ExternalLink } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { BestPagePins } from '@/components/admin/best-page-pins'
import { BestPageForm } from '@/components/admin/taxonomy-forms'
import { RetireTaxonomy } from '@/components/admin/taxonomy-retire'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import { buttonVariants } from '@/components/ui/button'
import { isFeatureListing } from '@/lib/admin/feature-listings'
import { getAdminReads } from '@/lib/admin/runtime'
import { defaultRedirect, redirectChoices } from '@/lib/admin/taxonomy-view'
import { requireAdmin } from '@/lib/auth/server'
import { getRoute } from '@/lib/routing/routes'

/** One best page (#405): edit or rename it, set its pins, or retire it with a redirect. */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Best page' }

interface Props {
  params: Promise<{ slug: string }>
}

export default async function BestPagePage({ params }: Props) {
  await requireAdmin()
  const { slug } = await params
  const reads = await getAdminReads()
  const page = await reads.getAdminBestPage(decodeURIComponent(slug))
  if (!page) notFound()
  const now = new Date().toISOString()
  const [categories, tags, bestPages, tagOptions] = await Promise.all([
    reads.listAdminCategories(now),
    reads.listAdminTags(now),
    reads.listAdminBestPages(now),
    reads.listActiveTags()
  ])
  const choices = redirectChoices(
    { bestPages, categories, tags },
    { kind: 'best', slug: page.slug }
  )
  const path = getRoute('best.page', { keyword: page.slug })
  const initial = {
    intro: page.intro,
    keyword: page.keyword,
    slug: page.slug,
    tag: page.tag ?? '',
    title: page.title
  }
  const pins = page.pins.map(pin => ({ id: pin.id, name: pin.name, slug: pin.slug }))
  return (
    <>
      <AdminCrumbs
        crumbs={[
          { href: '/admin/', label: 'Admin' },
          { href: '/admin/best-pages/', label: 'Best pages' },
          { label: page.title }
        ]}
      />

      <DashboardPageHeader
        title={page.title}
        description={path}
        actions={
          <>
            {page.renders ? (
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
              action={`/api/admin/best-pages/${encodeURIComponent(page.slug)}/retire`}
              choices={choices}
              defaultTarget={defaultRedirect(choices, [
                page.tag && `tag:${page.tag}`,
                page.category && `category:${page.category}`
              ])}
              doneHref="/admin/best-pages/"
              name={page.title}
            />
          </>
        }
      />
      <BestPageForm
        key={JSON.stringify(initial)}
        categoryName={page.tag ? null : page.categoryName}
        mode="edit"
        initial={initial}
        tags={tagOptions}
      />
      <BestPagePins
        key={JSON.stringify(pins)}
        candidates={page.pool.filter(listing => !isFeatureListing(listing.id))}
        listSize={page.listSize}
        pins={pins}
        slug={page.slug}
      />
    </>
  )
}
