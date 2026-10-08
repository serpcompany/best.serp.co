import type {
  AccountBadgeCheck,
  AccountListing,
  AccountOverview,
  AccountSubmission
} from '@/db/account'
import { site } from '@/lib/site'
import {
  draftExpiresInDays,
  hostOf,
  isConclusiveFailure,
  VERIFICATION_COOLDOWN_SECONDS
} from '../submissions/contract'

/**
 * The submitter dashboard's view model (#65, #70 screen 5): the user's submissions and owned
 * listings as one table of rows, its tabs, and the section cards. Pure, so the pages build it
 * on the server and the tests read it directly.
 */

/** The status chips of screen 5's legend. */
export type AccountStatus =
  | 'changes'
  | 'in_review'
  | 'live'
  | 'live_paid'
  | 'pending_badge'
  | 'plan_draft'
  | 'rejected'
  | 'unlisted'
  | 'withdrawn'

export type AccountTab = 'action' | 'closed' | 'live' | 'review'

export interface BadgePanel {
  /** The light badge image the embed code shows. */
  badgeUrl: string
  checksLeft: number
  /** When the 30-second wait after the latest check ends (epoch ms), or 0. */
  cooldownEndsAt: number
  history: AccountBadgeCheck[]
  /** The latest check (the owner's or the program's), or null before any. */
  last: AccountBadgeCheck | null
  listingId: string
  listingUrl: string
  /** The latest check is a conclusive miss. */
  failing: boolean
}

export interface AccountRow {
  /** `checkout` opens a payment (#68): rendered as a plain link, never prefetched. */
  action:
    | { checkout?: boolean; href: string; label: string; variant: 'default' | 'outline' }
    | 'badge'
    | null
  badge: BadgePanel | null
  /** The day the row is dated by (submitted, or published for a listing). */
  date: string
  draftExpiresInDays: number | null
  host: string
  /** The row's page in the account. */
  href: string
  id: string
  key: string
  kind: 'listing' | 'submission'
  logoUrl: string | null
  /** The row menu: Withdraw before payment, "Message us" once paid (#65 implementation note). */
  menu: { messageUs: boolean; withdraw: boolean }
  name: string
  next: { text: string; tone: 'muted' | 'warning' }
  plan: 'free' | 'paid' | null
  /** An owner revision of a live listing that is still open. */
  revision: 'changes_requested' | 'pending_review' | null
  slug: string
  status: AccountStatus
  tab: AccountTab
  /** "Upgrade: $49 one-off" for a live free listing while orders are on (#68). */
  upgrade: { href: string; label: string } | null
  website: string
}

export interface AccountCards {
  action: { count: number; names: string[] }
  badges: { failing: AccountRow[]; free: AccountRow[]; lastChecked: AccountRow | null }
  live: { count: number; names: string[]; paid: number }
  review: { count: number; names: string[] }
}

/** The badge panel's checks per listing per 24 hours (`LISTING_BADGE_CHECKS_PER_DAY`). */
export const LISTING_BADGE_CHECKS_PER_DAY = 10

const SHORT_REASON_LENGTH = 40

function shortReason(reason: string): string {
  const first = reason.split(/(?<=[.!?])\s/u)[0] ?? reason
  const text = first.replace(/[.!?]$/u, '')
  return text.length > SHORT_REASON_LENGTH
    ? `${text.slice(0, SHORT_REASON_LENGTH - 1).trimEnd()}…`
    : text
}

/** A badge check's result as the screen-5 chips say it. */
export function badgeResultLabel(check: Pick<AccountBadgeCheck, 'outcome' | 'reason'>): string {
  if (check.outcome === 'pass') return 'Badge found, dofollow'
  switch (check.reason) {
    case 'badge_missing':
      return 'Badge not found'
    case 'link_not_followed':
    case 'nofollow':
      return 'Link is nofollow'
    case 'page_not_followed':
      return 'Page blocks link following'
    case 'wrong_destination':
      return 'Links elsewhere'
    case 'page_unreadable':
      return 'Couldn’t read the page'
    default:
      return 'Couldn’t reach the site'
  }
}

const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })

/** The badge a listing embeds and the listing URL it must link to. */
export type BadgeTarget = (slug: string) => { badgeUrl: string; listingUrl: string }

function badgePanel(listing: AccountListing, target: BadgeTarget): BadgePanel | null {
  if (!listing.badge) return null
  const history = listing.badge.history
  const last = history[0] ?? null
  const { badgeUrl, listingUrl } = target(listing.slug)
  const lastClaim = listing.badge.lastCheckAt ? Date.parse(listing.badge.lastCheckAt) : Number.NaN
  return {
    badgeUrl,
    cooldownEndsAt: Number.isNaN(lastClaim) ? 0 : lastClaim + VERIFICATION_COOLDOWN_SECONDS * 1000,
    checksLeft: Math.max(0, LISTING_BADGE_CHECKS_PER_DAY - listing.badge.checksInWindow),
    failing: last !== null && last.outcome === 'fail' && last.conclusive,
    history,
    last,
    listingId: listing.id,
    listingUrl
  }
}

function submissionRow(submission: AccountSubmission, now: Date, showPaid: boolean): AccountRow {
  const base = {
    badge: null,
    date: submission.createdAt,
    draftExpiresInDays: null,
    host: hostOf(submission.website),
    href: `/account/submissions/${submission.id}/`,
    id: submission.id,
    key: `submission:${submission.id}`,
    kind: 'submission' as const,
    logoUrl: submission.logoUrl || null,
    menu: { messageUs: submission.paidAt !== null, withdraw: isWithdrawable(submission) },
    name: submission.name,
    plan: submission.plan,
    revision: null,
    slug: submission.slug,
    upgrade: null,
    website: submission.website
  }
  switch (submission.status) {
    case 'draft':
      return {
        ...base,
        action: { href: `/submit/${submission.id}/choose/`, label: 'Continue', variant: 'default' },
        draftExpiresInDays: draftExpiresInDays(submission.draftSavedAt, now),
        href: `/submit/${submission.id}/choose/`,
        next: {
          text: showPaid ? 'Choose free or paid' : 'Choose how to get listed',
          tone: 'muted'
        },
        status: 'plan_draft',
        tab: 'action'
      }
    case 'pending_badge':
      return {
        ...base,
        action: { href: `/submit/${submission.id}/badge/`, label: 'Add badge', variant: 'default' },
        href: `/submit/${submission.id}/badge/`,
        next: { text: 'Add the badge to your site', tone: 'muted' },
        status: 'pending_badge',
        tab: 'action'
      }
    case 'verified':
      return {
        ...base,
        action: null,
        next: { text: 'Waiting for a reviewer', tone: 'muted' },
        status: 'in_review',
        tab: 'review'
      }
    case 'paid_pending_review':
      return {
        ...base,
        action: null,
        next: { text: 'Live; a reviewer still signs off', tone: 'muted' },
        status: 'live_paid',
        tab: 'live'
      }
    case 'changes_requested':
      return {
        ...base,
        action: { href: base.href, label: 'Edit', variant: 'default' },
        next: { text: 'Fix and resubmit', tone: 'muted' },
        status: 'changes',
        tab: 'action'
      }
    case 'rejected':
      return {
        ...base,
        action: { href: base.href, label: 'Details', variant: 'outline' },
        next: {
          text: submission.rejection
            ? `Rejected: ${shortReason(submission.rejection.reason)}`
            : 'Not approved',
          tone: 'muted'
        },
        status: 'rejected',
        tab: 'closed'
      }
    default:
      return {
        ...base,
        action: {
          href: `/submit/?url=${encodeURIComponent(submission.website)}`,
          label: 'Submit again',
          variant: 'outline'
        },
        next: {
          text:
            submission.withdrawalReason === 'expired'
              ? 'Draft expired after 30 days'
              : submission.withdrawalReason === 'admin'
                ? 'Cleared by the SERP team'
                : 'You withdrew it',
          tone: 'muted'
        },
        status: 'withdrawn',
        tab: 'closed'
      }
  }
}

/** The paid listing's price in the account's CTAs (`site.submissions.paidListingPriceCents`). */
function priceLabel(priceCents: number): string {
  return `$${Math.round(priceCents / 100)}`
}

function listingRow(
  listing: AccountListing,
  target: BadgeTarget,
  paid: { priceCents: number } | null
): AccountRow {
  const badge = badgePanel(listing, target)
  const revision =
    listing.revision?.status === 'pending_review' ||
    listing.revision?.status === 'changes_requested'
      ? listing.revision.status
      : null
  const base = {
    badge,
    date: listing.publishedAt ?? '',
    draftExpiresInDays: null,
    host: hostOf(listing.website),
    href: `/account/listings/${listing.slug}/edit/`,
    id: listing.id,
    key: `listing:${listing.id}`,
    kind: 'listing' as const,
    logoUrl: listing.logoUrl,
    menu: { messageUs: listing.plan === 'paid', withdraw: false },
    name: listing.name,
    plan: listing.plan,
    revision,
    slug: listing.slug,
    upgrade: null,
    website: listing.website
  }
  const checkoutHref = `/account/listings/${listing.slug}/checkout/`
  if (!listing.live) {
    return {
      ...base,
      // Relisting a listing the badge program unlisted is a paid listing (#68).
      action:
        paid && listing.checkoutPurpose === 'relist'
          ? {
              checkout: true,
              href: checkoutHref,
              label: `Relist for ${priceLabel(paid.priceCents)}`,
              variant: 'default'
            }
          : null,
      badge: null,
      next: { text: 'Removed from best.serp.co', tone: 'muted' },
      revision: null,
      status: 'unlisted',
      tab: 'closed'
    }
  }
  if (revision === 'changes_requested') {
    return {
      ...base,
      action: { href: base.href, label: 'Edit', variant: 'default' },
      next: { text: 'Your edits need changes', tone: 'warning' },
      status: 'live',
      tab: 'action'
    }
  }
  let next: AccountRow['next'] = {
    text: revision === 'pending_review' ? 'Edits in review' : 'Published on best.serp.co',
    tone: 'muted'
  }
  if (badge?.last && revision === null) {
    next = badge.failing
      ? { text: `Badge failing: ${badgeResultLabel(badge.last).toLowerCase()}`, tone: 'warning' }
      : badge.last.outcome === 'pass'
        ? {
            text: `Badge passing · checked ${DAY.format(Date.parse(badge.last.at))}`,
            tone: 'muted'
          }
        : next
  }
  return {
    ...base,
    action: badge ? 'badge' : null,
    next,
    status: 'live',
    tab: 'live',
    upgrade:
      paid && listing.checkoutPurpose === 'upgrade'
        ? { href: checkoutHref, label: `Upgrade: ${priceLabel(paid.priceCents)} one-off` }
        : null
  }
}

/**
 * The table rows: every submission except an approved one (its listing is the row), and every
 * listing the user owns, except one whose own submission is still in review (that row is the
 * submission's). Newest first.
 */
export function accountRows(
  overview: AccountOverview,
  options: { badgeTarget: BadgeTarget; now: Date; showPaid: boolean }
): AccountRow[] {
  const paid = options.showPaid ? { priceCents: site.submissions.paidListingPriceCents } : null
  const queuedListings = new Set(
    overview.submissions
      .filter(
        submission =>
          submission.listing !== null &&
          (submission.status === 'paid_pending_review' || submission.status === 'changes_requested')
      )
      .map(submission => submission.listing?.slug)
  )
  const rows = [
    ...overview.submissions
      .filter(submission => submission.status !== 'approved')
      .map(submission => submissionRow(submission, options.now, options.showPaid)),
    ...overview.listings
      .filter(listing => !queuedListings.has(listing.slug))
      .map(listing => listingRow(listing, options.badgeTarget, paid))
  ]
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function accountCards(rows: readonly AccountRow[]): AccountCards {
  const names = (list: readonly AccountRow[]) => list.map(row => row.name)
  const action = rows.filter(row => row.tab === 'action')
  const review = rows.filter(row => row.status === 'in_review')
  const live = rows.filter(row => row.status === 'live' || row.status === 'live_paid')
  const free = rows.filter(row => row.badge !== null)
  const checked = free
    .filter(row => row.badge?.last)
    .sort((a, b) => ((a.badge?.last?.at ?? '') < (b.badge?.last?.at ?? '') ? 1 : -1))
  return {
    action: { count: action.length, names: names(action) },
    badges: {
      failing: free.filter(row => row.badge?.failing),
      free,
      lastChecked: checked[0] ?? null
    },
    live: {
      count: live.length,
      names: names(live),
      paid: live.filter(row => row.plan === 'paid').length
    },
    review: { count: review.length, names: names(review) }
  }
}

/** Whether a row's latest badge failure was conclusive (counts toward the cap). */
export function isConclusiveBadgeFailure(check: AccountBadgeCheck | null): boolean {
  return check !== null && check.outcome === 'fail' && isConclusiveFailure(check.reason)
}

const STATUS_OF: Record<AccountSubmission['status'], AccountStatus> = {
  approved: 'live',
  changes_requested: 'changes',
  draft: 'plan_draft',
  paid_pending_review: 'live_paid',
  pending_badge: 'pending_badge',
  rejected: 'rejected',
  verified: 'in_review',
  withdrawn: 'withdrawn'
}

/** A submission's chip (#70 screen 5's legend). */
export function accountStatusOf(status: AccountSubmission['status']): AccountStatus {
  return STATUS_OF[status]
}

/** Withdraw is offered before any payment, while nothing is live (#59 owner decision). */
export function isWithdrawable(submission: AccountSubmission): boolean {
  return (
    submission.paidAt === null &&
    submission.listing === null &&
    ['draft', 'pending_badge', 'verified', 'changes_requested'].includes(submission.status)
  )
}

/**
 * The category choices of an edit form: the active categories, plus the record's own when it
 * isn't among them (a category with no public listings yet), so the select always shows it.
 */
export function categoryChoices(
  categories: ReadonlyArray<{ name: string; slug: string }>,
  current: { name: string | null; slug: string | null }
): Array<{ label: string; slug: string }> {
  const choices = categories.map(category => ({ label: category.name, slug: category.slug }))
  if (current.slug && !choices.some(choice => choice.slug === current.slug)) {
    choices.unshift({ label: current.name ?? current.slug, slug: current.slug })
  }
  return choices
}
