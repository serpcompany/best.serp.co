import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AdminCrumbs } from '@/components/admin/admin-shell'
import { PreviewCardBody } from '@/components/admin/preview-card-body'
import { ReviewDetail } from '@/components/admin/review-detail'
import { previewVerifiedOwner, revisionView, stagedPreview } from '@/lib/admin/review-view'
import { getAdminReads } from '@/lib/admin/runtime'
import { decisionIdSchema } from '@/lib/admin/schemas'
import { requireAdmin } from '@/lib/auth/server'
import { mediaBaseUrl } from '@/lib/media/media-base'

/** One owner revision of a live listing under review (#64; screen 11's layout). */
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Revision review' }

interface Props {
  params: Promise<{ id: string }>
}

export default async function RevisionReviewPage({ params }: Props) {
  await requireAdmin()
  const id = decisionIdSchema.safeParse((await params).id)
  if (!id.success) notFound()
  const reads = await getAdminReads()
  const [review, categories] = await Promise.all([
    reads.getRevisionReview(id.data),
    reads.listActiveCategories()
  ])
  if (!review) notFound()
  const media = await mediaBaseUrl()
  return (
    <>
      <AdminCrumbs
        crumbs={[
          { href: '/admin/', label: 'Admin' },
          { href: '/admin/submissions/', label: 'Review queue' },
          { label: review.name }
        ]}
      />

      <ReviewDetail
        categories={categories}
        preview={
          <PreviewCardBody
            categoryName={review.categoryName}
            preview={stagedPreview(review, media)}
            verifiedOwner={previewVerifiedOwner(review)}
          />
        }
        view={revisionView(review, media)}
      />
    </>
  )
}
