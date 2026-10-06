import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalLocalMigrationsDirectory, validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { applicationTableNames } from './d1-table-inventory'
import { project } from './project'

export { applicationTableNames } from './d1-table-inventory'

export const freshMigrationsDirectory = canonicalLocalMigrationsDirectory

export const d1TriggerNames = [
  'listing_categories_prevent_primary_demote',
  'listing_categories_prevent_primary_removal',
  'listings_require_primary_on_insert',
  'listings_require_primary_on_publication',
  'listing_submissions_refuse_blocked_url'
] as const

export const requiredIndexNames = [
  'categories_public_idx',
  'categories_slug_unique',
  'listing_categories_category_idx',
  'listing_categories_listing_order_idx',
  'listing_categories_one_primary_idx',
  'listing_faqs_listing_order_unique',
  'listing_media_listing_kind_order_unique',
  'listing_resource_links_listing_order_unique',
  'listing_slug_redirects_listing_idx',
  'listing_slug_redirects_old_slug_unique',
  'listing_submission_events_submission_idx',
  'listing_submission_faqs_submission_order_unique',
  'listing_submission_notifications_channel_external_unique',
  'listing_submission_notifications_preview_token_idx',
  'listing_submission_notifications_recipient_idx',
  'listing_submission_resource_links_submission_order_unique',
  'listing_submissions_active_slug_idx',
  'listing_submissions_draft_clock_idx',
  'listing_submissions_listing_idx',
  'listing_submissions_owner_idx',
  'listing_submissions_review_queue_idx',
  'listing_submissions_token_unique',
  'listing_submission_url_blocks_active_idx',
  'listing_submission_url_blocks_submission_idx',
  'listing_owners_current_member_idx',
  'listing_owners_current_owner_idx',
  'listing_owners_listing_idx',
  'listing_owners_user_idx',
  'listing_revisions_author_idx',
  'listing_revisions_listing_idx',
  'listing_revisions_open_idx',
  'listing_revisions_review_queue_idx',
  'listing_revision_events_revision_idx',
  'listing_revision_faqs_revision_order_unique',
  'listing_revision_resource_links_revision_order_unique',
  'badge_checks_listing_time_idx',
  'listing_events_listing_idx',
  'orders_number_idx',
  'orders_open_target_idx',
  'orders_provider_checkout_idx',
  'orders_status_created_idx',
  'orders_submission_idx',
  'orders_listing_idx',
  'orders_user_idx',
  'billing_events_order_idx',
  'listing_claims_listing_idx',
  'listing_claims_open_idx',
  'listing_claims_user_idx',
  'accounts_user_idx',
  'auth_rate_limit_hits_bucket_idx',
  'auth_rate_limit_hits_time_idx',
  'sessions_token_unique',
  'sessions_user_idx',
  'users_email_unique',
  'verification_identifier_idx',
  'listings_display_order_idx',
  'listings_featured_idx',
  'listings_publication_idx',
  'listings_related_name_idx',
  'listings_slug_unique',
  'listings_website_idx',
  'media_ingestions_due_idx',
  'media_ingestions_listing_slot_idx',
  'media_ingestions_submission_slot_idx',
  'migration_runs_manifest_unique',
  'migration_runs_time_idx',
  'publication_runs_manifest_unique',
  'publication_runs_time_idx'
] as const

interface SchemaObject {
  name: string
  sql: string | null
  type: 'index' | 'table' | 'trigger'
}

export function canonicalLocalConfig(): {
  configPath: string
  databaseName: string
} {
  validateCanonicalLocalConfig()
  return { configPath: project.wranglerConfigPath, databaseName: project.local.databaseName }
}

function wrangler(args: string[], capture = false): string {
  const { configPath, databaseName } = canonicalLocalConfig()
  return (
    execFileSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        ...args.map(value => (value === '$DATABASE' ? databaseName : value)),
        '--local',
        '--persist-to',
        configuredFreshD1StateRoot(),
        '--config',
        configPath
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
      }
    ) || ''
  )
}

function query(command: string): SchemaObject[] {
  const output = wrangler(['execute', '$DATABASE', '--command', command, '--json'], true)
  const parsed = JSON.parse(output) as Array<{ results?: SchemaObject[]; success?: boolean }>
  if (parsed.length !== 1 || parsed[0]?.success !== true || !Array.isArray(parsed[0].results)) {
    throw new Error('Local D1 returned an unsuccessful or malformed schema result.')
  }
  return parsed[0].results
}

export function freshMigrationNames(): string[] {
  return readdirSync(freshMigrationsDirectory)
    .filter(name => name.endsWith('.sql'))
    .sort()
}

function assertExactNames(actual: string[], expected: readonly string[], label: string): void {
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  if (sortedActual.join('\0') !== sortedExpected.join('\0')) {
    throw new Error(
      `Fresh D1 ${label} mismatch. Expected ${sortedExpected.join(', ')}; received ${sortedActual.join(', ')}.`
    )
  }
}

function verify(): void {
  const objects = query(
    `SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY type, name`
  )
  const applicationTables = objects.filter(
    object => object.type === 'table' && object.name !== project.migrationsTable
  )
  assertExactNames(
    applicationTables.map(object => object.name),
    applicationTableNames,
    'application tables'
  )
  const nonStrict = applicationTables.filter(object => !object.sql?.trimEnd().endsWith('STRICT'))
  if (nonStrict.length > 0) {
    throw new Error(
      `Fresh D1 tables are not STRICT: ${nonStrict.map(object => object.name).join(', ')}.`
    )
  }
  assertExactNames(
    objects.filter(object => object.type === 'trigger').map(object => object.name),
    d1TriggerNames,
    'triggers'
  )
  const indexes = objects.filter(object => object.type === 'index').map(object => object.name)
  const missingIndexes = requiredIndexNames.filter(name => !indexes.includes(name))
  if (missingIndexes.length > 0) {
    throw new Error(`Fresh D1 is missing indexes: ${missingIndexes.join(', ')}.`)
  }
  const ledger = query(`SELECT name FROM ${project.migrationsTable} ORDER BY name`) as Array<{
    name: string
  }>
  assertExactNames(
    ledger.map(row => row.name),
    freshMigrationNames(),
    'migration ledger'
  )
  console.log(
    JSON.stringify({
      database: project.local.databaseName,
      domain: project.domain,
      migrations: freshMigrationNames(),
      status: 'verified',
      tables: applicationTables.length
    })
  )
}

export function runDrizzleLocalCommand(args: string[]): void {
  const [command, ...rest] = args.filter(value => value !== '--')
  if (rest.length > 0) {
    throw new Error(
      `Unexpected arguments: ${rest.join(' ')}. Fresh Drizzle D1 commands target only the local ${project.domain} database and take no --site.`
    )
  }
  if (command === 'generate') {
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--config', 'drizzle.config.ts'], {
      env: process.env,
      stdio: 'inherit'
    })
    return
  }
  if (command === 'list') {
    wrangler(['migrations', 'list', '$DATABASE'])
    return
  }
  if (command === 'apply') {
    wrangler(['migrations', 'apply', '$DATABASE'])
    return
  }
  if (command === 'verify') {
    verify()
    return
  }
  throw new Error(
    `Unknown fresh Drizzle D1 command: ${command || 'missing'}. Use generate, list, apply, or verify.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    runDrizzleLocalCommand(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
