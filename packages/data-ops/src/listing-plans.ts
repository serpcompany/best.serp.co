import { urlKey, websiteSpellings } from '@serpdirectory/utils/url-key'
import { type HostedMedia, isListingMediaKey } from './media-keys'
import { buildQueueMediaPlans, buildRecordMediaFailurePlans } from './media-plans'
import {
  assertGuard,
  assertPreviousStatementChangedOne,
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  listingHasQueuedSubmission,
  listingIsLiveGuard,
  type PlanGuard,
  type StatementPlan
} from './plan-support'
import { validatePublicHttpUrl } from './public-url'
import {
  activeSubmissionStatuses,
  type ListingEventType,
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

/** A row in the listing activity log (`listing_events`), written by the same batch. */
function listingEvent(
  listingId: string,
  eventType: ListingEventType,
  actor: string,
  detail: Record<string, unknown> | null = null
): StatementPlan {
  return {
    sql: `INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,?,?,?)`,
    params: [listingId, eventType, detail ? JSON.stringify(detail) : null, actor]
  }
}

/** The two halves of `listingWebsiteMatch`, each selecting the ids of matching listings. */
function listingWebsiteMatchHalves(input: { exceptListingId?: string; website: string }): {
  byKey: PlanGuard
  bySuffix: PlanGuard
} {
  const website = input.website.trim()
  const host = urlKey(website).hostKey
  const spellings = websiteSpellings(website)
  const exact = [...new Set([website, ...spellings])]
  const except = input.exceptListingId === undefined ? [] : [input.exceptListingId]
  return {
    byKey: {
      sql: `SELECT id FROM listings WHERE ${except.length ? 'id<>? AND ' : ''}(slug=?
        OR website IN (${exact.map(() => '?').join(',')}))`,
      params: [...except, host, ...exact]
    },
    bySuffix: {
      sql: `SELECT suffixed.id FROM json_each(?) spelling JOIN listings suffixed
        ON suffixed.website >= spelling.value || '#' AND suffixed.website < spelling.value || '@'
        AND substr(suffixed.website, length(spelling.value) + 1, 1) IN ('?', '#')
        ${except.length ? 'WHERE suffixed.id<>?' : ''}`,
      params: [JSON.stringify(spellings), ...except]
    }
  }
}

/**
 * Whether a listing already has `website` (#64 review): the one rule submission intake
 * (`checkUrl`, `createDraft`, through `listingIdsWithWebsite`) and the admin website edit
 * (`listingWebsiteConflicts`) share. A listing matches when its slug is the website's host
 * (`urlKey`), or its stored website (kept as entered) is the URL as given or one of its
 * spellings (`websiteSpellings`), with or without a query or fragment after it. So
 * `https://x.example/?ref=abc`, `https://x.example/#top` and `https://x.example/` collide
 * whichever is stored. Both halves use `listings_website_idx`: an IN list, and one range per
 * spelling (`spelling#` up to `spelling@`, then `?` or `#` next).
 */
export function listingWebsiteMatch(input: {
  exceptListingId?: string
  website: string
}): PlanGuard {
  const { byKey, bySuffix } = listingWebsiteMatchHalves(input)
  return {
    sql: `(EXISTS (${byKey.sql}) OR EXISTS (${bySuffix.sql}))`,
    params: [...byKey.params, ...bySuffix.params]
  }
}

/**
 * The ids of the listings that already have `website` by `listingWebsiteMatch`'s rule, for
 * submission intake, which shows the listing ("Claim this listing").
 */
export function listingIdsWithWebsite(website: string): PlanGuard {
  const { byKey, bySuffix } = listingWebsiteMatchHalves({ website })
  return {
    sql: `${byKey.sql} UNION ALL ${bySuffix.sql}`,
    params: [...byKey.params, ...bySuffix.params]
  }
}

/**
 * What stops a listing from moving to another website (#64 review), with the submission
 * intake's rules (`createDraft`): the website must pass `validatePublicHttpUrl`; no other
 * listing may already have it (`listingWebsiteMatch`); its host must not be the slug of a
 * submission in flight (other than this listing's own); and no active prohibited-URL block may
 * cover it (the `listing_submissions_refuse_blocked_url` trigger's rule). Throws for an invalid
 * website.
 */
export function listingWebsiteConflicts(input: { listingId: string; website: string }): {
  block: PlanGuard
  listing: PlanGuard
  submission: PlanGuard
} {
  const website = input.website.trim()
  if (!validatePublicHttpUrl(website).ok) throw new Error('A website must be a public HTTP(S) URL.')
  const host = urlKey(website).hostKey
  const statuses = activeSubmissionStatuses.map(() => '?').join(',')
  return {
    block: {
      sql: `EXISTS (SELECT 1 FROM listing_submission_url_blocks WHERE lifted_at IS NULL
        AND (url_key=? OR (covers_subdomains=1 AND substr(?, -1 - length(url_key))='.' || url_key)))`,
      params: [host, host]
    },
    listing: listingWebsiteMatch({ exceptListingId: input.listingId, website }),
    submission: {
      sql: `EXISTS (SELECT 1 FROM listing_submissions WHERE slug=? AND status IN (${statuses})
        AND (listing_id IS NULL OR listing_id<>?))`,
      params: [host, ...activeSubmissionStatuses, input.listingId]
    }
  }
}

/** True while the listing's originating submission stands rejected (either category). */
function listingSubmissionRejected(listingIdSql: string): string {
  return `EXISTS (SELECT 1 FROM listing_submissions rejected
    WHERE rejected.listing_id=${listingIdSql} AND rejected.status='rejected')`
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
  /** An admin's note for the activity log (optional). */
  note?: string
  publication: CatalogPublication
  reason: string
}): StatementPlan[] {
  if (!input.reason.trim()) throw new Error('Unpublishing a listing needs a reason.')
  const note = input.note?.trim() || null
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
    listingEvent(input.listingId, 'unpublished', input.publication.actor, {
      note,
      reason: input.reason
    }),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * Unpublished → live again at the same URL. The triggers re-check its primary category. A
 * listing whose submission was rejected stays down: it returns only through a new submission
 * (and, after a prohibited rejection, only once an admin has lifted the block).
 */
export function buildRepublishListingPlans(input: {
  listingId: string
  publication: CatalogPublication
}): StatementPlan[] {
  const unpublished = `EXISTS (SELECT 1 FROM listings
    WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL)
    AND NOT ${listingSubmissionRejected('?')}`
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: unpublished,
      params: [input.listingId, input.listingId]
    }),
    {
      sql: `UPDATE listings SET is_active=1,updated_at=?
        WHERE id=? AND status='approved' AND is_active=0 AND published_at IS NOT NULL`,
      params: [input.publication.now, input.listingId]
    },
    assertPreviousStatementChangedOne('listing_republished'),
    listingEvent(input.listingId, 'republished', input.publication.actor),
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
      sql: `INSERT INTO listing_events (listing_id,event_type,detail,actor)
        SELECT id,'link_rel_changed',json_object('from',link_rel,'to',?),? FROM listings
        WHERE id=? AND link_rel!=?`,
      params: [input.linkRel, input.publication.actor, input.listingId, input.linkRel]
    },
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
    listingEvent(input.listingId, 'owner_granted', input.publication.actor, {
      userId: input.userId,
      verifiedVia: input.verifiedVia
    }),
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
    listingEvent(input.listingId, 'owner_revoked', input.publication.actor, {
      reason: input.reason,
      userId: input.userId
    }),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}

/**
 * An admin moves a listing to another account (#64): the current owner, if any, is revoked
 * (`transferred`) and `toUserId` becomes the owner (`verified_via = 'admin'`). It compares and
 * swaps on the owner the admin saw (`fromUserId`, null for an ownerless listing). The new owner
 * needs an account with a verified email.
 */
export function buildTransferListingOwnerPlans(input: {
  fromUserId: string | null
  listingId: string
  publication: CatalogPublication
  toUserId: string
}): StatementPlan[] {
  if (input.fromUserId === input.toUserId) {
    throw new Error('The listing already belongs to that account.')
  }
  const currentOwner =
    input.fromUserId === null
      ? {
          params: [input.listingId],
          sql: `NOT EXISTS (SELECT 1 FROM listing_owners o
            WHERE o.listing_id=? AND o.role='owner' AND o.revoked_at IS NULL)`
        }
      : {
          params: [input.listingId, input.fromUserId],
          sql: `EXISTS (SELECT 1 FROM listing_owners o
            WHERE o.listing_id=? AND o.user_id=? AND o.role='owner' AND o.revoked_at IS NULL)`
        }
  const plans: StatementPlan[] = [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `${currentOwner.sql}
        AND EXISTS (SELECT 1 FROM listings WHERE id=? AND status='approved')
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND email_verified=1)`,
      params: [...currentOwner.params, input.listingId, input.toUserId]
    })
  ]
  if (input.fromUserId !== null) {
    plans.push(
      {
        sql: `UPDATE listing_owners SET revoked_at=?,revoked_reason='transferred'
          WHERE listing_id=? AND user_id=? AND role='owner' AND revoked_at IS NULL`,
        params: [input.publication.now, input.listingId, input.fromUserId]
      },
      assertPreviousStatementChangedOne('previous_owner_revoked')
    )
  }
  plans.push(
    {
      sql: `INSERT INTO listing_owners (listing_id,user_id,role,verified_via,verified_at)
        VALUES (?,?,'owner','admin',?)`,
      params: [input.listingId, input.toUserId, input.publication.now]
    },
    assertPreviousStatementChangedOne('listing_owner_transferred'),
    listingEvent(input.listingId, 'owner_transferred', input.publication.actor, {
      fromUserId: input.fromUserId,
      toUserId: input.toUserId
    }),
    ...finishCatalogPublicationPlans(input.publication)
  )
  return plans
}

/** The listing fields an admin edits on the listing page (#64 screen 12). */
export interface ListingDetailsEdit {
  categorySlug: string
  description: string
  /** Empty when the edit removes the logo (the page then shows the fallback tile). */
  logoUrl: string
  name: string
  website: string
}

/** What a listing details edit changed, as the activity log names it. */
export type ListingDetailsField = 'category' | 'description' | 'logo' | 'name' | 'website'

/**
 * What became of a changed logo's source before the edit's batch (#95): hosted (its key and
 * metadata), or a failed first attempt the cron may still recover from. A failure that cannot
 * recover (SVG, not an image, too large, 404) never reaches the batch: the admin sees the error
 * and nothing is written. Without an outcome (no media binding) the source is queued untried.
 */
export type ListingLogoIngestion =
  | { hosted: HostedMedia }
  | { failure: { code: string; retryable: boolean } }

/**
 * The changed logo's statements. A hosted copy replaces the logo row. Otherwise the new source is
 * queued, and a hosted current logo stays until its replacement is hosted (an unhosted one is
 * cleared, since it would be a hotlink). The logo row is never the URL.
 */
function changedLogoPlans(input: {
  cancelQueued?: boolean
  ingestion?: ListingLogoIngestion
  listingId: string
  logoUrl: string
  now: string
}): StatementPlan[] {
  const { listingId, logoUrl } = input
  const clearQueue: StatementPlan = {
    sql: `DELETE FROM media_ingestions WHERE listing_id=? AND kind='logo'`,
    params: [listingId]
  }
  if (input.cancelQueued) {
    // Saving the current hosted logo's source again cancels a queued replacement (#96 r2 S2).
    return [
      assertGuard('current_logo_hosted', {
        sql: `EXISTS (SELECT 1 FROM listing_media WHERE listing_id=? AND kind='logo' AND url=?
          AND media_key IS NOT NULL)`,
        params: [listingId, logoUrl]
      }),
      clearQueue
    ]
  }
  const clearLogo: StatementPlan = {
    sql: `DELETE FROM listing_media WHERE listing_id=? AND kind='logo'`,
    params: [listingId]
  }
  if (!logoUrl) return [clearLogo, clearQueue]
  const ingestion = input.ingestion
  if (ingestion && 'hosted' in ingestion) {
    const media = ingestion.hosted
    if (
      media.sourceUrl !== logoUrl ||
      !isListingMediaKey(media.key) ||
      !media.key.includes('/logo/')
    ) {
      throw new Error('The hosted logo must be a logo key for the edited source.')
    }
    return [
      clearLogo,
      clearQueue,
      {
        sql: `INSERT INTO listing_media
          (listing_id,kind,url,sort_order,media_key,sha256,content_type,bytes,width,height)
          VALUES (?,'logo',?,0,?,?,?,?,?,?)`,
        params: [
          listingId,
          logoUrl,
          media.key,
          media.sha256,
          media.contentType,
          media.bytes,
          media.width,
          media.height
        ]
      }
    ]
  }
  if (ingestion && !ingestion.failure.retryable) {
    throw new Error(`A logo that cannot be hosted (${ingestion.failure.code}) is not saved.`)
  }
  const slot = { kind: 'logo' as const, sortOrder: 0, sourceUrl: logoUrl, target: { listingId } }
  return [
    {
      sql: `DELETE FROM listing_media WHERE listing_id=? AND kind='logo' AND media_key IS NULL`,
      params: [listingId]
    },
    clearQueue,
    ...(ingestion
      ? buildRecordMediaFailurePlans({
          ...slot,
          attempts: 1,
          code: ingestion.failure.code,
          now: input.now,
          retryable: true
        })
      : buildQueueMediaPlans({ ...slot, now: input.now }))
  ]
}

/**
 * An admin's edit of a listing's details: name, short description, website, primary category,
 * and logo. It compares and swaps on the checksum the admin saw, so a concurrent change is never
 * overwritten, and writes the publication's checksum. Refused while the listing's own submission
 * is in review (that submission is the listing's edit channel: edit it on the review page) and
 * while its submission stands rejected. The listing moves to `draft` inside the batch so the
 * primary-category triggers allow the change, then back to `approved`. `fields` names what
 * changed, for the activity log.
 *
 * The website and logo are validated and written only when `fields` names them (#64 review):
 * an imported listing keeps the website, site-relative logo, or missing logo it was imported
 * with through any other edit. A changed website or logo follows the submission intake's URL
 * rule, and an emptied logo removes the logo row. A changed logo is written as its hosted copy,
 * or queued for the media cron behind the fallback tile; never as a hotlink (#95).
 */
export function buildUpdateListingDetailsPlans(input: {
  details: ListingDetailsEdit
  expectedChecksum: string
  fields: readonly ListingDetailsField[]
  listingId: string
  /** The changed logo's ingestion outcome (`ListingLogoIngestion`); ignored without a logo change. */
  logoIngestion?: ListingLogoIngestion
  /**
   * The edit re-enters the current hosted logo's source while a replacement is queued: the
   * queued replacement is cancelled and the hosted logo stays (#96 review round 2, S2).
   */
  logoCancelQueued?: boolean
  publication: CatalogPublication
}): StatementPlan[] {
  const { details, listingId } = input
  const changesWebsite = input.fields.includes('website')
  const changesLogo = input.fields.includes('logo')
  for (const field of ['name', 'description', 'categorySlug'] as const) {
    if (!details[field].trim()) throw new Error(`A listing's ${field} cannot be empty.`)
  }
  if (input.fields.length === 0) throw new Error('A listing edit must change something.')
  const website = details.website.trim()
  const logoUrl = details.logoUrl.trim()
  if (changesWebsite && !validatePublicHttpUrl(website).ok) {
    throw new Error('Listing URLs must be public HTTP(S) URLs.')
  }
  if (changesLogo && logoUrl && !validatePublicHttpUrl(logoUrl).ok) {
    throw new Error('Listing URLs must be public HTTP(S) URLs.')
  }
  const category = `(SELECT id FROM categories WHERE slug=? AND is_active=1)`
  // A new website must not collide with another listing, a submission, or a block.
  const conflicts = changesWebsite
    ? Object.values(listingWebsiteConflicts({ listingId, website }))
    : []
  return [
    ...beginCatalogPublicationPlans(input.publication, {
      sql: `EXISTS (SELECT 1 FROM listings WHERE id=? AND status='approved' AND checksum=?)
        AND EXISTS (SELECT 1 FROM categories WHERE slug=? AND is_active=1)
        AND NOT ${listingHasQueuedSubmission('?')} AND NOT ${listingSubmissionRejected('?')}
        ${conflicts.map(conflict => `AND NOT ${conflict.sql}`).join(' ')}`,
      params: [
        listingId,
        input.expectedChecksum,
        details.categorySlug,
        listingId,
        listingId,
        ...conflicts.flatMap(conflict => conflict.params)
      ]
    }),
    {
      sql: `UPDATE listings SET status='draft' WHERE id=? AND status='approved' AND checksum=?`,
      params: [listingId, input.expectedChecksum]
    },
    assertPreviousStatementChangedOne('listing_opened_for_edit'),
    {
      sql: `UPDATE listings SET name=?,description=?,${changesWebsite ? 'website=?,' : ''}
        checksum=?,updated_at=? WHERE id=? AND status='draft'`,
      params: [
        details.name.trim(),
        details.description.trim(),
        ...(changesWebsite ? [website] : []),
        input.publication.afterChecksum,
        input.publication.now,
        listingId
      ]
    },
    assertPreviousStatementChangedOne('listing_details_replaced'),
    {
      sql: `DELETE FROM listing_categories
        WHERE listing_id=? AND is_primary=1 AND category_id IS NOT ${category}`,
      params: [listingId, details.categorySlug]
    },
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        SELECT ?,id,0,1 FROM categories WHERE slug=? AND is_active=1
        ON CONFLICT(listing_id,category_id) DO UPDATE SET is_primary=1,sort_order=0`,
      params: [listingId, details.categorySlug]
    },
    assertPreviousStatementChangedOne('listing_primary_category_set'),
    // A changed logo is hosted or queued, never stored as a hotlink (#95).
    ...(changesLogo
      ? changedLogoPlans({
          cancelQueued: input.logoCancelQueued,
          ingestion: input.logoIngestion,
          listingId,
          logoUrl,
          now: input.publication.now
        })
      : []),
    {
      sql: `UPDATE listings SET status='approved' WHERE id=? AND status='draft'`,
      params: [listingId]
    },
    assertPreviousStatementChangedOne('listing_returned_after_edit'),
    listingEvent(listingId, 'edited', input.publication.actor, { fields: [...input.fields] }),
    ...finishCatalogPublicationPlans(input.publication)
  ]
}
