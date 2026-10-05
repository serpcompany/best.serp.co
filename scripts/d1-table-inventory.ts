/**
 * Exact application table and column inventory of the D1 schema in
 * `packages/data-ops/src/schema.ts` (applied by the `d1/drizzle` migrations).
 * Snapshot, parity, and verification tooling reads every column listed here, so
 * a schema change must update this inventory in the same change.
 */
export const applicationColumnInventory = {
  categories: [
    'id',
    'slug',
    'name',
    'description',
    'sort_order',
    'is_active',
    'created_at',
    'updated_at'
  ],
  listings: [
    'id',
    'slug',
    'name',
    'description',
    'website',
    'content',
    'entity_type',
    'priority',
    'is_unofficial',
    'is_featured',
    'is_active',
    'status',
    'published_at',
    'source_kind',
    'source_identity',
    'source_updated_at',
    'checksum',
    'created_at',
    'updated_at',
    'display_order'
  ],
  listing_categories: ['listing_id', 'category_id', 'sort_order', 'is_primary'],
  listing_media: ['id', 'listing_id', 'kind', 'url', 'sort_order'],
  listing_resource_links: ['id', 'listing_id', 'label', 'url', 'sort_order'],
  listing_faqs: ['id', 'listing_id', 'question', 'answer', 'sort_order'],
  publication_state: ['id', 'version', 'manifest_id', 'checksum', 'published_at'],
  migration_runs: [
    'id',
    'schema_version',
    'manifest_identity',
    'input_checksum',
    'target_checksum',
    'affected_records',
    'outcome',
    'error',
    'started_at',
    'completed_at'
  ],
  publication_runs: [
    'id',
    'manifest_id',
    'base_version',
    'published_version',
    'input_checksum',
    'affected_records',
    'affected_routes',
    'outcome',
    'error',
    'started_at',
    'completed_at',
    'actor',
    'workflow',
    'before_checksum',
    'after_checksum'
  ],
  listing_slug_redirects: [
    'id',
    'listing_id',
    'old_slug',
    'new_slug',
    'manifest_id',
    'reason',
    'created_at'
  ],
  listing_submissions: [
    'id',
    'slug',
    'name',
    'description',
    'website',
    'content',
    'category_slug',
    'logo_url',
    'video_url',
    'status',
    'access_token_hash',
    'verification_attempts',
    'last_verification_at',
    'last_verification_error',
    'badge_verified_at',
    'reviewed_at',
    'reviewed_by',
    'listing_id',
    'created_at',
    'updated_at'
  ],
  listing_submission_resource_links: ['id', 'submission_id', 'label', 'url', 'sort_order'],
  listing_submission_faqs: ['id', 'submission_id', 'question', 'answer', 'sort_order'],
  listing_submission_events: ['id', 'submission_id', 'event_type', 'detail', 'actor', 'created_at'],
  listing_submission_rate_limits: ['fingerprint_hash', 'window_started_at', 'request_count'],
  listing_submission_notifications: [
    'submission_id',
    'channel',
    'external_id',
    'external_url',
    'recipient',
    'created_at',
    'updated_at',
    'preview_token_hash'
  ],
  email_deliveries: [
    'event_key',
    'template_id',
    'provider',
    'status',
    'attempts',
    'provider_message_id',
    'last_error_code',
    'created_at',
    'updated_at'
  ]
} as const

export type ApplicationTableName = keyof typeof applicationColumnInventory

export const applicationTableNames = Object.keys(
  applicationColumnInventory
) as ApplicationTableName[]

/** Foreign-key-safe order for loading or replaying application rows. */
export const importOrder: ApplicationTableName[] = [
  'categories',
  'listings',
  'listing_categories',
  'listing_media',
  'listing_resource_links',
  'listing_faqs',
  'publication_state',
  'migration_runs',
  'publication_runs',
  'listing_slug_redirects',
  'listing_submissions',
  'listing_submission_resource_links',
  'listing_submission_faqs',
  'listing_submission_events',
  'listing_submission_rate_limits',
  'listing_submission_notifications',
  'email_deliveries'
]

export const toolOwnedTableNames = ['d1_migrations'] as const
