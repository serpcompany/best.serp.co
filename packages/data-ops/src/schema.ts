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

const currentTimestamp = sql`CURRENT_TIMESTAMP`
const booleanCheck = (column: { name: string }) => sql`${sql.identifier(column.name)} IN (0, 1)`

export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(currentTimestamp),
  updatedAt: text('updated_at').notNull().default(currentTimestamp)
})

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('categories_site_slug_unique').on(table.siteId, table.slug),
    check('categories_is_active_boolean', booleanCheck(table.isActive)),
    index('categories_public_idx').on(table.siteId, table.isActive, table.sortOrder, table.name)
  ]
)

export const listings = sqliteTable(
  'listings',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
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
    displayOrder: integer('display_order').notNull().default(0)
  },
  table => [
    unique('listings_site_slug_unique').on(table.siteId, table.slug),
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
    index('listings_slug_lookup_idx').on(table.siteId, table.slug),
    index('listings_publication_idx').on(
      table.siteId,
      table.status,
      table.isActive,
      sql`${table.publishedAt} DESC`,
      table.displayOrder,
      table.slug
    ),
    index('listings_featured_idx').on(
      table.siteId,
      table.status,
      table.isActive,
      table.isFeatured,
      sql`${table.publishedAt} DESC`,
      table.displayOrder
    ),
    index('listings_name_idx').on(table.siteId, sql`${table.name} COLLATE NOCASE`),
    index('listings_related_name_idx')
      .on(table.siteId, table.name, table.slug)
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

export const listingMedia = sqliteTable(
  'listing_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['logo', 'image', 'video'] }).notNull(),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0)
  },
  table => [
    check('listing_media_kind_valid', sql`${table.kind} IN ('logo', 'image', 'video')`),
    unique('listing_media_listing_kind_order_unique').on(
      table.listingId,
      table.kind,
      table.sortOrder
    ),
    index('listing_media_listing_idx').on(table.listingId, table.sortOrder)
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
    unique('listing_resource_links_listing_order_unique').on(table.listingId, table.sortOrder),
    index('listing_resource_links_listing_idx').on(table.listingId, table.sortOrder)
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
  table => [
    unique('listing_faqs_listing_order_unique').on(table.listingId, table.sortOrder),
    index('listing_faqs_listing_idx').on(table.listingId, table.sortOrder)
  ]
)

export const publicationState = sqliteTable(
  'publication_state',
  {
    siteId: text('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(0),
    manifestId: text('manifest_id'),
    checksum: text('checksum').notNull(),
    publishedAt: text('published_at').notNull().default(currentTimestamp)
  },
  table => [check('publication_state_version_nonnegative', sql`${table.version} >= 0`)]
)

export const migrationRuns = sqliteTable(
  'migration_runs',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
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
    unique('migration_runs_site_manifest_unique').on(table.siteId, table.manifestIdentity),
    check(
      'migration_runs_outcome_valid',
      sql`${table.outcome} IN ('started', 'succeeded', 'failed')`
    ),
    index('migration_runs_site_time_idx').on(table.siteId, sql`${table.startedAt} DESC`)
  ]
)

export const publicationRuns = sqliteTable(
  'publication_runs',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
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
    unique('publication_runs_site_manifest_unique').on(table.siteId, table.manifestId),
    check(
      'publication_runs_outcome_valid',
      sql`${table.outcome} IN ('started', 'succeeded', 'failed')`
    ),
    index('publication_runs_site_time_idx').on(table.siteId, sql`${table.startedAt} DESC`)
  ]
)

export const listingSlugRedirects = sqliteTable(
  'listing_slug_redirects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
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
    unique('listing_slug_redirects_site_old_slug_unique').on(table.siteId, table.oldSlug),
    check('listing_slug_redirects_slug_change', sql`${table.oldSlug} != ${table.newSlug}`),
    index('listing_slug_redirects_listing_idx').on(table.listingId, sql`${table.createdAt} DESC`)
  ]
)

export const listingSubmissions = sqliteTable(
  'listing_submissions',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    website: text('website').notNull(),
    content: text('content').notNull(),
    categorySlug: text('category_slug').notNull(),
    logoUrl: text('logo_url').notNull(),
    videoUrl: text('video_url'),
    status: text('status', {
      enum: ['pending_badge', 'verified', 'approved', 'rejected']
    })
      .notNull()
      .default('pending_badge'),
    accessTokenHash: text('access_token_hash').notNull(),
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    lastVerificationAt: text('last_verification_at'),
    lastVerificationError: text('last_verification_error'),
    badgeVerifiedAt: text('badge_verified_at'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
    listingId: text('listing_id').references(() => listings.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp)
  },
  table => [
    unique('listing_submissions_site_token_unique').on(table.siteId, table.accessTokenHash),
    check(
      'listing_submissions_status_valid',
      sql`${table.status} IN ('pending_badge', 'verified', 'approved', 'rejected')`
    ),
    check(
      'listing_submissions_verification_attempts_nonnegative',
      sql`${table.verificationAttempts} >= 0`
    ),
    uniqueIndex('listing_submissions_active_slug_idx')
      .on(table.siteId, table.slug)
      .where(sql`${table.status} IN ('pending_badge', 'verified')`),
    index('listing_submissions_review_queue_idx').on(
      table.siteId,
      table.status,
      table.badgeVerifiedAt,
      table.createdAt
    )
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
    eventType: text('event_type', {
      enum: ['created', 'verification_failed', 'badge_verified', 'approved', 'rejected']
    }).notNull(),
    detail: text('detail'),
    actor: text('actor').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp)
  },
  table => [
    check(
      'listing_submission_events_type_valid',
      sql`${table.eventType} IN ('created', 'verification_failed', 'badge_verified', 'approved', 'rejected')`
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

export const listingSubmissionNotifications = sqliteTable(
  'listing_submission_notifications',
  {
    submissionId: text('submission_id')
      .notNull()
      .references(() => listingSubmissions.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['github_issue'] }).notNull(),
    externalId: text('external_id').notNull(),
    externalUrl: text('external_url').notNull(),
    recipient: text('recipient').notNull(),
    createdAt: text('created_at').notNull().default(currentTimestamp),
    updatedAt: text('updated_at').notNull().default(currentTimestamp),
    previewTokenHash: text('preview_token_hash')
  },
  table => [
    primaryKey({ columns: [table.submissionId, table.channel] }),
    unique('listing_submission_notifications_channel_external_unique').on(
      table.channel,
      table.externalId
    ),
    check(
      'listing_submission_notifications_channel_valid',
      sql`${table.channel} IN ('github_issue')`
    ),
    index('listing_submission_notifications_recipient_idx').on(
      table.channel,
      table.recipient,
      table.createdAt
    ),
    uniqueIndex('listing_submission_notifications_preview_token_idx')
      .on(table.previewTokenHash)
      .where(sql`${table.previewTokenHash} IS NOT NULL`)
  ]
)

export const sitesRelations = relations(sites, ({ many, one }) => ({
  categories: many(categories),
  listings: many(listings),
  migrationRuns: many(migrationRuns),
  publicationRuns: many(publicationRuns),
  publicationState: one(publicationState),
  slugRedirects: many(listingSlugRedirects),
  submissions: many(listingSubmissions)
}))

export const categoriesRelations = relations(categories, ({ many, one }) => ({
  listings: many(listingCategories),
  site: one(sites, { fields: [categories.siteId], references: [sites.id] })
}))

export const listingsRelations = relations(listings, ({ many, one }) => ({
  categories: many(listingCategories),
  faqs: many(listingFaqs),
  media: many(listingMedia),
  resourceLinks: many(listingResourceLinks),
  site: one(sites, { fields: [listings.siteId], references: [sites.id] }),
  slugRedirects: many(listingSlugRedirects),
  submissions: many(listingSubmissions)
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

export const publicationStateRelations = relations(publicationState, ({ one }) => ({
  site: one(sites, { fields: [publicationState.siteId], references: [sites.id] })
}))

export const migrationRunsRelations = relations(migrationRuns, ({ one }) => ({
  site: one(sites, { fields: [migrationRuns.siteId], references: [sites.id] })
}))

export const publicationRunsRelations = relations(publicationRuns, ({ one }) => ({
  site: one(sites, { fields: [publicationRuns.siteId], references: [sites.id] })
}))

export const listingSlugRedirectsRelations = relations(listingSlugRedirects, ({ one }) => ({
  listing: one(listings, {
    fields: [listingSlugRedirects.listingId],
    references: [listings.id]
  }),
  site: one(sites, { fields: [listingSlugRedirects.siteId], references: [sites.id] })
}))

export const listingSubmissionsRelations = relations(listingSubmissions, ({ many, one }) => ({
  events: many(listingSubmissionEvents),
  faqs: many(listingSubmissionFaqs),
  listing: one(listings, {
    fields: [listingSubmissions.listingId],
    references: [listings.id]
  }),
  notifications: many(listingSubmissionNotifications),
  resourceLinks: many(listingSubmissionResourceLinks),
  site: one(sites, { fields: [listingSubmissions.siteId], references: [sites.id] })
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

export const listingSubmissionNotificationsRelations = relations(
  listingSubmissionNotifications,
  ({ one }) => ({
    submission: one(listingSubmissions, {
      fields: [listingSubmissionNotifications.submissionId],
      references: [listingSubmissions.id]
    })
  })
)
