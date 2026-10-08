import { siteConfig } from '@/lib/site/site-config'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'
import { featureCopy } from '../feature-copy'
import type { BadgeTarget } from './view'

/** The light badge and the listing URL a free listing's embed code uses (the badge step's). */
export const accountBadgeTarget: BadgeTarget = slug => {
  const targets = submissionBadgeTargets(slug)
  return { badgeUrl: targets.badgeUrls[0] ?? '', listingUrl: targets.listingUrl }
}

/** The badge's display name in the embed code ("Featured on SERP Best"). */
export const badgeSiteName = siteConfig.badges.featuredOn.displayName

/** The badge panel's flagged copy (`feature-copy.ts`). */
export function badgePanelCopy() {
  const { badgePanel } = featureCopy()
  return {
    description: badgePanel.description,
    failingNote: badgePanel.failingNote,
    failingTitle: badgePanel.failingTitle,
    programCheckBy: badgePanel.programCheckBy
  }
}
