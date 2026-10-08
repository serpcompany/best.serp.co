import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { AccountCrumbs } from '@/components/account/account-shell'
import { SubmissionDetail } from '@/components/account/submission-detail'
import { submissionHistory } from '@/lib/account/history'
import { requireAccountUser } from '@/lib/account/pages'
import { ACCOUNT_ID } from '@/lib/account/requests'
import { accountOperations } from '@/lib/account/runtime'
import { accountStatusOf, categoryChoices, isWithdrawable } from '@/lib/account/view'
import { getActiveCategories } from '@/lib/catalog/repository'
import { featureCopy } from '@/lib/feature-copy'
import { features } from '@/lib/features'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Submission',
  description: 'Your submission to SERP.',
  path: '/account/submissions/',
  noindex: true
})

type SubmissionPageProps = { params: Promise<{ id: string }> }

/**
 * `/account/submissions/<id>/` (#65; #70 screen 6, linked from the changes-requested and
 * rejection emails). A draft or a submission waiting for its badge continues in the submit flow,
 * and an approved one is its listing. Someone else's submission is a 404.
 */
export default async function AccountSubmissionPage({
  params
}: SubmissionPageProps): Promise<ReactElement> {
  const { id } = await params
  const user = await requireAccountUser(`/account/submissions/${id}/`)
  if (!ACCOUNT_ID.test(id)) notFound()
  const operations = await accountOperations()
  const submission = await operations.submission(user.id, id)
  if (!submission) notFound()
  if (submission.status === 'draft') redirect(`/submit/${id}/choose/`)
  if (submission.status === 'pending_badge') redirect(`/submit/${id}/badge/`)
  if (submission.status === 'approved' && submission.listing) {
    const owned = await operations.listing(user.id, submission.listing.slug)
    if (owned) redirect(`/account/listings/${owned.slug}/edit/`)
  }
  const categories = submission.status === 'changes_requested' ? await getActiveCategories() : []
  return (
    <>
      <AccountCrumbs
        crumbs={[
          { href: getRoute('account'), label: 'Account' },
          { href: '/account/submissions/', label: 'Submissions' },
          { label: submission.name }
        ]}
      />
      <SubmissionDetail
        categories={categoryChoices(categories, {
          name: submission.categoryName,
          slug: submission.categorySlug
        })}
        email={user.email}
        faqsHint={featureCopy().faqsHint ?? ''}
        history={submissionHistory(submission)}
        messagesNote={features.messages}
        view={{
          categoryName: submission.categoryName,
          categorySlug: submission.categorySlug,
          content: submission.content,
          contentVersion: submission.contentVersion,
          description: submission.description,
          faqs: submission.faqs,
          id: submission.id,
          listingLive: submission.listing?.live === true,
          logoUrl: submission.logoUrl,
          name: submission.name,
          paid: submission.paidAt !== null,
          plan: submission.plan,
          refunded: submission.refundedAt !== null,
          rejection: submission.rejection,
          resourceLinks: submission.resourceLinks,
          reviewedAt: submission.reviewedAt,
          reviewerNote: submission.reviewerNote,
          status: accountStatusOf(submission.status),
          updatedAt: submission.updatedAt,
          website: submission.website,
          withdrawable: isWithdrawable(submission),
          withdrawalReason: submission.withdrawalReason
        }}
      />
    </>
  )
}
