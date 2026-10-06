import { type SiteFeatures, features as siteFeatures } from './features'

/**
 * Submitter-facing page copy that promises a site area a later step of #59 builds, by its flag
 * (PR #84 review round 4). While the flag is off the copy is left out, as the emails do
 * (`lib/email/emails/`); when the issue turns its flag on, the approved #70 wording comes back.
 * `feature-copy.test.ts` fails if a page promises one of these areas anywhere else.
 */
export function featureCopy(features: SiteFeatures = siteFeatures) {
  return {
    /** The verified badge step's card (#70 screen 3): adding FAQs and links is #65. */
    addFaqsAndLinks: features.accountDashboard
      ? {
          description: 'From your account while the listing is in review.',
          title: 'Add FAQs and links'
        }
      : null,
    /** The submit form's long-description hint (#70 screen 2). */
    contentHint: features.accountDashboard
      ? 'Shown on your listing page. FAQs and links can be added from your account later.'
      : 'Shown on your listing page.',
    /** The free plan's last point (#70 screen 2b): weekly badge checks are #66. */
    freePlanBadgeCheck: features.badgeProgram ? 'Keep the badge up: we check it every week' : null,
    /** The verified badge step's card (#70 screen 3). */
    keepTheBadgeUp: features.badgeProgram
      ? {
          description:
            'We check it every week. If it goes missing, we email you and check again about 24 hours later.',
          title: 'Keep the badge up'
        }
      : null
  }
}
