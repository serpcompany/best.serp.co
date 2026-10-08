import { site } from '@serpdirectory/site-config'
import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ChoosePlan } from '@/components/submit/choose-plan'
import { ordersEnabled } from '@/lib/billing/runtime'
import { nextStepPath } from '@/lib/submissions/contract'
import { toSummary } from '@/lib/submissions/http'
import { ownSubmissionForPage } from '@/lib/submissions/pages'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Choose how to get listed',
  description: 'Choose how to get your product listed on SERP.',
  path: '/submit/',
  noindex: true
})

type ChoosePageProps = {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string | string[] }>
}

/** `/submit/<id>/choose/` (#63, #70 screen 2b): free (badge) or, from #68, paid. */
export default async function ChoosePage({ params, searchParams }: ChoosePageProps) {
  const { id } = await params
  const { submission, user } = await ownSubmissionForPage(id, `/submit/${id}/choose/`)
  // A plan is already chosen (or the draft is closed): go to where it stands now.
  if (submission.status !== 'draft') redirect(nextStepPath(submission))
  return (
    <ChoosePlan
      justSaved={(await searchParams).saved === '1'}
      priceCents={site.submissions.paidListingPriceCents}
      showPaid={await ordersEnabled()}
      signedInEmail={user.email}
      submission={toSummary(submission)}
    />
  )
}
