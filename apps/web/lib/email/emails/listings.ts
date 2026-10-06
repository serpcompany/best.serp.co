/**
 * Emails about a live listing: approved, live after payment, badge missing (24h warning),
 * unlisted, and ownership removed (#70 screen 15).
 */
import { clip, defineEmailTemplate, EmailTemplateError } from '../templates'
import {
  bold,
  box,
  composeEmail,
  featuresOf,
  formatCheckTime,
  formatDay,
  formatUsd,
  hostOf,
  paragraph,
  required,
  SUBJECT_NAME_MAX,
  sitePath
} from './layout'

interface ListingRef {
  listingName: string
  /** The listing's public slug, as in `/products/<slug>/`. */
  listingSlug: string
}

function listingUrl(context: { links: { url(path: string): string } }, slug: string): string {
  return context.links.url(sitePath('products', slug))
}

export interface ListingApprovedInput extends ListingRef {
  website: string
}

export const listingApprovedEmail = defineEmailTemplate<ListingApprovedInput>({
  id: 'listing-approved',
  render(input, context) {
    const name = required(input.listingName, 'a listing name')
    const url = listingUrl(context, input.listingSlug)
    return composeEmail(
      {
        body: [
          paragraph(`${name} passed review and is now listed on SERP:`),
          box(bold(url)),
          // Weekly checks, and removal when the badge goes missing, are #66's badge program:
          // until `features.badgeProgram` is on, the email only asks to keep the badge.
          paragraph(
            featuresOf(context).badgeProgram
              ? `Keep the badge on ${required(input.website, 'a website')}. We check it every week, and a free listing whose badge goes missing is removed.`
              : `Keep the badge on ${required(input.website, 'a website')}.`
          )
        ],
        cta: { label: 'View your listing', url },
        heading: `${name} is live`,
        preheader: `Your listing is published at ${url.replace(/^https?:\/\//u, '')}`,
        subject: `${clip(name, SUBJECT_NAME_MAX)} is live on SERP`
      },
      context
    )
  }
})

export interface ListingLivePaidInput extends ListingRef {
  /** The amount paid, in cents. */
  paidCents: number
}

export const listingLivePaidEmail = defineEmailTemplate<ListingLivePaidInput>({
  id: 'listing-live-paid',
  render(input, context) {
    const name = required(input.listingName, 'a listing name')
    const url = listingUrl(context, input.listingSlug)
    return composeEmail(
      {
        body: [
          paragraph(
            `Thanks for your payment of ${formatUsd(input.paidCents, { cents: true })}. ${name} passed our automatic checks and is now listed on SERP:`
          ),
          box(bold(url)),
          paragraph(
            'A reviewer still looks at every paid listing. If we reject it for anything other than prohibited content, you get a full refund automatically.'
          ),
          paragraph('The badge is optional for paid listings.')
        ],
        cta: { label: 'View your listing', url },
        heading: `${name} is live`,
        preheader: 'Payment received. Your listing is published and in review.',
        subject: `${clip(name, SUBJECT_NAME_MAX)} is live on SERP`
      },
      context
    )
  }
})

/** What the badge check found. */
export type BadgeProblem = 'missing' | 'nofollow' | 'wrong_destination'

const BADGE_FINDINGS: Readonly<Record<BadgeProblem, readonly (string | { bold: string })[]>> = {
  missing: ['We couldn’t find the badge on the page.'],
  nofollow: ['The badge is there, but its link is marked ', { bold: 'nofollow' }, '.'],
  wrong_destination: ['The badge is there, but its link doesn’t point to your listing.']
}

export interface BadgeMissingInput extends ListingRef {
  checkedAt: Date | string
  /** The current paid listing price, in cents (the upgrade line). */
  priceCents: number
  problem: BadgeProblem
  /** When the confirmation recheck runs, about 24 hours later. */
  recheckAt: Date | string
  website: string
}

export const badgeMissingEmail = defineEmailTemplate<BadgeMissingInput>({
  id: 'badge-missing',
  render(input, context) {
    const name = required(input.listingName, 'a listing name')
    const website = required(input.website, 'a website')
    const finding = BADGE_FINDINGS[input.problem]
    if (!finding) throw new EmailTemplateError('Unknown badge problem.')
    return composeEmail(
      {
        after: [
          paragraph(
            `Rather not keep the badge? Upgrade to a paid listing for ${formatUsd(input.priceCents, { cents: false })} one-off and the badge becomes optional.`
          )
        ],
        body: [
          paragraph(
            `Our weekly check loaded ${website} on ${formatCheckTime(input.checkedAt)}. `,
            ...finding
          ),
          paragraph(
            'We’ll check again around ',
            bold(formatCheckTime(input.recheckAt)),
            `. If there still isn’t a badge with a dofollow link to your listing, ${name} will be removed from SERP.`
          ),
          paragraph(
            'To fix it, put the badge code from your dashboard back on the page, then run a check.'
          )
        ],
        cta: {
          label: 'Check my badge',
          url: context.links.url(sitePath('account', 'listings', input.listingSlug))
        },
        heading: 'We couldn’t find a working badge',
        preheader: 'We’ll check again in about 24 hours.',
        subject: `Action needed: the SERP badge is missing on ${hostOf(website)}`
      },
      context
    )
  }
})

export interface ListingUnlistedInput extends ListingRef {
  /** When the confirmation recheck ran. */
  checkedAt: Date | string
  priceCents: number
  /** When the 24h warning went out. */
  warnedAt: Date | string
  website: string
}

export const listingUnlistedEmail = defineEmailTemplate<ListingUnlistedInput>({
  id: 'listing-unlisted',
  render(input, context) {
    const name = required(input.listingName, 'a listing name')
    const price = formatUsd(input.priceCents, { cents: false })
    return composeEmail(
      {
        body: [
          paragraph(
            `We rechecked ${required(input.website, 'a website')} on ${formatCheckTime(input.checkedAt)} and the badge was still missing, so ${name} has been removed from SERP, as we warned on ${formatDay(input.warnedAt)}.`
          ),
          paragraph(
            `To bring it back, relist it as a paid listing. It’s ${price} one-off, and the badge becomes optional.`
          )
        ],
        cta: {
          label: `Relist for ${price}`,
          url: context.links.url(sitePath('account', 'listings', input.listingSlug))
        },
        heading: `${name} is no longer listed`,
        preheader: 'The badge was still missing on our recheck.',
        subject: `${clip(name, SUBJECT_NAME_MAX)} has been removed from SERP`
      },
      context
    )
  }
})

export interface OwnershipRemovedInput extends ListingRef {
  checkedAt: Date | string
  priceCents: number
  website: string
}

export const ownershipRemovedEmail = defineEmailTemplate<OwnershipRemovedInput>({
  id: 'ownership-removed',
  render(input, context) {
    const name = required(input.listingName, 'a listing name')
    return composeEmail(
      {
        body: [
          paragraph(
            `We rechecked ${required(input.website, 'a website')} on ${formatCheckTime(input.checkedAt)} and the badge was still missing. Ownership came from the badge, so you no longer manage the ${name} listing.`
          ),
          paragraph(
            `The listing stays on SERP. To manage it again, claim it again with the badge or a ${formatUsd(input.priceCents, { cents: false })} one-off payment.`
          )
        ],
        cta: { label: `Claim ${name} again`, url: listingUrl(context, input.listingSlug) },
        heading: `Your ownership of ${name} was removed`,
        preheader: 'The badge was still missing on our recheck.',
        subject: `You no longer manage ${clip(name, SUBJECT_NAME_MAX)} on SERP`
      },
      context
    )
  }
})
