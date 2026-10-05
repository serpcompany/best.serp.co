import {
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  listingHasQueuedSubmission,
  listingIsLiveGuard,
  type StatementPlan
} from './plan-support'
import {
  type ListingLinkRel,
  type ListingOwnerVerification,
  listingLinkRels,
  listingOwnerVerifications
} from './schema'

/**
 * Listing-level transitions (serpcompany/best.serp.co#62). Each changes public output, so each
 * advances the catalog version in the same batch (`CatalogPublication`).
 *
 * A listing is **unpublished** when `status = 'approved'` and `is_active = 0`: the row, slug,
 * and memberships stay, the public queries (pages, sitemap, search, RSS, category pages) drop
 * it, and its URL answers 410 Gone (#64) until it is republished. The protected publisher's
 * `listing-unpublish` operation reaches the same state.
 */
export function selectListingForPublicationPlan(listingId: string): StatementPlan {
  return {
    sql: `SELECT l.id,l.slug,l.status,l.is_active,l.link_rel,l.source,l.checksum,
        ps.version,ps.checksum AS publication_checksum,
        (SELECT o.user_id FROM listing_owners o
          WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL) AS owner_user_id
      FROM listings l JOIN publication_state ps ON ps.id=1
      WHERE l.id=?`,
    params: [listingId]
  }
}

function submissionEvent(
  listingId: string,
  eventType: string,
  actor: string,
  detail: string
): StatementPlan {
  // The listing's originating submission, if any, records what happened to it.
  return {
    sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
      SELECT id,?,?,? FROM listing_submissions WHERE listing_id=? AND status='approved'`,
    params: [eventType, detail, actor, listingId]
  }
}

/**
 * Live → unpublished, with a reason code (for example `admin` or `badge_missing`). Refused while
 * the listing's own submission is still in review: the reviewer rejects it instead, so
 * `paid_pending_review` stays live.
 */
export function buildUnpublishListingPlans(input: {
  listingId: string
  publication: CatalogPublication
  reason: string
}): StatementPlan[] {
  if (!input.reason.trim()) throw new Error('Unpublishing a listing needs a reason.')
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `${listingIsLiveGuard('?')} AND NOT ${listingHasQueuedSubmission('?')}`,
      params: [input.listingId, input.listingId]
    }),
    {
      sql: `UPDATE listings SET is_active=0,updated_at=?
        WHERE id=? AND status='approved' AND is_active=1`,
      params: [input.publication.now, input.listingId]
    },
    assertPreviousStatementChangedOne('listing_unpublished'),
    submissionEvent(input.listingId, 'unpublished', input.publication.actor, input.reason),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/** Unpublished → live again at the same URL. The triggers re-check its primary category. */
export function buildRepublishListingPlans(input: {
  listingId: string
  publication: CatalogPublication
}): StatementPlan[] {
  const unpublished = `EXISTS (SELECT 1 FROM listings
    WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL)`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: unpublished,
      params: [input.listingId]
    }),
    {
      sql: `UPDATE listings SET is_active=1,updated_at=?
        WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL`,
      params: [input.publication.now, input.listingId]
    },
    assertPreviousStatementChangedOne('listing_republished'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/** The admin setting for our outbound link: `follow` | `nofollow` | `sponsored`. */
export function buildSetListingLinkRelPlans(input: {
  linkRel: ListingLinkRel
  listingId: string
  publication: CatalogPublication
}): StatementPlan[] {
  if (!(listingLinkRels as readonly string[]).includes(input.linkRel)) {
    throw new Error('Link rel must be follow, nofollow, or sponsored.')
  }
  const changes = `EXISTS (SELECT 1 FROM listings WHERE id=? AND link_rel!=?)`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: changes,
      params: [input.listingId, input.linkRel]
    }),
    {
      sql: `UPDATE listings SET link_rel=?,updated_at=? WHERE id=? AND link_rel!=?`,
      params: [input.linkRel, input.publication.now, input.listingId, input.linkRel]
    },
    assertPreviousStatementChangedOne('listing_link_rel_changed'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * No current owner → owner (claims, #67). The public "Verified owner" badge reads the
 * current owner row, so ownership changes advance the catalog version.
 */
export function buildGrantListingOwnerPlans(input: {
  listingId: string
  publication: CatalogPublication
  userId: string
  verifiedVia: ListingOwnerVerification
}): StatementPlan[] {
  if (!(listingOwnerVerifications as readonly string[]).includes(input.verifiedVia)) {
    throw new Error('Ownership must be verified by submission, badge_claim, or paid_claim.')
  }
  const ownerless = `EXISTS (SELECT 1 FROM listings l WHERE l.id=? AND l.status='approved'
    AND NOT EXISTS (SELECT 1 FROM listing_owners o
      WHERE o.listing_id=l.id AND o.role='owner' AND o.revoked_at IS NULL))`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: ownerless,
      params: [input.listingId]
    }),
    {
      sql: `INSERT INTO listing_owners (listing_id,user_id,role,verified_via,verified_at)
        SELECT ?,?,'owner',?,? WHERE ${ownerless}`,
      params: [
        input.listingId,
        input.userId,
        input.verifiedVia,
        input.publication.now,
        input.listingId
      ]
    },
    assertPreviousStatementChangedOne('listing_owner_granted'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * Current owner → revoked, with a reason code (for example `badge_removed`, #66: the listing
 * stays up as curated). The row is kept as ownership history.
 */
export function buildRevokeListingOwnerPlans(input: {
  listingId: string
  publication: CatalogPublication
  reason: string
  userId: string
}): StatementPlan[] {
  if (!input.reason.trim()) throw new Error('Revoking ownership needs a reason.')
  const current = `listing_id=? AND user_id=? AND role='owner' AND revoked_at IS NULL`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listing_owners WHERE ${current})`,
      params: [input.listingId, input.userId]
    }),
    {
      sql: `UPDATE listing_owners SET revoked_at=?,revoked_reason=? WHERE ${current}`,
      params: [input.publication.now, input.reason, input.listingId, input.userId]
    },
    assertPreviousStatementChangedOne('listing_owner_revoked'),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}
