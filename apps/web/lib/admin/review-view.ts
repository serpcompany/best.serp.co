import type { RevisionReview, SubmissionReview } from '@serpdirectory/data-ops/admin-queries'
import type { ListingDetail } from '@serpdirectory/data-ops/contracts'
import { resolveListingDetailMedia } from '@serpdirectory/data-ops/media-keys'
import { PAID_LISTING_PRICE_CENTS } from '@/components/admin/format'
import type { ReviewView } from '@/components/admin/review-detail'
import { renderableImage } from '../media/renderable-image'
import { buildSubmissionReviewPreview } from '../submissions/review-preview'

/**
 * Maps the admin reads to what the review screen renders (#64 screen 11), and builds the
 * listing preview with the submission review preview (`review-preview.ts`), the same builder
 * the legacy private preview uses.
 */

function queuedAt(review: SubmissionReview): string | null {
  if (
    review.status === 'paid_pending_review' ||
    (review.status === 'verified' && review.plan === 'paid')
  ) {
    return review.paidAt ?? review.updatedAt
  }
  if (review.status === 'verified') return review.badgeVerifiedAt ?? review.updatedAt
  return review.reviewedAt ?? review.updatedAt
}

export function submissionView(review: SubmissionReview, mediaBaseUrl: string): ReviewView {
  const paid = review.plan === 'paid'
  return {
    badge: { attempts: review.verificationAttempts, verifiedAt: review.badgeVerifiedAt },
    badgeChecks: review.badgeChecks.map(check => ({
      checkedAt: check.checkedAt,
      outcome: check.outcome,
      reason: check.reason
    })),
    block: review.block ? { urlKey: review.block.urlKey } : null,
    blockKey: review.blockKey,
    categoryName: review.categoryName,
    categorySlug: review.categorySlug,
    content: review.content,
    contentVersion: review.contentVersion,
    description: review.description,
    duplicates: review.duplicateListings + review.duplicateSubmissions,
    id: review.id,
    kind: 'submission',
    linkRel: review.listing?.linkRel ?? 'nofollow',
    listing: review.listing
      ? {
          live: review.listing.live,
          liveSince: review.listing.publishedAt,
          slug: review.listing.slug
        }
      : null,
    // The hosted copy, never the submitted source (#96 review S9).
    logoImage: renderableImage({ key: review.logoKey }, mediaBaseUrl),
    logoUrl: review.logoUrl,
    name: review.name,
    paid,
    paidAmountCents: paid && review.paidAt && !review.refundedAt ? PAID_LISTING_PRICE_CENTS : null,
    queuedAt: queuedAt(review),
    rejectionCategory: review.rejectionCategory,
    rejectionReason: review.rejectionReason,
    reviewerNote: review.reviewerNote,
    slug: review.slug,
    stale: false,
    status: review.status,
    submitter: review.submitter
      ? {
          createdAt: review.submitter.createdAt,
          email: review.submitter.email,
          otherSubmissions: review.submitter.otherSubmissions
        }
      : null,
    website: review.website
  }
}

export function revisionView(review: RevisionReview, mediaBaseUrl: string): ReviewView {
  return {
    badge: null,
    badgeChecks: review.badgeChecks.map(check => ({
      checkedAt: check.checkedAt,
      outcome: check.outcome,
      reason: check.reason
    })),
    block: null,
    blockKey: review.slug,
    categoryName: review.categoryName,
    categorySlug: review.categorySlug,
    content: review.content,
    contentVersion: review.contentVersion,
    description: review.description,
    duplicates: 0,
    id: review.id,
    kind: 'revision',
    linkRel: review.listing.linkRel,
    listing: { live: review.listing.live, liveSince: null, slug: review.listing.slug },
    // The hosted copy, never the submitted source (#96 review S9).
    logoImage: renderableImage({ key: review.logoKey }, mediaBaseUrl),
    logoUrl: review.logoUrl,
    name: review.name,
    paid: review.plan === 'paid',
    paidAmountCents: null,
    queuedAt: review.status === 'changes_requested' ? review.reviewedAt : review.updatedAt,
    rejectionCategory: null,
    rejectionReason: review.rejectionReason,
    reviewerNote: review.reviewerNote,
    slug: review.slug,
    stale: review.stale,
    status: review.status,
    submitter: review.submitter
      ? {
          createdAt: review.submitter.createdAt,
          email: review.submitter.email,
          otherSubmissions: review.submitter.otherSubmissions
        }
      : null,
    website: review.website
  }
}

/**
 * The staged content as a listing for the preview, or the reason it cannot be previewed (an
 * invalid logo or website URL, which approval would also refuse). The logo is the hosted copy
 * on this environment's media host, or the fallback tile: never the submitted source.
 */
export function stagedPreview(
  staged: {
    categorySlug: string
    content: string
    createdAt: string | null
    description: string
    id: string
    logoKey: string | null
    logoUrl: string
    name: string
    resourceLinks: Array<{ label: string; url: string }>
    slug: string
    videoUrl: string | null
    website: string
  },
  mediaBaseUrl: string
): { error: string } | { listing: ListingDetail } {
  try {
    const listing = buildSubmissionReviewPreview(
      {
        category_slug: staged.categorySlug,
        content: staged.content,
        created_at: staged.createdAt ?? new Date().toISOString(),
        description: staged.description,
        id: staged.id,
        logo_key: staged.logoKey,
        logo_url: staged.logoUrl,
        name: staged.name,
        slug: staged.slug,
        video_url: staged.videoUrl,
        website: staged.website
      },
      staged.resourceLinks.map((link, index) => ({ ...link, sort_order: index }))
    )
    return { listing: resolveListingDetailMedia(listing, mediaBaseUrl) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
