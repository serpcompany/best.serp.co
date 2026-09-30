import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildExpectedLegacySource,
  classifyLegacySource,
  type ExpectedLegacySource,
  type LegacySourceObservation,
  observeLegacySource
} from './d1-preview-source-classify'
import { applicationColumnInventory, applicationTableNames } from './d1-replatform-inventory'
import { replatformPreviewRef, resolveSiteTarget } from './site-targets'

const pvdSiteId = 'pornvideodownloaders.com' as const
const privateTables = [
  'listing_submissions',
  'listing_submission_resource_links',
  'listing_submission_faqs',
  'listing_submission_events',
  'listing_submission_rate_limits',
  'listing_submission_notifications'
] as const
export const pvdReviewedPrivateTableProof = {
  listing_submissions: {
    count: 1,
    checksum: 'b43a1c7cf6421eb1ca7d192a7d4321331ef9c98c4acc8e6cb8ec47b2d7bb7e2a'
  },
  listing_submission_events: {
    count: 1,
    checksum: '8d840ee27bdd64896b48eaca3851b3ee7d09304a4afc10eafd3606435e2906d2'
  },
  listing_submission_rate_limits: {
    count: 1,
    checksum: '374ec3467322c877fdc2291cfa87b01cb03768b4a1dd3aa2694ffbd2136f40ee'
  },
  listing_submission_resource_links: {
    count: 0,
    checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  },
  listing_submission_faqs: {
    count: 0,
    checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  },
  listing_submission_notifications: {
    count: 0,
    checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }
} as const

type QueryPlan = { params: unknown[]; sql: string }
type QueryResult = { results?: Array<Record<string, unknown>>; success?: boolean }
type PrivateTableProof = Record<(typeof privateTables)[number], { checksum: string; count: number }>

interface SanitizationDependencies {
  fetcher: typeof fetch
  now: () => number
  observe(databaseId: string): Promise<LegacySourceObservation>
  readFile(path: string): Buffer
  reviewedPrivateTableProof: PrivateTableProof
}

const defaultDependencies: SanitizationDependencies = {
  fetcher: fetch,
  now: Date.now,
  observe: observeLegacySource,
  readFile: path => readFileSync(path),
  reviewedPrivateTableProof: pvdReviewedPrivateTableProof
}

export interface SanitizationResult {
  afterChecksum: string
  backupSha256: string
  beforeChecksum: string
  eventId: string | null
  mode: 'already-sanitized' | 'recovered-after-uncertain-response' | 'sanitized'
  reviewedPrivateTableProof: PrivateTableProof
  rateFingerprint: string | null
  siteId: typeof pvdSiteId
  submissionId: string | null
}

interface PrivateGraph {
  eventId: string
  eventRow: Record<string, unknown>
  rateFingerprint: string
  rateRow: Record<string, unknown>
  submissionId: string
  submissionRow: Record<string, unknown>
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function readObject(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(resolve(path), 'utf8')), path)
}

function assertProtectedContext(
  identity: Record<string, unknown>,
  backupPath: string,
  env: NodeJS.ProcessEnv,
  dependencies: SanitizationDependencies
): { backupSha256: string; databaseId: string } {
  const target = resolveSiteTarget(pvdSiteId)
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REF !== replatformPreviewRef ||
    !env.GITHUB_WORKFLOW_REF?.endsWith(
      `/.github/workflows/rehearse-d1-replatform-preview.yml@${replatformPreviewRef}`
    ) ||
    env.WORKER_PRODUCTION_CONFIRM !== target.confirmation.replatform.preview
  )
    throw new Error('PVD Preview sanitization requires the exact protected rehearsal workflow.')
  const sha = required(env, 'GITHUB_SHA')
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('GITHUB_SHA must be a full lowercase SHA-1.')
  const expected = object(identity.expected, 'identity.expected')
  const observed = object(identity.observed, 'identity.observed')
  if (
    JSON.stringify(expected) !== JSON.stringify(observed) ||
    expected.siteId !== pvdSiteId ||
    expected.environment !== 'preview' ||
    expected.protectedEnvironment !== target.protectedEnvironment.preview ||
    identity.runId !== required(env, 'REPLATFORM_PREVIEW_RUN_ID') ||
    identity.workerState !== 'existing-exact'
  )
    throw new Error('Fresh exact PVD Preview identity proof is required before sanitization.')
  const verifiedAt = Date.parse(String(identity.verifiedAt ?? ''))
  if (!Number.isFinite(verifiedAt) || dependencies.now() - verifiedAt > 120_000)
    throw new Error('PVD Preview identity proof is stale.')
  const databaseId = required(env, 'CLOUDFLARE_D1_PREVIEW_DATABASE_ID')
  if (
    expected.sourceDatabaseId !== databaseId ||
    expected.sourceDatabaseName !== required(env, 'CLOUDFLARE_D1_PREVIEW_DATABASE_NAME')
  )
    throw new Error('PVD Preview source identity differs from the protected environment.')
  const resolvedBackup = resolve(backupPath)
  const backupRoot = resolve('.wrangler/backups/pornvideodownloaders-com/preview')
  const contained = relative(backupRoot, resolvedBackup)
  if (
    !contained ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    contained !== `${sha}.sql`
  )
    throw new Error('Sanitization requires this commit’s exact retained source Preview backup.')
  const backup = dependencies.readFile(resolvedBackup)
  if (backup.length === 0) throw new Error('PVD Preview source backup is empty.')
  return { backupSha256: createHash('sha256').update(backup).digest('hex'), databaseId }
}

function assertFoundation(observed: LegacySourceObservation, expected: ExpectedLegacySource): void {
  if (
    observed.unexpectedUserObjects.length > 0 ||
    !observed.hasMigrationLedger ||
    observed.migrationNames.join('\0') !== expected.migrationNames.join('\0') ||
    observed.siteIds.join('\0') !== pvdSiteId ||
    observed.schemaFingerprint !== expected.schemaFingerprint
  )
    throw new Error('PVD Preview source schema, ledger, or Site identity differs.')
  for (const table of applicationTableNames) {
    if (privateTables.includes(table as (typeof privateTables)[number])) continue
    const actual = observed.applicationSnapshot.tables[table]
    const fixture = expected.applicationTables[table]
    if (
      !actual ||
      !fixture ||
      actual.count !== fixture.count ||
      actual.checksum !== fixture.checksum
    )
      throw new Error(
        `PVD Preview public/audit table ${table} differs from the controlled fixture.`
      )
  }
}

async function query(
  databaseId: string,
  plans: QueryPlan[],
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  reviewedProof: SanitizationDependencies['reviewedPrivateTableProof']
): Promise<QueryResult[]> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${required(env, 'CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required(env, 'CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch: plans.map(plan => ({ sql: plan.sql, params: plan.params })) })
    }
  )
  const payload = (await response.json()) as {
    errors?: Array<{ message?: string }>
    result?: QueryResult[]
    success?: boolean
  }
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(result => result.success === false)
  )
    throw new Error(
      payload.errors
        ?.map(error => error.message)
        .filter(Boolean)
        .join('; ') || 'PVD Preview sanitization D1 operation failed.'
    )
  return payload.result
}

function oneRow(result: QueryResult | undefined, label: string): Record<string, unknown> {
  const rows = result?.results ?? []
  if (rows.length !== 1) throw new Error(`Expected exactly one ${label} row.`)
  return rows[0] as Record<string, unknown>
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function canonicalTableProof(
  rows: Array<Record<string, unknown>>,
  columns: readonly string[]
): { checksum: string; count: number } {
  const payload = rows
    .map(row => JSON.stringify(columns.map(column => row[column] ?? null)))
    .sort()
    .join('\n')
  return { count: rows.length, checksum: createHash('sha256').update(payload).digest('hex') }
}

async function inspectPrivateGraph(
  databaseId: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  reviewedProof: SanitizationDependencies['reviewedPrivateTableProof']
): Promise<PrivateGraph | null> {
  const selectedTables = [
    'listing_submissions',
    'listing_submission_events',
    'listing_submission_rate_limits',
    'listing_submission_resource_links',
    'listing_submission_faqs',
    'listing_submission_notifications'
  ] as const
  const results = await query(
    databaseId,
    selectedTables.map(table => ({
      sql: `SELECT ${applicationColumnInventory[table].map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(table)}`,
      params: []
    })),
    env,
    fetcher
  )
  const counts = results.map(result => result.results?.length ?? 0)
  if (counts.every(count => count === 0)) return null
  for (const [index, table] of selectedTables.entries()) {
    const observedProof = canonicalTableProof(
      results[index]?.results ?? [],
      applicationColumnInventory[table]
    )
    const expectedProof = reviewedProof[table]
    if (
      observedProof.count !== expectedProof.count ||
      observedProof.checksum !== expectedProof.checksum
    )
      throw new Error(`PVD Preview ${table} does not match the reviewed private-row digest.`)
  }
  const submission = oneRow(results[0], 'submission')
  const event = oneRow(results[1], 'submission event')
  const rate = oneRow(results[2], 'rate-limit')
  if (
    submission.site_id !== pvdSiteId ||
    submission.listing_id !== null ||
    !['pending_badge', 'verified'].includes(String(submission.status)) ||
    event.submission_id !== submission.id
  )
    throw new Error('PVD Preview private rows do not form the expected isolated submission graph.')
  const submissionId = String(submission.id ?? '')
  const eventId = String(event.id ?? '')
  const rateFingerprint = String(rate.fingerprint_hash ?? '')
  if (!submissionId || !eventId || !rateFingerprint)
    throw new Error('PVD Preview private graph identifiers are missing.')
  return {
    eventId,
    eventRow: event,
    rateFingerprint,
    rateRow: rate,
    submissionId,
    submissionRow: submission
  }
}

function exactRowDelete(
  table: keyof typeof applicationColumnInventory,
  row: Record<string, unknown>
): QueryPlan {
  const columns = applicationColumnInventory[table]
  return {
    sql: `DELETE FROM ${quoteIdentifier(table)} WHERE ${columns.map(column => `${quoteIdentifier(column)} IS ?`).join(' AND ')}`,
    params: columns.map(column => row[column] ?? null)
  }
}

function exactDeletePlans(graph: PrivateGraph): QueryPlan[] {
  const assertOne = (label: string): QueryPlan => ({
    sql: `SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('${label}', '$[') END AS exact_delete`,
    params: []
  })
  return [
    exactRowDelete('listing_submission_events', graph.eventRow),
    assertOne('event-delete-mismatch'),
    exactRowDelete('listing_submission_rate_limits', graph.rateRow),
    assertOne('rate-delete-mismatch'),
    exactRowDelete('listing_submissions', graph.submissionRow),
    assertOne('submission-delete-mismatch')
  ]
}

export async function sanitizePvdPreview(options: {
  backupPath: string
  env: NodeJS.ProcessEnv
  identity: Record<string, unknown>
  journalPath: string
  dependencies?: SanitizationDependencies
}): Promise<SanitizationResult> {
  const dependencies = options.dependencies ?? defaultDependencies
  const { backupSha256, databaseId } = assertProtectedContext(
    options.identity,
    options.backupPath,
    options.env,
    dependencies
  )
  const expected = buildExpectedLegacySource(pvdSiteId)
  const before = await dependencies.observe(databaseId)
  assertFoundation(before, expected)
  const graph = await inspectPrivateGraph(
    databaseId,
    options.env,
    dependencies.fetcher,
    dependencies.reviewedPrivateTableProof
  )
  const journal = {
    version: 1,
    siteId: pvdSiteId,
    commitSha: options.env.GITHUB_SHA,
    sourceDatabaseId: databaseId,
    backupSha256,
    beforeChecksum: before.applicationSnapshot.checksum,
    expectedAfterChecksum: expected.applicationSnapshotChecksum,
    submissionId: graph?.submissionId ?? null,
    eventId: graph?.eventId ?? null,
    rateFingerprint: graph?.rateFingerprint ?? null,
    reviewedPrivateTableProof: dependencies.reviewedPrivateTableProof
  }
  writeFileSync(resolve(options.journalPath), `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600
  })
  if (!graph) {
    classifyLegacySource(before, expected)
    return {
      afterChecksum: before.applicationSnapshot.checksum,
      backupSha256,
      beforeChecksum: before.applicationSnapshot.checksum,
      eventId: null,
      mode: 'already-sanitized',
      rateFingerprint: null,
      reviewedPrivateTableProof: dependencies.reviewedPrivateTableProof,
      siteId: pvdSiteId,
      submissionId: null
    }
  }

  let uncertain = false
  try {
    await query(databaseId, exactDeletePlans(graph), options.env, dependencies.fetcher)
  } catch {
    uncertain = true
  }
  let after = await dependencies.observe(databaseId)
  try {
    classifyLegacySource(after, expected)
  } catch (error) {
    if (!uncertain) throw error
    const stillPresent = await inspectPrivateGraph(
      databaseId,
      options.env,
      dependencies.fetcher,
      dependencies.reviewedPrivateTableProof
    )
    if (!stillPresent || JSON.stringify(stillPresent) !== JSON.stringify(graph)) throw error
    await query(databaseId, exactDeletePlans(graph), options.env, dependencies.fetcher)
    after = await dependencies.observe(databaseId)
    classifyLegacySource(after, expected)
    uncertain = false
  }
  return {
    afterChecksum: after.applicationSnapshot.checksum,
    backupSha256,
    beforeChecksum: before.applicationSnapshot.checksum,
    eventId: graph.eventId,
    mode: uncertain ? 'recovered-after-uncertain-response' : 'sanitized',
    rateFingerprint: graph.rateFingerprint,
    reviewedPrivateTableProof: dependencies.reviewedPrivateTableProof,
    siteId: pvdSiteId,
    submissionId: graph.submissionId
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const allowed = new Set(['--identity', '--backup', '--journal', '--output'])
  if (args.length !== allowed.size * 2)
    throw new Error('PVD Preview sanitization requires exactly four explicit file flags.')
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value) throw new Error('Every sanitization flag needs a value.')
    if (!allowed.has(flag) || values.has(flag))
      throw new Error(`Unknown or duplicate sanitization flag: ${flag}.`)
    values.set(flag, value)
  }
  const input = (flag: string): string => {
    const value = values.get(flag)
    if (!value) throw new Error(`Missing ${flag}.`)
    return value
  }
  const outputPath = input('--output')
  const result = await sanitizePvdPreview({
    backupPath: input('--backup'),
    env: process.env,
    identity: readObject(input('--identity')),
    journalPath: input('--journal')
  })
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
