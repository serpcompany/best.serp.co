import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_SIDE } from './media-format'
import { MAX_MEDIA_BYTES, MEDIA_KINDS, MEDIA_SITE } from './media-keys'

const currentTimestamp = sql`CURRENT_TIMESTAMP`
const booleanCheck = (column: { name: string }) => sql`${sql.identifier(column.name)} IN (0, 1)`
const sqlList = (values: readonly string[]) => sql.raw(values.map(value => `'${value}'`).join(', '))
const LISTING_MEDIA_PREFIX = `${MEDIA_SITE}/listings/`
const SUBMISSION_MEDIA_PREFIX = `${MEDIA_SITE}/submissions/`
const REVISION_MEDIA_PREFIX = `${MEDIA_SITE}/revisions/`
/** `substr(column, 1, n) = 'prefix'` for one of the prefixes, without a LIKE pattern (#77). */
const prefixCheck = (column: { name: string }, prefixes: readonly string[]) =>
  sql.raw(
    `(${prefixes
      .map(prefix => `substr("${column.name}", 1, ${prefix.length}) = '${prefix}'`)
      .join(' OR ')})`
  )

/**
 * Who added a listing (serpcompany/best.serp.co#62). `admin` covers the imported catalog and
 * publication manifests; `submission` is a listing promoted from `listing_submissions`.
 */
export const listingSources = ['admin', 'submission'] as const
export type ListingSource = (typeof listingSources)[number]

/** The `rel` of our outbound link to the listing's website, an admin setting per listing. */
export const listingLinkRels = ['follow', 'nofollow', 'sponsored'] as const
export type ListingLinkRel = (typeof listingLinkRels)[number]

/**
 * Submission lifecycle (docs/submission-flow.md). `draft` is saved with no plan chosen yet
 * (or paid chosen and checkout not completed); `pending_badge` means free was chosen and the
 * badge is not verified yet. `verified` and `paid_pending_review` are the review queue;
 * `paid_pending_review` is the only queue state whose listing is already live.
 */
export const submissionStatuses = [
  'draft',
  'pending_badge',
  'verified',
  'paid_pending_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn'
] as const
export type SubmissionStatus = (typeof submissionStatuses)[number]

/** Statuses that hold the submission's normalized URL key against duplicates. */
export const activeSubmissionStatuses = [
  'draft',
  'pending_badge',
  'verified',
  'paid_pending_review',
  'changes_requested'
] as const satisfies readonly SubmissionStatus[]

export const submissionPlans = ['free', 'paid'] as const
export type SubmissionPlan = (typeof submissionPlans)[number]

/** `prohibited` (by the Terms: no refund, URL blocked) or `other` (refund, may resubmit). */
export const rejectionCategories = ['prohibited', 'other'] as const
export type RejectionCategory = (typeof rejectionCategories)[number]

export const submissionEventTypes = [
  'created',
  'verification_failed',
  'badge_verified',
  'approved',
  'rejected',
  'edited',
  'resubmitted',
  'changes_requested',
  'withdrawn',
  'paid',
  'refunded',
  'unpublished',
  'plan_chosen',
  'expired'
] as const
export type SubmissionEventType = (typeof submissionEventTypes)[number]

/**
 * Why a submission is `withdrawn`: by its owner (only before payment), automatically when its
 * draft expired, or by an admin clearing a draft.
 */
export const withdrawalReasons = ['owner', 'expired', 'admin'] as const
export type WithdrawalReason = (typeof withdrawalReasons)[number]

/**
 * An ISO instant exactly as `Date#toISOString()` writes it, so instants compare as text. A round
 * trip through `strftime` rather than a GLOB: D1 limits LIKE and GLOB patterns to 50 bytes, and
 * `IS` (not `=`) makes a value strftime cannot parse fail the CHECK instead of passing as NULL.
 * A NULL value passes (NULL IS NULL).
 */
const isoInstantCheck = (column: { name: string }) =>
  sql`${sql.identifier(column.name)} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${sql.identifier(column.name)})`

/** How many tags a Creator may suggest on a submission or revision (#341). */
export const MAX_SUGGESTED_TAGS = 3

/** A JSON array of at most `MAX_SUGGESTED_TAGS` entries, or NULL ("not given"). */
const tagSlugsCheck = (column: { name: string }) => {
  const value = sql.identifier(column.name)
  return sql`${value} IS NULL OR (json_valid(${value}) AND json_type(${value}) = 'array' AND json_array_length(${value}) <= ${sql.raw(String(MAX_SUGGESTED_TAGS))})`
}

export const listingOwnerRoles = ['owner'] as const
/**
 * How a listing's owner was established: their approved submission, a badge or paid claim (#67),
 * or an admin who transferred the listing to them (#64).
 */
export const listingOwnerVerifications = [
  'submission',
  'badge_claim',
  'paid_claim',
  'admin'
] as const
export type ListingOwnerVerification = (typeof listingOwnerVerifications)[number]

export const revisionStatuses = [
  'pending_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn'
] as const
export type RevisionStatus = (typeof revisionStatuses)[number]

/** A listing has at most one revision in these statuses. */
export const openRevisionStatuses = [
  'pending_review',
  'changes_requested'
] as const satisfies readonly RevisionStatus[]

export const revisionEventTypes = [
  'created',
  'edited',
  'changes_requested',
  'resubmitted',
  'withdrawn',
  'approved',
  'rejected'
] as const
export type RevisionEventType = (typeof revisionEventTypes)[number]

/**
 * The listing activity log (#64): admin and ownership changes of a listing, each written by the
 * plan that makes the change (`listing-plans.ts`). Submission decisions stay in
 * `listing_submission_events`.
 */
export const listingEventTypes = [
  'edited',
  'unpublished',
  'republished',
  'link_rel_changed',
  'owner_granted',
  'owner_revoked',
  'owner_transferred'
] as const
export type ListingEventType = (typeof listingEventTypes)[number]

export const badgeCheckOutcomes = ['pass', 'fail'] as const
export type BadgeCheckOutcome = (typeof badgeCheckOutcomes)[number]
/**
 * Which pass of the badge program (#66) made a check: the `weekly` check, the `confirmation`
 * recheck about 24 hours after a weekly conclusive miss, or the one-off `refund` check of a paid
 * listing being refunded (#68, owner decision 2026-10-06: a pass keeps it as a free listing).
 * Only a weekly conclusive miss opens a warning; a confirmation miss is recorded in the same
 * batch as its unpublish or revocation.
 */
export const badgeCheckKinds = ['weekly', 'confirmation', 'refund'] as const
export type BadgeCheckKind = (typeof badgeCheckKinds)[number]

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('categories_slug_unique').on(table.slug),
    check('categories_is_active_boolean', booleanCheck(table.isActive)),
    index('categories_public_idx').on(table.isActive, table.sortOrder, table.name)
  ]
)

export const listings = sqliteTable(
  'listings',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    website: text('website').notNull(),
    content: text('content'),
    entityType: text('entity_type'),
    priority: text('priority', { enum: ['high', 'medium', 'low'] }),
    isUnofficial: integer('is_unofficial', { mode: 'boolean' }).notNull().default(false),
    isFeatured: integer('is_featured', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    status: text('status', { enum: ['draft', 'review', 'approved', 'rejected'] })
      .notNull()
      .default('draft'),
    publishedAt: text('published_at'),
    sourceKind: text('source_kind').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    sourceUpdatedAt: text('source_updated_at'),
    checksum: text('checksum').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp),
    displayOrder: integer('display_order').notNull().default(0),
    source: text('source', { enum: listingSources }).notNull().default('admin'),
    linkRel: text('link_rel', { enum: listingLinkRels }).notNull().default('follow')
  },
  table => [
    unique('listings_slug_unique').on(table.slug),
    check('listings_source_valid', sql`${table.source} IN (${sqlList(listingSources)})`),
    check('listings_link_rel_valid', sql`${table.linkRel} IN (${sqlList(listingLinkRels)})`),
    check(
      'listings_priority_valid',
      sql`${table.priority} IS NULL OR ${table.priority} IN ('high', 'medium', 'low')`
    ),
    check('listings_is_unofficial_boolean', booleanCheck(table.isUnofficial)),
    check('listings_is_featured_boolean', booleanCheck(table.isFeatured)),
    check('listings_is_active_boolean', booleanCheck(table.isActive)),
    check(
      'listings_status_valid',
      sql`${table.status} IN ('draft', 'review', 'approved', 'rejected')`
    ),
    check('listings_display_order_nonnegative', sql`${table.displayOrder} >= 0`),
    index('listings_publication_idx').on(
      table.status,
      table.isActive,
      sql`${table.publishedAt} DESC`,
      table.displayOrder,
      table.slug
    ),
    index('listings_featured_idx').on(
      table.status,
      table.isActive,
      table.isFeatured,
      sql`${table.publishedAt} DESC`,
      table.displayOrder
    ),
    // #77: `MAX(display_order)` for a new listing (approval, payment, publisher) and the
    // submission duplicate check on `website` were full scans of `listings`.
    index('listings_display_order_idx').on(table.displayOrder),
    index('listings_website_idx').on(table.website),
    index('listings_related_name_idx')
      .on(table.name, table.slug)
      .where(
        sql`${table.status} = 'approved' AND ${table.isActive} = 1 AND ${table.publishedAt} IS NOT NULL`
      )
  ]
)

export const listingCategories = sqliteTable(
  'listing_categories',
  {
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false)
  },
  table => [
    primaryKey({ columns: [table.listingId, table.categoryId] }),
    check('listing_categories_is_primary_boolean', booleanCheck(table.isPrimary)),
    uniqueIndex('listing_categories_one_primary_idx')
      .on(table.listingId)
      .where(sql`${table.isPrimary} = 1`),
    index('listing_categories_category_idx').on(table.categoryId, table.listingId),
    index('listing_categories_listing_order_idx').on(table.listingId, table.sortOrder)
  ]
)

/**
 * The three-layer taxonomy (serpcompany/best.serp.co#341): a category is a broad topic hub, a tag
 * a finer grouping inside one hub that a listing may carry many of, and a best page a ranked list
 * at `/best/<slug>/` that targets one search phrase. The triggers of `0013_taxonomy_triggers` keep
 * an active tag under an active hub and a membership off a retired tag.
 */
export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `/products/tags/<slug>/`; a retired narrow category's slug is reused as its tag's. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The tag's hub. */
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('tags_slug_unique').on(table.slug),
    check('tags_is_active_boolean', booleanCheck(table.isActive)),
    index('tags_category_idx').on(table.categoryId, table.isActive, table.sortOrder, table.name)
  ]
)

/** A listing's tags, with no primary; `sort_order` 0 is the tag most central to the listing. */
export const listingTags = sqliteTable(
  'listing_tags',
  {
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    primaryKey({ columns: [table.listingId, table.tagId] }),
    index('listing_tags_tag_idx').on(table.tagId, table.listingId)
  ]
)

/** How many listings a best page shows (`list_size`), and its default. */
export const BEST_PAGE_LIST_SIZE = { default: 10, max: 25, min: 5 } as const

/**
 * A keyword-targeted ranking at `/best/<slug>/`. Its pool is the public listings with its tag, in
 * its category, or both together; `best_page_listings` pins the top positions and excludes misfits.
 * `keyword_volume` and `keyword_checked_at` record the keyword check, for the audit trail only.
 */
export const bestPages = sqliteTable(
  'best_pages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The keyword, slugified. */
    slug: text('slug').notNull(),
    /** The exact search phrase. */
    keyword: text('keyword').notNull(),
    /** The `<title>`, without the site suffix. */
    title: text('title').notNull(),
    heading: text('heading').notNull(),
    intro: text('intro').notNull(),
    tagId: integer('tag_id').references(() => tags.id, { onDelete: 'restrict' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    listSize: integer('list_size').notNull().default(BEST_PAGE_LIST_SIZE.default),
    keywordVolume: integer('keyword_volume'),
    keywordCheckedAt: text('keyword_checked_at'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('best_pages_slug_unique').on(table.slug),
    check(
      'best_pages_list_size_range',
      sql`${table.listSize} BETWEEN ${sql.raw(String(BEST_PAGE_LIST_SIZE.min))} AND ${sql.raw(String(BEST_PAGE_LIST_SIZE.max))}`
    ),
    check('best_pages_pool', sql`${table.tagId} IS NOT NULL OR ${table.categoryId} IS NOT NULL`),
    check('best_pages_is_active_boolean', booleanCheck(table.isActive)),
    check('best_pages_keyword_checked_at_iso', isoInstantCheck(table.keywordCheckedAt)),
    index('best_pages_tag_idx').on(table.tagId),
    index('best_pages_category_idx').on(table.categoryId)
  ]
)

/**
 * A best page's editorial pins (`position` 1 is the top, with an optional `blurb`) and exclusions
 * (`excluded`, no position). Every term is NOT NULL-checked, because a CHECK that evaluates to
 * NULL passes.
 */
export const bestPageListings = sqliteTable(
  'best_page_listings',
  {
    bestPageId: integer('best_page_id')
      .notNull()
      .references(() => bestPages.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    position: integer('position'),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    blurb: text('blurb')
  },
  table => [
    primaryKey({ columns: [table.bestPageId, table.listingId] }),
    check('best_page_listings_excluded_boolean', booleanCheck(table.excluded)),
    check(
      'best_page_listings_pin_or_exclusion',
      sql`(${table.excluded} = 0 AND ${table.position} IS NOT NULL AND ${table.position} >= 1)
        OR (${table.excluded} = 1 AND ${table.position} IS NULL AND ${table.blurb} IS NULL)`
    ),
    uniqueIndex('best_page_listings_position_idx')
      .on(table.bestPageId, table.position)
      .where(sql`${table.position} IS NOT NULL`),
    index('best_page_listings_listing_idx').on(table.listingId)
  ]
)

/** What an old taxonomy URL was: `/products/categories/<slug>/`, a tag page, or a best page. */
export const taxonomyRedirectSourceKinds = ['category', 'tag', 'best'] as const
export type TaxonomyRedirectSourceKind = (typeof taxonomyRedirectSourceKinds)[number]
/** Where it now points: a category, tag, or best page, or the directory (`/products/`). */
export const taxonomyRedirectTargetKinds = ['category', 'tag', 'best', 'directory'] as const
export type TaxonomyRedirectTargetKind = (typeof taxonomyRedirectTargetKinds)[number]

/**
 * Permanent redirects of retired or renamed taxonomy URLs, written by reviewed manifests. The
 * target is a foreign key, not a path, so a target renamed later keeps the redirect pointing at
 * its current URL, as `listing_slug_redirects` does for listings. Exactly the target column of
 * `target_kind` is set (none for `directory`).
 */
export const taxonomyRedirects = sqliteTable(
  'taxonomy_redirects',
  {
    sourceKind: text('source_kind', { enum: taxonomyRedirectSourceKinds }).notNull(),
    sourceSlug: text('source_slug').notNull(),
    targetKind: text('target_kind', { enum: taxonomyRedirectTargetKinds }).notNull(),
    targetCategoryId: integer('target_category_id').references(() => categories.id, {
      onDelete: 'restrict'
    }),
    targetTagId: integer('target_tag_id').references(() => tags.id, { onDelete: 'restrict' }),
    targetBestPageId: integer('target_best_page_id').references(() => bestPages.id, {
      onDelete: 'restrict'
    }),
    manifestId: text('manifest_id').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    primaryKey({ columns: [table.sourceKind, table.sourceSlug] }),
    check(
      'taxonomy_redirects_source_kind_valid',
      sql`${table.sourceKind} IN (${sqlList(taxonomyRedirectSourceKinds)})`
    ),
    check(
      'taxonomy_redirects_target_kind_valid',
      sql`${table.targetKind} IN (${sqlList(taxonomyRedirectTargetKinds)})`
    ),
    check(
      'taxonomy_redirects_target_matches_kind',
      sql`(${table.targetKind} = 'category' AND ${table.targetCategoryId} IS NOT NULL
          AND ${table.targetTagId} IS NULL AND ${table.targetBestPageId} IS NULL)
        OR (${table.targetKind} = 'tag' AND ${table.targetTagId} IS NOT NULL
          AND ${table.targetCategoryId} IS NULL AND ${table.targetBestPageId} IS NULL)
        OR (${table.targetKind} = 'best' AND ${table.targetBestPageId} IS NOT NULL
          AND ${table.targetCategoryId} IS NULL AND ${table.targetTagId} IS NULL)
        OR (${table.targetKind} = 'directory' AND ${table.targetCategoryId} IS NULL
          AND ${table.targetTagId} IS NULL AND ${table.targetBestPageId} IS NULL)`
    ),
    // Full indexes on the target foreign keys, so deleting a target is a seek (#77).
    index('taxonomy_redirects_target_category_idx').on(table.targetCategoryId),
    index('taxonomy_redirects_target_tag_idx').on(table.targetTagId),
    index('taxonomy_redirects_target_best_page_idx').on(table.targetBestPageId)
  ]
)

/**
 * A hosted image's key and metadata, all present or all absent (serpcompany/best.serp.co#95).
 * The key is `best.serp.co/listings/<slug>/<logo|image>/<sha256-16>.<ext>` in the environment's
 * media bucket; the CHECK keeps its prefix and kind honest without a LIKE pattern (#77). Every
 * term is NOT NULL-checked, because a CHECK that evaluates to NULL passes.
 */
const hostedMediaCheck = (
  table: {
    bytes: { name: string }
    contentType: { name: string }
    height: { name: string }
    kind: { name: string }
    mediaKey: { name: string }
    sha256: { name: string }
    width: { name: string }
  },
  prefixes: readonly string[]
) => {
  const column = (value: { name: string }) => sql.identifier(value.name)
  return sql`(${column(table.mediaKey)} IS NULL AND ${column(table.sha256)} IS NULL
    AND ${column(table.contentType)} IS NULL AND ${column(table.bytes)} IS NULL
    AND ${column(table.width)} IS NULL AND ${column(table.height)} IS NULL)
    OR (${column(table.mediaKey)} IS NOT NULL AND ${column(table.sha256)} IS NOT NULL
    AND ${column(table.contentType)} IS NOT NULL AND ${column(table.bytes)} IS NOT NULL
    AND ${column(table.width)} IS NOT NULL AND ${column(table.height)} IS NOT NULL
    AND ${prefixCheck(table.mediaKey, prefixes)}
    AND instr(${column(table.mediaKey)}, '/' || ${column(table.kind)} || '/') > 0
    AND length(${column(table.sha256)}) = 64
    AND ${column(table.contentType)} IN (${sqlList(Object.values(IMAGE_CONTENT_TYPES))})
    AND ${column(table.bytes)} BETWEEN 1 AND ${sql.raw(String(MAX_MEDIA_BYTES))}
    AND ${column(table.width)} BETWEEN 1 AND ${sql.raw(String(MAX_IMAGE_SIDE))}
    AND ${column(table.height)} BETWEEN 1 AND ${sql.raw(String(MAX_IMAGE_SIDE))})`
}

/**
 * Listing logos, images, and videos. `url` is where the media came from; a row with a
 * `media_key` is hosted in the environment's media bucket and renders from the media host
 * (serpcompany/best.serp.co#95). A logo or image row without a key is an imported reference the
 * legacy media migration has not repointed yet.
 */
export const listingMedia = sqliteTable(
  'listing_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['logo', 'image', 'video'] }).notNull(),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    mediaKey: text('media_key'),
    sha256: text('sha256'),
    contentType: text('content_type'),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height')
  },
  table => [
    check('listing_media_kind_valid', sql`${table.kind} IN ('logo', 'image', 'video')`),
    unique('listing_media_listing_kind_order_unique').on(
      table.listingId,
      table.kind,
      table.sortOrder
    ),
    check('listing_media_hosted_complete', hostedMediaCheck(table, [LISTING_MEDIA_PREFIX]))
  ]
)

/**
 * Media still to be hosted (serpcompany/best.serp.co#95): one row per listing, submission, or
 * revision image slot whose source has not been copied into the media bucket yet. A Worker cron
 * retries `pending` rows with backoff; `failed` rows stopped retrying. A submission's or a
 * revision's slot becomes `hosted` (its key under `best.serp.co/submissions/<id>/` or
 * `best.serp.co/revisions/<id>/`) so its approval can queue a copy into the listing's path; a listing's slot is deleted once its
 * `listing_media` row is hosted. An admin edit, an approval, or a publication that changes a
 * slot's media replaces or deletes the row, and the cron writes only while its claim holds.
 */
export const mediaIngestionStatuses = ['pending', 'hosted', 'failed'] as const
export type MediaIngestionStatus = (typeof mediaIngestionStatuses)[number]

export const mediaIngestions = sqliteTable(
  'media_ingestions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id').references(() => listings.id, { onDelete: 'cascade' }),
    submissionId: text('submission_id').references(() => listingSubmissions.id, {
      onDelete: 'cascade'
    }),
    /** A listing revision's new logo, hosted when the revision is saved (#96 round 4). */
    revisionId: text('revision_id').references(() => listingRevisions.id, {
      onDelete: 'cascade'
    }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    sourceUrl: text('source_url').notNull(),
    /**
     * For a listing slot adopted from an approved submission or revision: its reviewed hosted
     * key, which the cron copies into the listing's path instead of fetching the source again.
     */
    copyFromKey: text('copy_from_key'),
    status: text('status', { enum: mediaIngestionStatuses }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    mediaKey: text('media_key'),
    sha256: text('sha256'),
    contentType: text('content_type'),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height'),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    check(
      'media_ingestions_one_target',
      sql`(${table.listingId} IS NOT NULL) + (${table.submissionId} IS NOT NULL) + (${table.revisionId} IS NOT NULL) = 1`
    ),
    check('media_ingestions_kind_valid', sql`${table.kind} IN (${sqlList(MEDIA_KINDS)})`),
    check(
      'media_ingestions_status_valid',
      sql`${table.status} IN (${sqlList(mediaIngestionStatuses)})`
    ),
    check('media_ingestions_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check(
      'media_ingestions_pending_scheduled',
      sql`(${table.status} = 'pending') = (${table.nextAttemptAt} IS NOT NULL)`
    ),
    check(
      'media_ingestions_next_attempt_iso',
      sql`${table.nextAttemptAt} IS NULL OR ${isoInstantCheck(table.nextAttemptAt)}`
    ),
    check(
      'media_ingestions_failed_explained',
      sql`${table.status} != 'failed' OR ${table.lastError} IS NOT NULL`
    ),
    check(
      'media_ingestions_hosted_result',
      sql`(${table.status} = 'hosted') = (${table.mediaKey} IS NOT NULL)`
    ),
    check(
      'media_ingestions_hosted_complete',
      hostedMediaCheck(table, [
        LISTING_MEDIA_PREFIX,
        SUBMISSION_MEDIA_PREFIX,
        REVISION_MEDIA_PREFIX
      ])
    ),
    check(
      'media_ingestions_copy_from_pending',
      sql`${table.copyFromKey} IS NULL OR (${table.listingId} IS NOT NULL AND ${prefixCheck(table.copyFromKey, [SUBMISSION_MEDIA_PREFIX, REVISION_MEDIA_PREFIX])})`
    ),
    uniqueIndex('media_ingestions_listing_slot_idx')
      .on(table.listingId, table.kind, table.sortOrder)
      .where(sql`${table.listingId} IS NOT NULL`),
    uniqueIndex('media_ingestions_submission_slot_idx')
      .on(table.submissionId, table.kind, table.sortOrder)
      .where(sql`${table.submissionId} IS NOT NULL`),
    uniqueIndex('media_ingestions_revision_slot_idx')
      .on(table.revisionId, table.kind, table.sortOrder)
      .where(sql`${table.revisionId} IS NOT NULL`),
    index('media_ingestions_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`)
  ]
)

export const listingResourceLinks = sqliteTable(
  'listing_resource_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    unique('listing_resource_links_listing_order_unique').on(table.listingId, table.sortOrder)
  ]
)

export const listingFaqs = sqliteTable(
  'listing_faqs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [unique('listing_faqs_listing_order_unique').on(table.listingId, table.sortOrder)]
)

export const publicationState = sqliteTable(
  'publication_state',
  {
    id: integer('id').primaryKey().default(1),
    version: integer('version').notNull().default(0),
    manifestId: text('manifest_id'),
    checksum: text('checksum').notNull(),
    publishedAt: text('published_at').notNull().default(currentTimestamp)
  },
  table => [
    check('publication_state_singleton', sql`${table.id} = 1`),
    check('publication_state_version_nonnegative', sql`${table.version} >= 0`)
  ]
)

export const migrationRuns = sqliteTable(
  'migration_runs',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    manifestIdentity: text('manifest_identity').notNull(),
    inputChecksum: text('input_checksum').notNull(),
    targetChecksum: text('target_checksum').notNull(),
    affectedRecords: integer('affected_records').notNull(),
    outcome: text('outcome', { enum: ['started', 'succeeded', 'failed'] }).notNull(),
    error: text('error'),
    startedAt: text('started_at').notNull().default(currentTimestamp),
    completedAt: text('completed_at')
  },
  table => [
    unique('migration_runs_manifest_unique').on(table.manifestIdentity),
    check(
      'migration_runs_outcome_valid',
      sql`${table.outcome} IN ('started', 'succeeded', 'failed')`
    ),
    index('migration_runs_time_idx').on(sql`${table.startedAt} DESC`)
  ]
)

export const publicationRuns = sqliteTable(
  'publication_runs',
  {
    id: text('id').primaryKey(),
    manifestId: text('manifest_id').notNull(),
    baseVersion: integer('base_version').notNull(),
    publishedVersion: integer('published_version'),
    inputChecksum: text('input_checksum').notNull(),
    affectedRecords: integer('affected_records').notNull().default(0),
    affectedRoutes: text('affected_routes').notNull().default(''),
    outcome: text('outcome', { enum: ['started', 'succeeded', 'failed'] }).notNull(),
    error: text('error'),
    startedAt: text('started_at').notNull().default(currentTimestamp),
    completedAt: text('completed_at'),
    actor: text('actor'),
    workflow: text('workflow'),
    beforeChecksum: text('before_checksum'),
    afterChecksum: text('after_checksum')
  },
  table => [
    unique('publication_runs_manifest_unique').on(table.manifestId),
    check(
      'publication_runs_outcome_valid',
      sql`${table.outcome} IN ('started', 'succeeded', 'failed')`
    ),
    index('publication_runs_time_idx').on(sql`${table.startedAt} DESC`)
  ]
)

/**
 * Old listing slugs and the listing each answers 308 to (`listing_id`, followed to its current
 * slug; `new_slug` is that slug when the row was written): the listing itself after a rename
 * (`listing-slug-change`), or another live listing for an unpublished duplicate
 * (`listing-slug-redirect`, #338). The product page reads it before it renders the 410 page.
 */
export const listingSlugRedirects = sqliteTable(
  'listing_slug_redirects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    manifestId: text('manifest_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('listing_slug_redirects_old_slug_unique').on(table.oldSlug),
    check('listing_slug_redirects_slug_change', sql`${table.oldSlug} != ${table.newSlug}`),
    index('listing_slug_redirects_listing_idx').on(table.listingId, sql`${table.createdAt} DESC`)
  ]
)

export const listingSubmissions = sqliteTable(
  'listing_submissions',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    website: text('website').notNull(),
    content: text('content').notNull(),
    categorySlug: text('category_slug').notNull(),
    logoUrl: text('logo_url').notNull(),
    videoUrl: text('video_url'),
    /**
     * Defaults to the legacy free flow, as before #62, so a Worker deployed before this migration
     * keeps inserting valid rows between migrate and deploy. Native intake (#63) writes `draft`.
     */
    status: text('status', { enum: submissionStatuses }).notNull().default('pending_badge'),
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    lastVerificationAt: text('last_verification_at'),
    lastVerificationError: text('last_verification_error'),
    badgeVerifiedAt: text('badge_verified_at'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
    listingId: text('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** The plan the submitter chose; null only while a draft has not chosen one. */
    plan: text('plan', { enum: submissionPlans }).default('free'),
    paidAt: text('paid_at'),
    refundedAt: text('refunded_at'),
    reviewerNote: text('reviewer_note'),
    rejectionReason: text('rejection_reason'),
    rejectionCategory: text('rejection_category', { enum: rejectionCategories }),
    /**
     * When the submission was first saved as a draft: the start of the 30-day draft clock and of
     * the reminder schedule. Edits never reset it. Null for rows that were never drafts.
     */
    draftSavedAt: text('draft_saved_at'),
    /** How many of the five draft reminders have been claimed (`draft-plans.ts`). */
    draftRemindersSent: integer('draft_reminders_sent').notNull().default(0),
    draftLastReminderAt: text('draft_last_reminder_at'),
    withdrawalReason: text('withdrawal_reason', { enum: withdrawalReasons }),
    /**
     * What a prohibited rejection blocks (`urlKey()` in `@/lib/url-key`): the
     * registrable domain of `slug`, covering its subdomains, or the host itself when it has no
     * registrable domain (a public suffix such as `github.io`, or an IP address). Null only on
     * rows written before #62 (or by a pre-#62 Worker), which block their exact host.
     */
    blockKey: text('block_key'),
    /** Whether a block on `block_key` covers its subdomains (false: the exact host only). */
    blockCoversSubdomains: integer('block_covers_subdomains', { mode: 'boolean' }),
    /** The listing checksum written when a paid submission was published before review. */
    publishedChecksum: text('published_checksum'),
    /** Increments on every edit of the staged content; approval compares and swaps on it. */
    contentVersion: integer('content_version').notNull().default(1),
    /** The Creator's suggested tags (#341): a JSON array of tag slugs, or null when not given. */
    tagSlugs: text('tag_slugs')
  },
  table => [
    check(
      'listing_submissions_status_valid',
      sql`${table.status} IN (${sqlList(submissionStatuses)})`
    ),
    check(
      'listing_submissions_verification_attempts_nonnegative',
      sql`${table.verificationAttempts} >= 0`
    ),
    check(
      'listing_submissions_plan_valid',
      sql`${table.plan} IS NULL OR ${table.plan} IN (${sqlList(submissionPlans)})`
    ),
    check(
      'listing_submissions_plan_chosen',
      sql`${table.status} IN ('draft', 'withdrawn') OR ${table.plan} IS NOT NULL`
    ),
    check(
      'listing_submissions_draft_unpaid',
      sql`${table.status} != 'draft' OR (${table.paidAt} IS NULL AND ${table.listingId} IS NULL)`
    ),
    check(
      'listing_submissions_pending_badge_free',
      sql`${table.status} != 'pending_badge' OR ${table.plan} = 'free'`
    ),
    check(
      'listing_submissions_payment_matches_plan',
      sql`${table.paidAt} IS NULL OR ${table.plan} = 'paid' OR ${table.refundedAt} IS NOT NULL`
    ),
    check(
      'listing_submissions_refund_after_payment',
      sql`${table.refundedAt} IS NULL OR ${table.paidAt} IS NOT NULL`
    ),
    check(
      'listing_submissions_verified_qualified',
      sql`${table.status} != 'verified' OR ${table.plan} = 'free' OR ${table.paidAt} IS NOT NULL`
    ),
    check(
      'listing_submissions_rejection_category_valid',
      sql`${table.rejectionCategory} IS NULL OR ${table.rejectionCategory} IN (${sqlList(rejectionCategories)})`
    ),
    check(
      'listing_submissions_rejection_complete',
      sql`(${table.rejectionReason} IS NULL) = (${table.rejectionCategory} IS NULL)`
    ),
    check(
      'listing_submissions_rejection_when_rejected',
      sql`${table.rejectionCategory} IS NULL OR ${table.status} = 'rejected'`
    ),
    check(
      'listing_submissions_live_review_paid',
      sql`${table.status} != 'paid_pending_review' OR (${table.listingId} IS NOT NULL AND ${table.plan} = 'paid' AND ${table.paidAt} IS NOT NULL AND ${table.refundedAt} IS NULL AND ${table.publishedChecksum} IS NOT NULL)`
    ),
    check(
      'listing_submissions_draft_plan',
      sql`${table.status} != 'draft' OR ${table.plan} IS NULL OR ${table.plan} = 'paid'`
    ),
    check(
      'listing_submissions_draft_native',
      sql`${table.status} != 'draft' OR (${table.ownerUserId} IS NOT NULL AND ${table.blockKey} IS NOT NULL)`
    ),
    check(
      'listing_submissions_block_key_matches',
      sql`${table.blockKey} IS NULL OR ${table.slug} = ${table.blockKey} OR substr(${table.slug}, -1 - length(${table.blockKey})) = '.' || ${table.blockKey}`
    ),
    check(
      'listing_submissions_block_scope',
      sql`(${table.blockKey} IS NULL) = (${table.blockCoversSubdomains} IS NULL) AND (${table.blockCoversSubdomains} IS NOT 0 OR ${table.blockKey} = ${table.slug})`
    ),
    check(
      'listing_submissions_block_covers_subdomains_boolean',
      sql`${table.blockCoversSubdomains} IS NULL OR ${table.blockCoversSubdomains} IN (0, 1)`
    ),
    check(
      'listing_submissions_withdrawn_unpaid',
      sql`${table.status} != 'withdrawn' OR ${table.paidAt} IS NULL OR ${table.refundedAt} IS NOT NULL`
    ),
    check(
      'listing_submissions_no_refund_when_prohibited',
      sql`${table.refundedAt} IS NULL OR ${table.rejectionCategory} IS NULL OR ${table.rejectionCategory} != 'prohibited'`
    ),
    check('listing_submissions_content_version_positive', sql`${table.contentVersion} >= 1`),
    check(
      'listing_submissions_draft_clock',
      sql`${table.status} != 'draft' OR ${table.draftSavedAt} IS NOT NULL`
    ),
    check('listing_submissions_draft_saved_at_iso', isoInstantCheck(table.draftSavedAt)),
    check(
      'listing_submissions_draft_reminders_range',
      sql`${table.draftRemindersSent} BETWEEN 0 AND 5`
    ),
    check(
      'listing_submissions_draft_reminder_recorded',
      sql`(${table.draftRemindersSent} = 0) = (${table.draftLastReminderAt} IS NULL)`
    ),
    check(
      'listing_submissions_withdrawal_reason_valid',
      sql`${table.withdrawalReason} IS NULL OR ${table.withdrawalReason} IN (${sqlList(withdrawalReasons)})`
    ),
    check(
      'listing_submissions_withdrawal_reason_when_withdrawn',
      sql`(${table.status} = 'withdrawn') = (${table.withdrawalReason} IS NOT NULL)`
    ),
    check('listing_submissions_tag_slugs_valid', tagSlugsCheck(table.tagSlugs)),
    uniqueIndex('listing_submissions_active_slug_idx')
      .on(table.slug)
      .where(sql`${table.status} IN (${sqlList(activeSubmissionStatuses)})`),
    index('listing_submissions_review_queue_idx').on(
      table.status,
      table.badgeVerifiedAt,
      table.createdAt
    ),
    index('listing_submissions_owner_idx')
      .on(table.ownerUserId, table.createdAt)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    index('listing_submissions_listing_idx')
      .on(table.listingId)
      .where(sql`${table.listingId} IS NOT NULL`),
    index('listing_submissions_draft_clock_idx')
      .on(table.draftSavedAt)
      .where(sql`${table.status} = 'draft'`)
  ]
)

export const listingSubmissionResourceLinks = sqliteTable(
  'listing_submission_resource_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    submissionId: text('submission_id')
      .notNull()
      .references(() => listingSubmissions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    unique('listing_submission_resource_links_submission_order_unique').on(
      table.submissionId,
      table.sortOrder
    )
  ]
)

export const listingSubmissionFaqs = sqliteTable(
  'listing_submission_faqs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    submissionId: text('submission_id')
      .notNull()
      .references(() => listingSubmissions.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    unique('listing_submission_faqs_submission_order_unique').on(
      table.submissionId,
      table.sortOrder
    )
  ]
)

export const listingSubmissionEvents = sqliteTable(
  'listing_submission_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    submissionId: text('submission_id')
      .notNull()
      .references(() => listingSubmissions.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: submissionEventTypes }).notNull(),
    detail: text('detail'),
    actor: text('actor').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check(
      'listing_submission_events_type_valid',
      sql`${table.eventType} IN (${sqlList(submissionEventTypes)})`
    ),
    index('listing_submission_events_submission_idx').on(table.submissionId, table.createdAt)
  ]
)

export const listingSubmissionRateLimits = sqliteTable(
  'listing_submission_rate_limits',
  {
    fingerprintHash: text('fingerprint_hash').primaryKey(),
    windowStartedAt: integer('window_started_at').notNull(),
    requestCount: integer('request_count').notNull()
  },
  table => [
    check(
      'listing_submission_rate_limits_request_count_nonnegative',
      sql`${table.requestCount} >= 0`
    )
  ]
)

/**
 * The idempotency ledger for transactional email (`apps/web/src/lib/email/`): one row per template
 * and event key, claimed atomically before a send so a retried event never sends the same
 * email twice. Rows hold no recipient, subject, or body; event keys may not contain an email
 * address. Timestamps use SQLite's `YYYY-MM-DD HH:MM:SS` (UTC).
 */
export const emailDeliveries = sqliteTable(
  'email_deliveries',
  {
    templateId: text('template_id').notNull(),
    eventKey: text('event_key').notNull(),
    provider: text('provider').notNull(),
    status: text('status', { enum: ['sending', 'sent', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(1),
    providerMessageId: text('provider_message_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    primaryKey({ columns: [table.templateId, table.eventKey] }),
    check(
      'email_deliveries_event_key_valid',
      sql`length(${table.eventKey}) BETWEEN 3 AND 200 AND instr(${table.eventKey}, '@') = 0`
    ),
    check('email_deliveries_status_valid', sql`${table.status} IN ('sending', 'sent', 'failed')`),
    check('email_deliveries_attempts_positive', sql`${table.attempts} >= 1`)
  ]
)

/**
 * Better Auth tables (serpcompany/best.serp.co#60). Property names are Better Auth's field
 * names, which its Drizzle adapter reads; columns are snake_case like the rest of the schema.
 * Timestamps are epoch milliseconds (`timestamp_ms`), as Better Auth's own SQLite schema
 * generator writes them. `apps/web/src/db/auth.ts` passes exactly these tables to the
 * adapter and `auth.test.ts` checks them against Better Auth's expected schema.
 */
const epochMillisecondsNow = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

export const userRoles = ['user', 'admin'] as const

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    role: text('role', { enum: userRoles }).notNull().default('user'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow)
      .$onUpdate(() => new Date())
  },
  table => [
    unique('users_email_unique').on(table.email),
    check('users_email_verified_boolean', booleanCheck(table.emailVerified)),
    check('users_role_valid', sql`${table.role} IN ('user', 'admin')`)
  ]
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow)
      .$onUpdate(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
  },
  table => [
    unique('sessions_token_unique').on(table.token),
    index('sessions_user_idx').on(table.userId)
  ]
)

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow)
      .$onUpdate(() => new Date())
  },
  table => [index('accounts_user_idx').on(table.userId)]
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(epochMillisecondsNow)
      .$onUpdate(() => new Date())
  },
  table => [index('verification_identifier_idx').on(table.identifier)]
)

/**
 * Admins are signed-in users whose verified email is listed here (#59). The first row,
 * devin@serp.co, is seeded by the migration that creates the table. Emails are stored
 * lowercase, the form Better Auth stores user emails in.
 */
export const adminAllowlist = sqliteTable(
  'admin_allowlist',
  {
    email: text('email').primaryKey(),
    note: text('note').notNull().default(''),
    addedBy: text('added_by').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check('admin_allowlist_email_normalized', sql`${table.email} = lower(trim(${table.email}))`)
  ]
)

/**
 * Sliding-window log behind the sign-in code limits (`apps/web/src/db/auth.ts`). A row
 * records one allowed request for a bucket: an HMAC-SHA256 digest, under a key the app derives
 * from `BETTER_AUTH_SECRET`, of a scope and a normalized key (an email, an IP address or IPv6 /64,
 * or both), never the key itself. Rows are pseudonymous: without the secret they cannot be
 * reversed by enumerating addresses. Rows older than 24 hours are pruned as requests arrive.
 */
export const authRateLimitHits = sqliteTable(
  'auth_rate_limit_hits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bucket: text('bucket').notNull(),
    hitAt: integer('hit_at').notNull()
  },
  table => [
    index('auth_rate_limit_hits_bucket_idx').on(table.bucket, table.hitAt),
    index('auth_rate_limit_hits_time_idx').on(table.hitAt)
  ]
)

/**
 * A prohibited rejection blocks the submission's block key from any new submission, free or
 * paid, until an admin lifts the block (#59 owner amendments, 2026-10-06): a registrable domain
 * with all its subdomains, or an exact host (`covers_subdomains = 0`) when the host has no
 * registrable domain or the row predates #62. The trigger `listing_submissions_refuse_blocked_url`
 * enforces it. Lifting keeps the row as history.
 */
export const listingSubmissionUrlBlocks = sqliteTable(
  'listing_submission_url_blocks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    urlKey: text('url_key').notNull(),
    submissionId: text('submission_id').references(() => listingSubmissions.id, {
      onDelete: 'set null'
    }),
    reason: text('reason').notNull(),
    blockedBy: text('blocked_by').notNull(),
    blockedAt: text('blocked_at').notNull(),
    liftedAt: text('lifted_at'),
    liftedBy: text('lifted_by'),
    liftNote: text('lift_note'),
    coversSubdomains: integer('covers_subdomains', { mode: 'boolean' }).notNull()
  },
  table => [
    check(
      'listing_submission_url_blocks_lift_complete',
      sql`(${table.liftedAt} IS NULL) = (${table.liftedBy} IS NULL)`
    ),
    check(
      'listing_submission_url_blocks_covers_subdomains_boolean',
      booleanCheck(table.coversSubdomains)
    ),
    uniqueIndex('listing_submission_url_blocks_active_idx')
      .on(table.urlKey)
      .where(sql`${table.liftedAt} IS NULL`),
    // Full (not partial) indexes on foreign keys, so deleting the parent row is a seek (#77).
    index('listing_submission_url_blocks_submission_idx').on(table.submissionId)
  ]
)

/**
 * Who owns a listing. One current `owner` per listing (a partial unique index); revoking keeps
 * the row with `revoked_at`, so the table is also the ownership history. Further roles can be
 * added for teams. The public "Verified owner" badge is derived from a current owner row, so a
 * change here advances the catalog epoch in the same batch (see data-model.md).
 */
export const listingOwners = sqliteTable(
  'listing_owners',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role', { enum: listingOwnerRoles }).notNull().default('owner'),
    verifiedVia: text('verified_via', { enum: listingOwnerVerifications }).notNull(),
    verifiedAt: text('verified_at').notNull(),
    revokedAt: text('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check('listing_owners_role_valid', sql`${table.role} IN (${sqlList(listingOwnerRoles)})`),
    check(
      'listing_owners_verified_via_valid',
      sql`${table.verifiedVia} IN (${sqlList(listingOwnerVerifications)})`
    ),
    check(
      'listing_owners_revocation_complete',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL)`
    ),
    uniqueIndex('listing_owners_current_owner_idx')
      .on(table.listingId)
      .where(sql`${table.role} = 'owner' AND ${table.revokedAt} IS NULL`),
    uniqueIndex('listing_owners_current_member_idx')
      .on(table.listingId, table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    // Full (not partial) indexes on both foreign keys, so deleting a listing or a user is a
    // seek; the partial unique indexes above cannot serve SQLite's foreign-key checks (#77).
    index('listing_owners_listing_idx').on(table.listingId),
    index('listing_owners_user_idx').on(table.userId, table.listingId)
  ]
)

/**
 * A staged edit of a live listing by its owner. It is reviewed like a submission and applied
 * by the approval plan in `revision-plans.ts`, which refuses a revision whose `base_checksum`
 * no longer matches the listing. Website and slug are not editable through a revision.
 */
export const listingRevisions = sqliteTable(
  'listing_revisions',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status', { enum: revisionStatuses }).notNull().default('pending_review'),
    baseChecksum: text('base_checksum').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    content: text('content'),
    categorySlug: text('category_slug').notNull(),
    logoUrl: text('logo_url').notNull(),
    videoUrl: text('video_url'),
    reviewerNote: text('reviewer_note'),
    rejectionReason: text('rejection_reason'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp),
    /** Increments on every edit; approval compares and swaps on the version the reviewer saw. */
    contentVersion: integer('content_version').notNull().default(1),
    /** The owner's tags (#341), as on a submission; null leaves the listing's tags unchanged. */
    tagSlugs: text('tag_slugs')
  },
  table => [
    check('listing_revisions_status_valid', sql`${table.status} IN (${sqlList(revisionStatuses)})`),
    check('listing_revisions_content_version_positive', sql`${table.contentVersion} >= 1`),
    check(
      'listing_revisions_rejection_when_rejected',
      sql`${table.rejectionReason} IS NULL OR ${table.status} = 'rejected'`
    ),
    check('listing_revisions_tag_slugs_valid', tagSlugsCheck(table.tagSlugs)),
    uniqueIndex('listing_revisions_open_idx')
      .on(table.listingId)
      .where(sql`${table.status} IN (${sqlList(openRevisionStatuses)})`),
    index('listing_revisions_review_queue_idx').on(table.status, table.createdAt),
    index('listing_revisions_author_idx').on(table.authorUserId, table.createdAt),
    // Full index on the listing foreign key (`listing_revisions_open_idx` is partial) (#77).
    index('listing_revisions_listing_idx').on(table.listingId)
  ]
)

export const listingRevisionResourceLinks = sqliteTable(
  'listing_revision_resource_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => listingRevisions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    unique('listing_revision_resource_links_revision_order_unique').on(
      table.revisionId,
      table.sortOrder
    )
  ]
)

export const listingRevisionFaqs = sqliteTable(
  'listing_revision_faqs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => listingRevisions.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    unique('listing_revision_faqs_revision_order_unique').on(table.revisionId, table.sortOrder)
  ]
)

export const listingRevisionEvents = sqliteTable(
  'listing_revision_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    revisionId: text('revision_id')
      .notNull()
      .references(() => listingRevisions.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: revisionEventTypes }).notNull(),
    detail: text('detail'),
    actor: text('actor').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check(
      'listing_revision_events_type_valid',
      sql`${table.eventType} IN (${sqlList(revisionEventTypes)})`
    ),
    index('listing_revision_events_revision_idx').on(table.revisionId, table.createdAt)
  ]
)

/**
 * Badge program history (#66). It sits outside the catalog: writing a check never touches
 * `publication_state` or `published_at`, so it never changes the catalog epoch. A network
 * error or timeout is recorded as an inconclusive `fail` and never counts as a miss.
 */
export const badgeChecks = sqliteTable(
  'badge_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    checkedAt: text('checked_at').notNull(),
    outcome: text('outcome', { enum: badgeCheckOutcomes }).notNull(),
    reason: text('reason'),
    conclusive: integer('conclusive', { mode: 'boolean' }).notNull(),
    kind: text('kind', { enum: badgeCheckKinds }).notNull().default('weekly')
  },
  table => [
    check('badge_checks_outcome_valid', sql`${table.outcome} IN (${sqlList(badgeCheckOutcomes)})`),
    check('badge_checks_kind_valid', sql`${table.kind} IN (${sqlList(badgeCheckKinds)})`),
    check('badge_checks_conclusive_boolean', booleanCheck(table.conclusive)),
    // ISO instants compare as text: the refund plans read the refund check's `checked_at`.
    check('badge_checks_checked_at_iso', isoInstantCheck(table.checkedAt)),
    check(
      'badge_checks_pass_conclusive',
      sql`${table.outcome} = 'fail' OR (${table.conclusive} = 1 AND ${table.reason} IS NULL)`
    ),
    check(
      'badge_checks_fail_reason',
      sql`${table.outcome} = 'pass' OR ${table.reason} IS NOT NULL`
    ),
    index('badge_checks_listing_time_idx').on(
      table.listingId,
      sql`${table.checkedAt} DESC`,
      sql`${table.id} DESC`
    )
  ]
)

/**
 * One row per admin or ownership change of a listing (`listingEventTypes`), with the actor and a
 * JSON detail (the note, the fields edited, the old and new link). The admin listing page reads
 * it as the activity log, together with the listing's submission events.
 */
export const listingEvents = sqliteTable(
  'listing_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    eventType: text('event_type', { enum: listingEventTypes }).notNull(),
    detail: text('detail'),
    actor: text('actor').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check('listing_events_type_valid', sql`${table.eventType} IN (${sqlList(listingEventTypes)})`),
    index('listing_events_listing_idx').on(table.listingId, table.createdAt)
  ]
)

/**
 * How a claim (#67) proves ownership after the domain email: the badge on the site (free), or a
 * payment (#68).
 */
export const listingClaimMethods = ['badge', 'paid'] as const
export type ListingClaimMethod = (typeof listingClaimMethods)[number]

/**
 * A claim's progress: a code was sent to the domain address (`code_sent`), the address was
 * confirmed (`email_verified`, waiting for the badge or the payment), ownership was granted
 * (`completed`), or it ended without ownership (`cancelled`: someone else's claim completed, the
 * listing left the catalog, or the claimer started over).
 */
export const listingClaimStatuses = [
  'code_sent',
  'email_verified',
  'completed',
  'cancelled'
] as const
export type ListingClaimStatus = (typeof listingClaimStatuses)[number]

/** A claim that can still complete. A user has at most one per listing. */
export const openListingClaimStatuses = [
  'code_sent',
  'email_verified'
] as const satisfies readonly ListingClaimStatus[]

/**
 * Claims of existing listings (#67): a signed-in user proves an address on the product's own
 * domain with a single-use code, then the badge or a payment, and becomes its owner
 * (`listing_owners`, `verified_via` `badge_claim` or `paid_claim`). The code is stored only as a
 * keyed hash (`code_hash`, HMAC under a key derived from the auth secret) and cleared once used.
 * `attempts` counts wrong codes for the current code; the fifth locks the claim until
 * `locked_until`. Instants are ISO strings (CHECKs) so they compare as text.
 */
export const listingClaims = sqliteTable(
  'listing_claims',
  {
    id: text('id').primaryKey(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    method: text('method', { enum: listingClaimMethods }).notNull(),
    status: text('status', { enum: listingClaimStatuses }).notNull().default('code_sent'),
    /** The domain address the code went to (lowercase). */
    email: text('email').notNull(),
    /** Its registrable domain: the product's own domain (never SERP's or a link shortener's). */
    emailDomain: text('email_domain').notNull(),
    /**
     * The product's page the badge must be on, resolved when the code was sent: the slug's
     * domain, the website, or where a `serp.ly` link lands (#108 review round 1).
     */
    productUrl: text('product_url').notNull(),
    /**
     * The listing's website when the product domain was resolved. Completion compares against the
     * claim's stored domain and refetches only when the listing's website changed since (#108
     * review round 2).
     */
    listingWebsite: text('listing_website').notNull(),
    codeHash: text('code_hash'),
    codeSentAt: text('code_sent_at').notNull(),
    codeExpiresAt: text('code_expires_at').notNull(),
    codesSent: integer('codes_sent').notNull().default(1),
    attempts: integer('attempts').notNull().default(0),
    lockedUntil: text('locked_until'),
    emailVerifiedAt: text('email_verified_at'),
    badgeCheckedAt: text('badge_checked_at'),
    /** Badge checks that found a result (missing, unfollowed, elsewhere): at most 10 (#70). */
    badgeAttempts: integer('badge_attempts').notNull().default(0),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    check('listing_claims_method_valid', sql`${table.method} IN (${sqlList(listingClaimMethods)})`),
    check(
      'listing_claims_status_valid',
      sql`${table.status} IN (${sqlList(listingClaimStatuses)})`
    ),
    check('listing_claims_attempts_range', sql`${table.attempts} BETWEEN 0 AND 5`),
    check('listing_claims_codes_sent_positive', sql`${table.codesSent} >= 1`),
    check('listing_claims_badge_attempts_range', sql`${table.badgeAttempts} BETWEEN 0 AND 10`),
    check('listing_claims_code_sent_at_iso', isoInstantCheck(table.codeSentAt)),
    check('listing_claims_code_expires_at_iso', isoInstantCheck(table.codeExpiresAt)),
    check('listing_claims_locked_until_iso', isoInstantCheck(table.lockedUntil)),
    check('listing_claims_email_verified_at_iso', isoInstantCheck(table.emailVerifiedAt)),
    check('listing_claims_badge_checked_at_iso', isoInstantCheck(table.badgeCheckedAt)),
    check('listing_claims_completed_at_iso', isoInstantCheck(table.completedAt)),
    // A code is pending only before the address is confirmed; a confirmed claim has the time.
    check(
      'listing_claims_code_while_sent',
      sql`${table.codeHash} IS NULL OR ${table.status} = 'code_sent'`
    ),
    check(
      'listing_claims_verified_complete',
      sql`${table.status} NOT IN ('email_verified', 'completed') OR ${table.emailVerifiedAt} IS NOT NULL`
    ),
    check(
      'listing_claims_completed_complete',
      sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`
    ),
    uniqueIndex('listing_claims_open_idx')
      .on(table.listingId, table.userId)
      .where(sql`${table.status} IN (${sqlList(openListingClaimStatuses)})`),
    index('listing_claims_listing_idx').on(table.listingId),
    index('listing_claims_user_idx').on(table.userId, table.createdAt)
  ]
)

export const listingClaimHoldReasons = ['off_domain', 'unreachable', 'admin'] as const
export type ListingClaimHoldReason = (typeof listingClaimHoldReasons)[number]

/**
 * Listings whose instant claim is held for the owner's review (#67, #108 review round 2):
 * #100's owner-review sets (the link ends on another company's domain, or the site is
 * unreachable, `d1/hygiene/2026-10-06-listing-domains.yaml`), seeded by `0008_listing_claims`,
 * and any an admin adds. A held listing answers every claim with the contact path, because a
 * lapsed or reassigned domain could otherwise be registered and claimed by someone else. An admin
 * clears a hold by setting `cleared_at`.
 */
export const listingClaimHolds = sqliteTable(
  'listing_claim_holds',
  {
    listingId: text('listing_id')
      .primaryKey()
      .references(() => listings.id, { onDelete: 'cascade' }),
    reason: text('reason', { enum: listingClaimHoldReasons }).notNull(),
    /** Where the hold came from: the hygiene report, or the admin who added it. */
    source: text('source').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    clearedAt: text('cleared_at'),
    clearedBy: text('cleared_by')
  },
  table => [
    check(
      'listing_claim_holds_reason_valid',
      sql`${table.reason} IN (${sqlList(listingClaimHoldReasons)})`
    ),
    check('listing_claim_holds_cleared_at_iso', isoInstantCheck(table.clearedAt)),
    check(
      'listing_claim_holds_cleared_complete',
      sql`(${table.clearedAt} IS NULL) = (${table.clearedBy} IS NULL)`
    )
  ]
)

/**
 * Billing (#68). `orders` is the ledger of record for every charge and refund, whatever the
 * submission or listing it was for could accept (docs/submission-data.md, "Payments and
 * refunds"). Provider-neutral: `provider` names the billing provider (`stripe` now, Lago
 * later) and the `provider_*` columns hold its references. Amounts are integer minor units.
 */
export const orderKinds = ['paid_listing', 'paid_claim'] as const
export type OrderKind = (typeof orderKinds)[number]

/**
 * What a paid listing order buys: a new paid submission (`submission`), the upgrade of a live
 * free listing (`upgrade`), or bringing back a free listing the badge program unlisted
 * (`relist`). A paid claim is `claim` (#67).
 */
export const orderPurposes = ['submission', 'upgrade', 'relist', 'claim'] as const
export type OrderPurpose = (typeof orderPurposes)[number]

/**
 * `refunding`: the refund is claimed (a compare-and-swap from the status it was decided on)
 * before the provider is asked, so nothing else can apply or refund the order meanwhile; the
 * provider's answer then finalizes it as `refunded`. The sweep finishes one a failure left.
 */
export const orderStatuses = ['pending', 'paid', 'refunding', 'refunded', 'failed'] as const
export type OrderStatus = (typeof orderStatuses)[number]

/**
 * What a paid order did once applied: the submission went live (`published`) or waits for
 * review after a failed guardrail check (`held`), the listing was upgraded or relisted, the
 * claim completed, or the payment could not be applied and is refunded (`unapplied`).
 */
export const orderOutcomes = [
  'published',
  'held',
  'upgraded',
  'relisted',
  'claimed',
  'unapplied'
] as const
export type OrderOutcome = (typeof orderOutcomes)[number]

/** Why an order was refunded: an `other` rejection, an admin's refund, or an unapplied payment. */
export const orderRefundReasons = ['rejected', 'admin', 'unapplied'] as const
export type OrderRefundReason = (typeof orderRefundReasons)[number]

/**
 * What an admin's refund does to the listing, decided (with the badge check at refund) before
 * the refund is claimed, so a retry never checks the badge again.
 */
export const orderRefundListingActions = [
  'keep_free',
  'unpublish',
  'already_unpublished',
  'none'
] as const
export type OrderRefundListingAction = (typeof orderRefundListingActions)[number]

/**
 * Why an order needs an admin: a charge that didn't match its order (refunded), or a refund
 * the provider kept refusing (`refund_failed`, after `REFUND_MAX_ATTEMPTS`; the sweep stops).
 */
export const orderAttentions = ['amount_mismatch', 'refund_failed'] as const
export type OrderAttention = (typeof orderAttentions)[number]

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    /** The order number people see (`ORD-<number>`), assigned in order from 1001. */
    number: integer('number').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: orderKinds }).notNull(),
    purpose: text('purpose', { enum: orderPurposes }).notNull(),
    /** One open (`pending`) order per target: `submission:<id>`, `listing:<id>`, `claim:<id>`. */
    targetKey: text('target_key').notNull(),
    submissionId: text('submission_id').references(() => listingSubmissions.id),
    listingId: text('listing_id').references(() => listings.id),
    /** The paid claim (#67's `listing_claims`), kept without a foreign key. */
    claimId: text('claim_id'),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    provider: text('provider').notNull(),
    providerCheckoutId: text('provider_checkout_id'),
    checkoutUrl: text('checkout_url'),
    checkoutExpiresAt: text('checkout_expires_at'),
    providerPaymentId: text('provider_payment_id'),
    providerRefundId: text('provider_refund_id'),
    /** What the provider actually charged (the refund returns exactly this). */
    chargedCents: integer('charged_cents'),
    chargedCurrency: text('charged_currency'),
    attention: text('attention', { enum: orderAttentions }),
    status: text('status', { enum: orderStatuses }).notNull().default('pending'),
    outcome: text('outcome', { enum: orderOutcomes }),
    failureReason: text('failure_reason'),
    /** The guardrail check that held a paid submission for review (`held`), e.g. `fetch_timeout`. */
    checkProblem: text('check_problem'),
    refundReason: text('refund_reason', { enum: orderRefundReasons }),
    refundedBy: text('refunded_by'),
    refundListingAction: text('refund_listing_action', { enum: orderRefundListingActions }),
    refundBadgeCheckId: integer('refund_badge_check_id'),
    refundRequestedAt: text('refund_requested_at'),
    /** Provider refund attempts that failed, and when the sweep may try again (backoff). */
    refundAttempts: integer('refund_attempts').notNull().default(0),
    refundRetryAt: text('refund_retry_at'),
    /** The admin's reason for the activity log (#70 screen 13). */
    refundNote: text('refund_note'),
    paidAt: text('paid_at'),
    appliedAt: text('applied_at'),
    refundedAt: text('refunded_at'),
    failedAt: text('failed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  table => [
    check('orders_kind_valid', sql`${table.kind} IN (${sqlList(orderKinds)})`),
    check('orders_purpose_valid', sql`${table.purpose} IN (${sqlList(orderPurposes)})`),
    check('orders_status_valid', sql`${table.status} IN (${sqlList(orderStatuses)})`),
    check(
      'orders_outcome_valid',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${sqlList(orderOutcomes)})`
    ),
    check(
      'orders_refund_listing_action_valid',
      sql`${table.refundListingAction} IS NULL
        OR ${table.refundListingAction} IN (${sqlList(orderRefundListingActions)})`
    ),
    check(
      'orders_attention_valid',
      sql`${table.attention} IS NULL OR ${table.attention} IN (${sqlList(orderAttentions)})`
    ),
    check(
      'orders_refund_reason_valid',
      sql`${table.refundReason} IS NULL OR ${table.refundReason} IN (${sqlList(orderRefundReasons)})`
    ),
    check(
      'orders_target_matches_purpose',
      sql`(${table.purpose} = 'claim' AND ${table.kind} = 'paid_claim'
        AND ${table.claimId} IS NOT NULL AND ${table.listingId} IS NOT NULL
        AND ${table.targetKey} = 'claim:' || ${table.claimId})
      OR (${table.purpose} = 'submission' AND ${table.kind} = 'paid_listing'
        AND ${table.submissionId} IS NOT NULL AND ${table.claimId} IS NULL
        AND ${table.targetKey} = 'submission:' || ${table.submissionId})
      OR (${table.purpose} IN ('upgrade', 'relist') AND ${table.kind} = 'paid_listing'
        AND ${table.submissionId} IS NOT NULL AND ${table.listingId} IS NOT NULL
        AND ${table.claimId} IS NULL AND ${table.targetKey} = 'listing:' || ${table.listingId})`
    ),
    check('orders_amount_positive', sql`${table.amountCents} > 0`),
    check('orders_refund_attempts_valid', sql`${table.refundAttempts} >= 0`),
    check('orders_currency_valid', sql`${table.currency} GLOB '[a-z][a-z][a-z]'`),
    check(
      'orders_paid_recorded',
      sql`${table.status} IN ('pending', 'failed')
        OR (${table.paidAt} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL
          AND ${table.chargedCents} IS NOT NULL AND ${table.chargedCurrency} IS NOT NULL)`
    ),
    check(
      'orders_refund_recorded',
      sql`(${table.status} = 'refunded') = (${table.refundedAt} IS NOT NULL)
        AND (${table.status} IN ('refunding', 'refunded')) = (${table.refundReason} IS NOT NULL)
        AND (${table.refundReason} IS NULL) = (${table.refundRequestedAt} IS NULL)
        AND (${table.refundReason} = 'admin') = (${table.refundListingAction} IS NOT NULL)`
    ),
    check(
      'orders_outcome_after_payment',
      sql`(${table.outcome} IS NULL) = (${table.appliedAt} IS NULL)
        AND (${table.appliedAt} IS NULL OR ${table.paidAt} IS NOT NULL)`
    ),
    check(
      'orders_failed_recorded',
      sql`(${table.status} = 'failed') = (${table.failedAt} IS NOT NULL)`
    ),
    uniqueIndex('orders_number_idx').on(table.number),
    uniqueIndex('orders_open_target_idx')
      .on(table.targetKey)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex('orders_provider_checkout_idx')
      .on(table.provider, table.providerCheckoutId)
      .where(sql`${table.providerCheckoutId} IS NOT NULL`),
    index('orders_status_created_idx').on(table.status, table.createdAt),
    index('orders_submission_idx').on(table.submissionId),
    index('orders_listing_idx').on(table.listingId),
    index('orders_user_idx').on(table.userId, table.createdAt)
  ]
)

/**
 * Provider webhook events, recorded once per provider event id (#68). A replay of an event
 * whose processing finished (`processed_at`) is a no-op; one that failed midway runs again,
 * and every step it takes is itself idempotent.
 */
export const billingEvents = sqliteTable(
  'billing_events',
  {
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    orderId: text('order_id').references(() => orders.id),
    outcome: text('outcome'),
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at')
  },
  table => [
    primaryKey({ columns: [table.provider, table.eventId] }),
    index('billing_events_order_idx').on(table.orderId)
  ]
)

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  listingOwnerships: many(listingOwners),
  revisions: many(listingRevisions),
  sessions: many(sessions),
  submissions: many(listingSubmissions)
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] })
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] })
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  bestPages: many(bestPages),
  listings: many(listingCategories),
  tags: many(tags)
}))

export const tagsRelations = relations(tags, ({ many, one }) => ({
  bestPages: many(bestPages),
  category: one(categories, { fields: [tags.categoryId], references: [categories.id] }),
  listings: many(listingTags)
}))

export const listingTagsRelations = relations(listingTags, ({ one }) => ({
  listing: one(listings, { fields: [listingTags.listingId], references: [listings.id] }),
  tag: one(tags, { fields: [listingTags.tagId], references: [tags.id] })
}))

export const bestPagesRelations = relations(bestPages, ({ many, one }) => ({
  category: one(categories, { fields: [bestPages.categoryId], references: [categories.id] }),
  listings: many(bestPageListings),
  tag: one(tags, { fields: [bestPages.tagId], references: [tags.id] })
}))

export const bestPageListingsRelations = relations(bestPageListings, ({ one }) => ({
  bestPage: one(bestPages, {
    fields: [bestPageListings.bestPageId],
    references: [bestPages.id]
  }),
  listing: one(listings, { fields: [bestPageListings.listingId], references: [listings.id] })
}))

export const listingsRelations = relations(listings, ({ many }) => ({
  badgeChecks: many(badgeChecks),
  bestPages: many(bestPageListings),
  events: many(listingEvents),
  categories: many(listingCategories),
  faqs: many(listingFaqs),
  media: many(listingMedia),
  owners: many(listingOwners),
  resourceLinks: many(listingResourceLinks),
  revisions: many(listingRevisions),
  slugRedirects: many(listingSlugRedirects),
  submissions: many(listingSubmissions),
  tags: many(listingTags)
}))

export const listingCategoriesRelations = relations(listingCategories, ({ one }) => ({
  category: one(categories, {
    fields: [listingCategories.categoryId],
    references: [categories.id]
  }),
  listing: one(listings, {
    fields: [listingCategories.listingId],
    references: [listings.id]
  })
}))

export const listingMediaRelations = relations(listingMedia, ({ one }) => ({
  listing: one(listings, { fields: [listingMedia.listingId], references: [listings.id] })
}))

export const listingResourceLinksRelations = relations(listingResourceLinks, ({ one }) => ({
  listing: one(listings, {
    fields: [listingResourceLinks.listingId],
    references: [listings.id]
  })
}))

export const listingFaqsRelations = relations(listingFaqs, ({ one }) => ({
  listing: one(listings, { fields: [listingFaqs.listingId], references: [listings.id] })
}))

export const listingSlugRedirectsRelations = relations(listingSlugRedirects, ({ one }) => ({
  listing: one(listings, {
    fields: [listingSlugRedirects.listingId],
    references: [listings.id]
  })
}))

export const listingSubmissionsRelations = relations(listingSubmissions, ({ many, one }) => ({
  events: many(listingSubmissionEvents),
  faqs: many(listingSubmissionFaqs),
  listing: one(listings, {
    fields: [listingSubmissions.listingId],
    references: [listings.id]
  }),
  owner: one(users, { fields: [listingSubmissions.ownerUserId], references: [users.id] }),
  resourceLinks: many(listingSubmissionResourceLinks),
  urlBlocks: many(listingSubmissionUrlBlocks)
}))

export const listingSubmissionResourceLinksRelations = relations(
  listingSubmissionResourceLinks,
  ({ one }) => ({
    submission: one(listingSubmissions, {
      fields: [listingSubmissionResourceLinks.submissionId],
      references: [listingSubmissions.id]
    })
  })
)

export const listingSubmissionFaqsRelations = relations(listingSubmissionFaqs, ({ one }) => ({
  submission: one(listingSubmissions, {
    fields: [listingSubmissionFaqs.submissionId],
    references: [listingSubmissions.id]
  })
}))

export const listingSubmissionEventsRelations = relations(listingSubmissionEvents, ({ one }) => ({
  submission: one(listingSubmissions, {
    fields: [listingSubmissionEvents.submissionId],
    references: [listingSubmissions.id]
  })
}))

export const listingSubmissionUrlBlocksRelations = relations(
  listingSubmissionUrlBlocks,
  ({ one }) => ({
    submission: one(listingSubmissions, {
      fields: [listingSubmissionUrlBlocks.submissionId],
      references: [listingSubmissions.id]
    })
  })
)

export const listingOwnersRelations = relations(listingOwners, ({ one }) => ({
  listing: one(listings, { fields: [listingOwners.listingId], references: [listings.id] }),
  user: one(users, { fields: [listingOwners.userId], references: [users.id] })
}))

export const listingRevisionsRelations = relations(listingRevisions, ({ many, one }) => ({
  author: one(users, { fields: [listingRevisions.authorUserId], references: [users.id] }),
  events: many(listingRevisionEvents),
  faqs: many(listingRevisionFaqs),
  listing: one(listings, { fields: [listingRevisions.listingId], references: [listings.id] }),
  resourceLinks: many(listingRevisionResourceLinks)
}))

export const listingRevisionResourceLinksRelations = relations(
  listingRevisionResourceLinks,
  ({ one }) => ({
    revision: one(listingRevisions, {
      fields: [listingRevisionResourceLinks.revisionId],
      references: [listingRevisions.id]
    })
  })
)

export const listingRevisionFaqsRelations = relations(listingRevisionFaqs, ({ one }) => ({
  revision: one(listingRevisions, {
    fields: [listingRevisionFaqs.revisionId],
    references: [listingRevisions.id]
  })
}))

export const listingRevisionEventsRelations = relations(listingRevisionEvents, ({ one }) => ({
  revision: one(listingRevisions, {
    fields: [listingRevisionEvents.revisionId],
    references: [listingRevisions.id]
  })
}))

export const badgeChecksRelations = relations(badgeChecks, ({ one }) => ({
  listing: one(listings, { fields: [badgeChecks.listingId], references: [listings.id] })
}))

export const ordersRelations = relations(orders, ({ many, one }) => ({
  events: many(billingEvents),
  listing: one(listings, { fields: [orders.listingId], references: [listings.id] }),
  submission: one(listingSubmissions, {
    fields: [orders.submissionId],
    references: [listingSubmissions.id]
  }),
  user: one(users, { fields: [orders.userId], references: [users.id] })
}))

export const billingEventsRelations = relations(billingEvents, ({ one }) => ({
  order: one(orders, { fields: [billingEvents.orderId], references: [orders.id] })
}))

export const listingClaimsRelations = relations(listingClaims, ({ one }) => ({
  listing: one(listings, { fields: [listingClaims.listingId], references: [listings.id] }),
  user: one(users, { fields: [listingClaims.userId], references: [users.id] })
}))

export const listingEventsRelations = relations(listingEvents, ({ one }) => ({
  listing: one(listings, { fields: [listingEvents.listingId], references: [listings.id] })
}))
