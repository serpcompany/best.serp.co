import type { Metadata } from 'next'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { ageWords, PAID_LISTING_PRICE_CENTS } from '@/components/admin/format'
import { type QueueRow, ReviewQueue } from '@/components/admin/review-queue'
import { DashboardPageHeader } from '@/components/dashboard/page-header'
import type { ReviewQueueItem, ReviewQueueView } from '@/db/admin-queries'
import { getAdminReads } from '@/lib/admin/runtime'
import { requireAdmin } from '@/lib/auth/server'
import { mediaBaseUrl } from '@/lib/media/media-base'
import { renderableImage } from '@/lib/media/renderable-image'

/** The review queue (#64 screen 10). */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Review queue' }

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function list(value: string | string[] | undefined, allowed: readonly string[]): string[] {
  const raw = Array.isArray(value) ? value.join(',') : (value ?? '')
  return raw
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => allowed.includes(item))
}

function toRow(item: ReviewQueueItem, media: string): QueueRow {
  const paid = item.plan === 'paid'
  return {
    badge: item.badge,
    href:
      item.kind === 'revision'
        ? `/admin/revisions/${encodeURIComponent(item.id)}/`
        : `/admin/submissions/${encodeURIComponent(item.id)}/`,
    id: item.id,
    kind: item.kind,
    listingSlug: item.listingId ? item.slug : null,
    // Only a hosted copy is shown, never the submitted source (#96 review S9).
    logoUrl: renderableImage({ key: item.logoKey }, media),
    name: item.name,
    ownerEmail: item.ownerEmail,
    paid,
    // The amount charged is in #68's orders; the paid plan is $49 (#59).
    paidAmountCents: item.paidAt && !item.refundedAt ? PAID_LISTING_PRICE_CENTS : null,
    queuedAt: item.queuedAt,
    slug: item.slug,
    status: item.status,
    website: item.website
  }
}

export default async function ReviewQueuePage({ searchParams }: Props) {
  await requireAdmin()
  const params = await searchParams
  const view: ReviewQueueView =
    params.view === 'changes' || params.view === 'all' ? params.view : 'waiting'
  const reads = await getAdminReads()
  const [items, counts, media] = await Promise.all([
    reads.listReviewQueue(view),
    reads.reviewQueueCounts(),
    mediaBaseUrl()
  ])
  const description =
    counts.waiting === 0
      ? 'Nothing waiting'
      : `${counts.waiting} waiting · oldest ${ageWords(counts.oldestQueuedAt)}`
  return (
    <>
      <AdminCrumbs crumbs={[{ href: '/admin/', label: 'Admin' }, { label: 'Review queue' }]} />

      <DashboardPageHeader title="Review queue" description={description} />
      <ReviewQueue
        counts={counts}
        initialFilters={{
          badge: list(params.badge, ['pass', 'fail', 'optional', 'none']),
          plan: list(params.plan, ['free', 'paid']),
          source: list(params.source, ['submission', 'revision'])
        }}
        rows={items.map(item => toRow(item, media))}
        view={view}
      />
    </>
  )
}
