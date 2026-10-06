import { site } from '@serpdirectory/site-config'
import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { getFeaturedOnBadgePreviewPathFromKey } from '@serpdirectory/web-core/website/featured-on-badge-url'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { BadgeStep } from '@/components/submit/badge-step'
import { nextStepPath } from '@/lib/submissions/contract'
import { toSummary } from '@/lib/submissions/http'
import { ownSubmissionForPage } from '@/lib/submissions/pages'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Add the badge',
  description: 'Add the Featured on SERP badge to your site and verify it.',
  path: '/submit/',
  noindex: true
})

type BadgePageProps = {
  params: Promise<{ id: string }>
}

/** `/submit/<id>/badge/` (#63, #70 screen 3): the badge snippets, verification, and its result. */
export default async function BadgePage({ params }: BadgePageProps) {
  const { id } = await params
  const { submission, user } = await ownSubmissionForPage(id, `/submit/${id}/badge/`)
  if (submission.status !== 'pending_badge' && submission.status !== 'verified') {
    redirect(nextStepPath(submission))
  }
  const targets = submissionBadgeTargets(submission.slug)
  const [light = '', dark = ''] = targets.badgeUrls
  return (
    <BadgeStep
      badgePreviewUrls={{
        dark: getFeaturedOnBadgePreviewPathFromKey(siteConfig.badges.featuredOn.dark),
        light: getFeaturedOnBadgePreviewPathFromKey(siteConfig.badges.featuredOn.light)
      }}
      badgeUrls={{ dark, light }}
      listingUrl={targets.listingUrl}
      showPaid={site.features.showPaidListings}
      signedInEmail={user.email}
      siteName={siteConfig.badges.featuredOn.displayName}
      submission={toSummary(submission)}
    />
  )
}
