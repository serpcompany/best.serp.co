import type { ActivityEvent, AdminListingDetail } from '@/db/admin-queries'
import { renderableImage } from '../media/renderable-image'
import {
  formatDateTime,
  formatDay,
  formatLongDate,
  formatUsd,
  PAID_LISTING_PRICE_CENTS
} from './format'
import { verifiedViaLabel } from './listing-labels'
import { logoNote } from './logo-note'

/**
 * Maps the admin listing read to what the listing screen renders (#64 screen 12), including the
 * activity timeline built from the listing log and its submissions' events.
 */

function parse(detail: string | null): Record<string, unknown> {
  if (!detail) return {}
  try {
    const value = JSON.parse(detail) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return { text: detail }
  }
}

function emailFor(userId: unknown, listing: AdminListingDetail): string {
  const match = listing.ownerHistory.find(owner => owner.userId === userId)
  return match?.email ?? 'an account'
}

function activityItem(
  event: ActivityEvent,
  listing: AdminListingDetail
): { title: string; tone?: 'err' | 'ok' | 'warn' } {
  const detail = parse(event.detail)
  if (event.source === 'listing') {
    switch (event.eventType) {
      case 'edited':
        return {
          title: `Details edited${Array.isArray(detail.fields) ? `: ${detail.fields.join(', ')}` : ''}`
        }
      case 'unpublished':
        return {
          title: `Unpublished${typeof detail.note === 'string' && detail.note ? `: “${detail.note}”` : ''}`,
          tone: 'warn'
        }
      case 'republished':
        return { title: 'Republished', tone: 'ok' }
      case 'link_rel_changed':
        return { title: `Link set to ${String(detail.to ?? '')}` }
      case 'owner_granted':
        return {
          title: `Owner set to ${emailFor(detail.userId, listing)} (${verifiedViaLabel(String(detail.verifiedVia ?? '')).toLowerCase()})`
        }
      case 'owner_revoked':
        return { title: `Owner ${emailFor(detail.userId, listing)} removed` }
      case 'owner_transferred':
        return { title: `Ownership transferred to ${emailFor(detail.toUserId, listing)}` }
      default:
        return { title: event.eventType }
    }
  }
  switch (event.eventType) {
    case 'approved':
      return { title: 'Submission approved', tone: 'ok' }
    case 'rejected': {
      const prohibited = detail.category === 'prohibited'
      return { title: prohibited ? 'Rejected as prohibited' : 'Submission rejected', tone: 'err' }
    }
    case 'unpublished':
      return { title: 'Unpublished', tone: 'warn' }
    case 'paid':
      return { title: `Paid ${formatUsd(PAID_LISTING_PRICE_CENTS)}` }
    case 'refunded':
      return { title: 'Refunded' }
    case 'changes_requested':
      return { title: 'Changes requested' }
    case 'resubmitted':
      return { title: 'Resubmitted' }
    case 'edited':
      return { title: 'Submission edited' }
    default:
      return { title: `Submission ${event.eventType.replaceAll('_', ' ')}` }
  }
}

export function listingDetailView(
  listing: AdminListingDetail,
  mediaBaseUrl: string
): ListingDetailView {
  // An admin unpublish is in the listing log with its note; its submission event repeats it.
  const events = listing.activity.filter(
    event =>
      !(
        event.source === 'submission' &&
        event.eventType === 'unpublished' &&
        event.detail === 'admin'
      )
  )
  const activity = events.map(event => {
    const item = activityItem(event, listing)
    return {
      detail: `${formatDateTime(event.createdAt)} · ${event.actor}`,
      key: `${event.source}-${event.id}`,
      ...item
    }
  })
  if (listing.sourceKind.startsWith('legacy-')) {
    activity.push({
      detail: formatDay(listing.createdAt),
      key: 'imported',
      title: 'Imported from products.json'
    })
  }
  const lastUnpublish = listing.activity.find(
    event => event.source === 'listing' && event.eventType === 'unpublished'
  )
  const unpublishNote = parse(lastUnpublish?.detail ?? null).note
  const added =
    listing.source === 'submission'
      ? `submission${listing.submission?.submitterEmail ? ` by ${listing.submission.submitterEmail}` : ''}`
      : listing.sourceKind.startsWith('legacy-')
        ? 'added by admin import'
        : 'added by admin'
  const meta = [
    listing.slug,
    `${added}, ${formatLongDate(listing.publishedAt ?? listing.createdAt)}`,
    listing.adminStatus === 'live' ? `/products/${listing.slug}/` : 'not public'
  ].join(' · ')
  const paid = listing.submission?.paidAt
    ? `${formatUsd(PAID_LISTING_PRICE_CENTS)} · ${
        listing.submission.refundedAt
          ? 'refunded'
          : listing.submission.rejectionCategory === 'prohibited'
            ? 'not refunded (prohibited)'
            : 'paid'
      }`
    : null
  return {
    activity,
    adminStatus: listing.adminStatus,
    badgeChecks: listing.badgeChecks.map(check => ({
      checkedAt: check.checkedAt,
      conclusive: check.conclusive,
      key: String(check.id),
      note: check.reason ?? '',
      outcome: check.outcome
    })),
    block: listing.block,
    categoryName: listing.categoryName,
    categorySlug: listing.categorySlug,
    checksum: listing.checksum,
    description: listing.description,
    id: listing.id,
    linkRel: listing.linkRel,
    // The hosted copy (or an own-origin imported path), never a source URL (#96 review S9).
    currentLogoUrl: listing.currentLogoUrl,
    logoImage: renderableImage({ key: listing.logoKey, url: listing.currentLogoUrl }, mediaBaseUrl),
    logoUrl: listing.logoUrl,
    logoNote: logoNote(listing.logoQueue, listing.logoKey !== null),
    meta,
    name: listing.name,
    owner: listing.owner
      ? { ...listing.owner, verifiedViaLabel: verifiedViaLabel(listing.owner.verifiedVia) }
      : null,
    slug: listing.slug,
    submission: listing.submission
      ? {
          id: listing.submission.id,
          paidLabel: paid,
          submitterCreatedAt: listing.submission.submitterCreatedAt,
          submitterEmail: listing.submission.submitterEmail
        }
      : null,
    submissionQueued: listing.submissionQueued,
    unpublished:
      listing.adminStatus === 'unlisted'
        ? {
            at: lastUnpublish?.createdAt ?? listing.updatedAt,
            by: lastUnpublish?.actor ?? 'an admin',
            note: typeof unpublishNote === 'string' && unpublishNote ? unpublishNote : null
          }
        : null,
    website: listing.website
  }
}

/** How a listing's outbound website link is marked (`rel`). */
export type LinkRel = 'follow' | 'nofollow' | 'sponsored'

/** What the admin listing screen (`components/admin/listing-detail.tsx`) renders. */
export interface ListingDetailView {
  activity: Array<{ detail: string; key: string; title: string; tone?: 'err' | 'ok' | 'warn' }>
  adminStatus: 'blocked' | 'draft' | 'live' | 'rejected' | 'unlisted'
  badgeChecks: Array<{
    checkedAt: string | null
    key: string
    note: string
    outcome: 'fail' | 'pass'
    conclusive: boolean
  }>
  block: { blockedAt: string | null; blockedBy: string; reason: string; urlKey: string } | null
  categoryName: string | null
  categorySlug: string | null
  checksum: string
  description: string
  id: string
  linkRel: LinkRel
  /** Set while the logo is not hosted yet (#95). */
  logoNote: { text: string; tone: 'err' | 'warn' } | null
  /** The source of the logo the page shows now (a queued replacement is `logoUrl`). */
  currentLogoUrl: string | null
  /** What the screen renders: the hosted copy or an own-origin path, else the tile (#96 S9). */
  logoImage: string | null
  /** The logo's source, edited in the form; never rendered as an image. */
  logoUrl: string | null
  meta: string
  name: string
  owner: {
    email: string
    userId: string
    verifiedAt: string | null
    verifiedVia: string
    verifiedViaLabel: string
  } | null
  slug: string
  submission: {
    id: string
    paidLabel: string | null
    submitterCreatedAt: string | null
    submitterEmail: string | null
  } | null
  submissionQueued: boolean
  unpublished: { at: string | null; by: string; note: string | null } | null
  website: string
}
