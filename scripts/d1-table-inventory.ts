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
    'display_order',
    'source',
    'link_rel'
  ],
  listing_categories: ['listing_id', 'category_id', 'sort_order', 'is_primary'],
  listing_media: [
    'id',
    'listing_id',
    'kind',
    'url',
    'sort_order',
    'media_key',
    'sha256',
    'content_type',
    'bytes',
    'width',
    'height'
  ],
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
    'updated_at',
    'owner_user_id',
    'plan',
    'paid_at',
    'refunded_at',
    'reviewer_note',
    'rejection_reason',
    'rejection_category',
    'draft_saved_at',
    'draft_reminders_sent',
    'draft_last_reminder_at',
    'withdrawal_reason',
    'block_key',
    'block_covers_subdomains',
    'published_checksum',
    'content_version'
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
    'template_id',
    'event_key',
    'provider',
    'status',
    'attempts',
    'provider_message_id',
    'last_error_code',
    'created_at',
    'updated_at'
  ],
  users: ['id', 'name', 'email', 'email_verified', 'image', 'role', 'created_at', 'updated_at'],
  sessions: [
    'id',
    'expires_at',
    'token',
    'created_at',
    'updated_at',
    'ip_address',
    'user_agent',
    'user_id'
  ],
  accounts: [
    'id',
    'account_id',
    'provider_id',
    'user_id',
    'access_token',
    'refresh_token',
    'id_token',
    'access_token_expires_at',
    'refresh_token_expires_at',
    'scope',
    'password',
    'created_at',
    'updated_at'
  ],
  verification: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
  admin_allowlist: ['email', 'note', 'added_by', 'created_at'],
  auth_rate_limit_hits: ['id', 'bucket', 'hit_at'],
  listing_submission_url_blocks: [
    'id',
    'url_key',
    'submission_id',
    'reason',
    'blocked_by',
    'blocked_at',
    'lifted_at',
    'lifted_by',
    'lift_note',
    'covers_subdomains'
  ],
  listing_owners: [
    'id',
    'listing_id',
    'user_id',
    'role',
    'verified_via',
    'verified_at',
    'revoked_at',
    'revoked_reason',
    'created_at'
  ],
  listing_revisions: [
    'id',
    'listing_id',
    'author_user_id',
    'status',
    'base_checksum',
    'name',
    'description',
    'content',
    'category_slug',
    'logo_url',
    'video_url',
    'reviewer_note',
    'rejection_reason',
    'reviewed_at',
    'reviewed_by',
    'created_at',
    'updated_at',
    'content_version'
  ],
  listing_revision_resource_links: ['id', 'revision_id', 'label', 'url', 'sort_order'],
  listing_revision_faqs: ['id', 'revision_id', 'question', 'answer', 'sort_order'],
  listing_revision_events: ['id', 'revision_id', 'event_type', 'detail', 'actor', 'created_at'],
  badge_checks: ['id', 'listing_id', 'checked_at', 'outcome', 'reason', 'conclusive', 'kind'],
  listing_claims: [
    'id',
    'listing_id',
    'user_id',
    'method',
    'status',
    'email',
    'email_domain',
    'product_url',
    'code_hash',
    'code_sent_at',
    'code_expires_at',
    'codes_sent',
    'attempts',
    'locked_until',
    'email_verified_at',
    'badge_checked_at',
    'completed_at',
    'created_at',
    'updated_at'
  ],
  listing_events: ['id', 'listing_id', 'event_type', 'detail', 'actor', 'created_at'],
  media_ingestions: [
    'id',
    'listing_id',
    'submission_id',
    'revision_id',
    'kind',
    'sort_order',
    'source_url',
    'copy_from_key',
    'status',
    'attempts',
    'next_attempt_at',
    'last_error',
    'media_key',
    'sha256',
    'content_type',
    'bytes',
    'width',
    'height',
    'created_at',
    'updated_at'
  ]
} as const

export type ApplicationTableName = keyof typeof applicationColumnInventory

export const applicationTableNames = Object.keys(
  applicationColumnInventory
) as ApplicationTableName[]

/**
 * Tables written at runtime: Better Auth and its sign-in limits (#60), the transactional email
 * ledger (#71), and the media ingestion queue (#95). They belong to the exact schema inventory,
 * but not to bootstrap parity: the import never writes them, and a database that has served a
 * sign-in, sent an email, or ingested an image (local preview, Playwright, a deployed Worker)
 * holds rows.
 */
export const runtimeTableNames = [
  'users',
  'sessions',
  'accounts',
  'verification',
  'auth_rate_limit_hits',
  'email_deliveries',
  'media_ingestions'
] as const satisfies readonly ApplicationTableName[]

export type ParityTableName = Exclude<ApplicationTableName, (typeof runtimeTableNames)[number]>

/** Tables whose rows bootstrap parity (`db:verify:local`, `verify-import`) compares exactly. */
export const parityTableNames = applicationTableNames.filter(
  (table): table is ParityTableName => !(runtimeTableNames as readonly string[]).includes(table)
)

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
  'users',
  'sessions',
  'accounts',
  'verification',
  'admin_allowlist',
  'auth_rate_limit_hits',
  'listing_submissions',
  'listing_submission_resource_links',
  'listing_submission_faqs',
  'listing_submission_events',
  'listing_submission_rate_limits',
  'listing_submission_notifications',
  'email_deliveries',
  'listing_submission_url_blocks',
  'listing_owners',
  'listing_revisions',
  'listing_revision_resource_links',
  'listing_revision_faqs',
  'listing_revision_events',
  'badge_checks',
  'listing_claims',
  'listing_events',
  'media_ingestions'
]

export const toolOwnedTableNames = ['d1_migrations'] as const
