import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  applicationChecksumFromTableSummaries,
  canonicalRowFromSqlite,
  canonicalRowPayload
} from './d1-application-snapshot'
import { type ApplicationSnapshot, readRemoteApplicationSnapshot } from './d1-preview-snapshot'
import {
  applicationColumnInventory,
  applicationTableNames,
  canonicalLegacyMigrationNames
} from './d1-replatform-inventory'
import { resolveSiteTarget, type SiteId } from './site-targets'

interface SchemaObject {
  name: string
  sql: string
  table: string
  type: string
}
export interface LegacySourceObservation {
  applicationSnapshot: ApplicationSnapshot
  hasMigrationLedger: boolean
  migrationNames: string[]
  schemaFingerprint: string
  siteIds: string[]
  unexpectedUserObjects: string[]
}
export interface ExpectedLegacySource {
  applicationSnapshotChecksum: string
  applicationTables: ApplicationSnapshot['tables']
  migrationNames: string[]
  schemaFingerprint: string
  siteId: SiteId
}

export function assertCanonicalLegacyMigrationSet(actual: readonly string[]): void {
  if (actual.join('\0') !== canonicalLegacyMigrationNames.join('\0'))
    throw new Error('d1/migrations SQL set must equal canonical immutable 0001-0009 exactly.')
}

function normalizeSchema(rows: SchemaObject[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map(row => ({
            ...row,
            sql: row.sql.replaceAll(/\s+/gu, ' ').trim().replace(/;$/u, '')
          }))
          .sort((left, right) =>
            `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
          )
      )
    )
    .digest('hex')
}
function canonicalRows(
  database: DatabaseSync,
  table: keyof typeof applicationColumnInventory
): string {
  const columns = applicationColumnInventory[table]
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  return database
    .prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`)
    .all()
    .map(row => canonicalRowPayload(canonicalRowFromSqlite(row, columns)))
    .sort()
    .join('\n')
}
function localApplicationSnapshot(
  database: DatabaseSync
): Pick<ApplicationSnapshot, 'checksum' | 'tables'> {
  const tables = Object.fromEntries(
    applicationTableNames.map(table => {
      const payload = canonicalRows(database, table)
      const count = Number(database.prepare(`SELECT COUNT(*) count FROM "${table}"`).get()?.count)
      return [table, { count, checksum: createHash('sha256').update(payload).digest('hex') }]
    })
  )
  return { checksum: applicationChecksumFromTableSummaries(tables), tables }
}
export function buildExpectedLegacySource(siteId: SiteId): ExpectedLegacySource {
  const target = resolveSiteTarget(siteId)
  const database = new DatabaseSync(':memory:', { readBigInts: true })
  try {
    const migrationNames = readdirSync(resolve('d1/migrations'))
      .filter(name => name.endsWith('.sql'))
      .sort()
    assertCanonicalLegacyMigrationSet(migrationNames)
    for (const name of migrationNames)
      database.exec(readFileSync(resolve('d1/migrations', name), 'utf8'))
    const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
      parity: { importBatches: number }
    }
    for (let index = 1; index <= report.parity.importBatches; index += 1)
      database.exec(
        readFileSync(
          resolve(target.artifactBatchDirectory, `${String(index).padStart(4, '0')}.sql`),
          'utf8'
        )
      )
    const schema = database
      .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations'
      ORDER BY type,name`)
      .all()
      .map(row => ({
        name: String(row.name),
        sql: String(row.sql),
        table: String(row.tbl_name),
        type: String(row.type)
      }))
    const applicationSnapshot = localApplicationSnapshot(database)
    return {
      applicationSnapshotChecksum: applicationSnapshot.checksum,
      applicationTables: applicationSnapshot.tables,
      migrationNames,
      schemaFingerprint: normalizeSchema(schema),
      siteId
    }
  } finally {
    database.close()
  }
}

export function classifyLegacySource(
  observed: LegacySourceObservation,
  expected: ExpectedLegacySource
): 'blank' | 'controlled-populated' {
  const hasApplicationRows = Object.values(observed.applicationSnapshot.tables).some(
    table => table.count > 0
  )
  const hasSchema = observed.schemaFingerprint !== normalizeSchema([])
  if (
    !hasApplicationRows &&
    !hasSchema &&
    !observed.hasMigrationLedger &&
    observed.unexpectedUserObjects.length === 0 &&
    observed.siteIds.length === 0
  )
    return 'blank'
  if (observed.unexpectedUserObjects.length > 0)
    throw new Error('Legacy Preview source has unexpected user schema.')
  if (!observed.hasMigrationLedger)
    throw new Error('Legacy Preview source migration ledger is missing.')
  if (observed.migrationNames.join('\0') !== expected.migrationNames.join('\0'))
    throw new Error('Legacy Preview source migration ledger differs.')
  if (observed.siteIds.join('\0') !== expected.siteId)
    throw new Error('Legacy Preview source Site identity differs.')
  if (observed.schemaFingerprint !== expected.schemaFingerprint)
    throw new Error('Legacy Preview source schema fingerprint differs.')
  if (observed.applicationSnapshot.checksum !== expected.applicationSnapshotChecksum)
    throw new Error('Legacy Preview source application/audit snapshot differs.')
  for (const table of [
    'listing_submissions',
    'listing_submission_notifications',
    'listing_submission_rate_limits'
  ])
    if (observed.applicationSnapshot.tables[table]?.count !== 0)
      throw new Error('Legacy Preview source contains private state.')
  return 'controlled-populated'
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
export async function remotePreviewQuery(
  databaseId: string,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql, params: [] })
    }
  )
  const payload = (await response.json()) as {
    result?: Array<{ results?: Array<Record<string, unknown>>; success?: boolean }>
    success?: boolean
  }
  if (
    !response.ok ||
    payload.success === false ||
    payload.result?.[0]?.success === false ||
    !payload.result
  )
    throw new Error('Legacy Preview source classification query failed.')
  return payload.result[0]?.results ?? []
}
export async function observeLegacySource(databaseId: string): Promise<LegacySourceObservation> {
  const schemaRows = await remotePreviewQuery(
    databaseId,
    `SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name`
  )
  const names = schemaRows.map(row => String(row.name))
  const applicationSchema = schemaRows
    .filter(row => row.name !== 'd1_migrations')
    .map(row => ({
      name: String(row.name),
      sql: String(row.sql),
      table: String(row.tbl_name),
      type: String(row.type)
    }))
  const known = new Set([...applicationTableNames, 'd1_migrations'])
  const unexpectedUserObjects = names.filter(
    name =>
      !known.has(name as never) &&
      !applicationSchema.some(
        object => object.table && applicationTableNames.includes(object.table as never)
      )
  )
  const applicationSnapshot = await readRemoteApplicationSnapshot(databaseId)
  const siteIds = names.includes('sites')
    ? (await remotePreviewQuery(databaseId, 'SELECT id FROM sites ORDER BY id')).map(row =>
        String(row.id)
      )
    : []
  return {
    applicationSnapshot,
    hasMigrationLedger: names.includes('d1_migrations'),
    migrationNames: applicationSnapshot.migrationNames.map(String),
    schemaFingerprint: normalizeSchema(applicationSchema),
    siteIds,
    unexpectedUserObjects
  }
}
async function main(): Promise<void> {
  const [siteValue, output] = process.argv.slice(2)
  if (!siteValue || !output)
    throw new Error('Usage: d1-preview-source-classify.ts <site> <output.json>')
  const siteId = resolveSiteTarget(siteValue).siteId
  const databaseId = required('CLOUDFLARE_D1_PREVIEW_DATABASE_ID')
  const observed = await observeLegacySource(databaseId)
  const expected = buildExpectedLegacySource(siteId)
  const classification = classifyLegacySource(observed, expected)
  writeFileSync(
    resolve(output),
    `${JSON.stringify({ classification, expected, observed }, null, 2)}\n`
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
