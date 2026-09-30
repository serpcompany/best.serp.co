export const canonicalLegacyMigrationNames = [
  '0001_public_catalog.sql',
  '0002_listing_slug_redirects.sql',
  '0003_publication_run_provenance.sql',
  '0004_listing_display_order.sql',
  '0005_listing_submissions.sql',
  '0006_submission_rate_limits.sql',
  '0007_submission_notifications.sql',
  '0008_submission_review_preview.sql',
  '0009_related_listing_name_index.sql'
] as const

export const applicationColumnInventory = {
  sites: ['id', 'created_at', 'updated_at'],
  categories: [
    'id',
    'site_id',
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
    'site_id',
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
  publication_state: ['site_id', 'version', 'manifest_id', 'checksum', 'published_at'],
  migration_runs: [
    'id',
    'site_id',
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
    'site_id',
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
    'site_id',
    'listing_id',
    'old_slug',
    'new_slug',
    'manifest_id',
    'reason',
    'created_at'
  ],
  listing_submissions: [
    'id',
    'site_id',
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
  ]
} as const

export type ApplicationTableName = keyof typeof applicationColumnInventory

export const applicationTableNames = Object.keys(
  applicationColumnInventory
) as ApplicationTableName[]

export const importOrder: ApplicationTableName[] = [
  'sites',
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
  'listing_submission_notifications'
]

export const toolOwnedTableNames = ['d1_migrations'] as const
