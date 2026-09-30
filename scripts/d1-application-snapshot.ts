import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type ApplicationTableName,
  applicationColumnInventory,
  applicationTableNames,
  canonicalLegacyMigrationNames
} from './d1-replatform-inventory'

export interface SqlStatement {
  params: unknown[]
  sql: string
}

export interface SnapshotTransport {
  query(statement: SqlStatement): Promise<Array<Record<string, unknown>>>
}

export type CanonicalValue =
  | { type: 'blob'; value: string }
  | { type: 'integer'; value: string }
  | { type: 'null' }
  | { type: 'real'; value: string }
  | { type: 'text'; value: string }

export interface CanonicalTableSnapshot {
  checksum: string
  columns: readonly string[]
  count: number
  rows: CanonicalValue[][]
}

export interface CanonicalApplicationSnapshot {
  checksum: string
  tables: Record<ApplicationTableName, CanonicalTableSnapshot>
  totalRows: number
  version: 1
}

export interface SchemaProof {
  fingerprint: string
  objects: Array<{ name: string; sql: string; table: string; type: string }>
}

export interface DatabaseProof {
  application: CanonicalApplicationSnapshot
  migrationNames: string[]
  schema: SchemaProof
  siteIds: string[]
}

const emptyChecksum = sha256('')

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function canonicalValuePayload(value: CanonicalValue): string {
  return JSON.stringify(value)
}

export function canonicalRowPayload(row: readonly CanonicalValue[]): string {
  return JSON.stringify(row)
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function canonicalValueFromSqlite(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return { type: 'null' }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (typeof value === 'string') return { type: 'text', value }
  if (value instanceof Uint8Array) {
    return { type: 'blob', value: Buffer.from(value).toString('hex').toUpperCase() }
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { type: 'integer', value: String(value) }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { type: 'real', value: String(value) }
  }
  throw new Error('SQLite returned an unsupported or unsafe canonical value.')
}

export function canonicalRowFromSqlite(
  row: Record<string, unknown>,
  columns: readonly string[]
): CanonicalValue[] {
  return columns.map(column => canonicalValueFromSqlite(row[column]))
}

function assertPageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error('Snapshot page size must be an integer from 1 through 500.')
  }
}

function encodedColumn(column: string, index: number): string {
  const quoted = quoteIdentifier(column)
  return `typeof(${quoted}) AS ${quoteIdentifier(`__t${index}`)}, CASE typeof(${quoted})
    WHEN 'integer' THEN CAST(${quoted} AS TEXT)
    WHEN 'real' THEN printf('%!.17g', ${quoted})
    WHEN 'blob' THEN hex(${quoted})
    WHEN 'text' THEN ${quoted}
    ELSE NULL END AS ${quoteIdentifier(`__v${index}`)}`
}

function parseEncodedValue(
  row: Record<string, unknown>,
  index: number,
  table: ApplicationTableName
): CanonicalValue {
  const type = row[`__t${index}`]
  const value = row[`__v${index}`]
  if (type === 'null') return { type: 'null' }
  if (type === 'integer' && typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/u.test(value)) {
    return { type, value }
  }
  if (type === 'real' && typeof value === 'string') return { type, value }
  if (type === 'text' && typeof value === 'string') return { type, value }
  if (type === 'blob' && typeof value === 'string' && /^(?:[\dA-F]{2})*$/u.test(value)) {
    return { type, value }
  }
  throw new Error(`Snapshot returned an invalid ${table} value at column index ${index}.`)
}

function exclusionClause(table: ApplicationTableName, excludedMigrationRunIds: readonly string[]) {
  if (table !== 'migration_runs' || excludedMigrationRunIds.length === 0) {
    return { params: [] as unknown[], sql: '' }
  }
  return {
    params: [...excludedMigrationRunIds],
    sql: ` WHERE id NOT IN (${excludedMigrationRunIds.map(() => '?').join(',')})`
  }
}

export async function captureCanonicalTable(
  transport: SnapshotTransport,
  table: ApplicationTableName,
  options: { excludedMigrationRunIds?: readonly string[]; pageSize?: number } = {}
): Promise<CanonicalTableSnapshot> {
  const pageSize = options.pageSize ?? 100
  assertPageSize(pageSize)
  const columns = applicationColumnInventory[table]
  const exclusion = exclusionClause(table, options.excludedMigrationRunIds ?? [])
  const order = columns.map(quoteIdentifier).join(',')
  const rows: CanonicalValue[][] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await transport.query({
      sql: `SELECT ${columns.map(encodedColumn).join(',')} FROM ${quoteIdentifier(table)}${exclusion.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      params: [...exclusion.params, pageSize, offset]
    })
    for (const row of page) {
      rows.push(columns.map((_, index) => parseEncodedValue(row, index, table)))
    }
    if (page.length < pageSize) break
  }
  rows.sort((left, right) =>
    compareCanonicalText(canonicalRowPayload(left), canonicalRowPayload(right))
  )
  const payload = rows.map(canonicalRowPayload).join('\n')
  return { checksum: sha256(payload), columns, count: rows.length, rows }
}

export async function captureApplicationSnapshot(
  transport: SnapshotTransport,
  options: { excludedMigrationRunIds?: readonly string[]; pageSize?: number } = {}
): Promise<CanonicalApplicationSnapshot> {
  const entries = [] as Array<[ApplicationTableName, CanonicalTableSnapshot]>
  for (const table of applicationTableNames) {
    entries.push([table, await captureCanonicalTable(transport, table, options)])
  }
  return applicationSnapshotFromTables(
    Object.fromEntries(entries) as CanonicalApplicationSnapshot['tables']
  )
}

export function applicationSnapshotFromTables(
  tables: Record<ApplicationTableName, CanonicalTableSnapshot>
): CanonicalApplicationSnapshot {
  const entries = applicationTableNames.map(table => [table, tables[table]] as const)
  return {
    checksum: applicationChecksumFromTableSummaries(tables),
    tables,
    totalRows: entries.reduce((total, [, snapshot]) => total + snapshot.count, 0),
    version: 1
  }
}

export function applicationChecksumFromTableSummaries(
  tables: Record<string, { checksum: string; count: number }>
): string {
  return sha256(
    JSON.stringify(
      Object.entries(tables)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, snapshot]) => [table, snapshot.count, snapshot.checksum])
    )
  )
}

export function assertCanonicalSnapshotIntegrity(snapshot: CanonicalApplicationSnapshot): void {
  if (snapshot.version !== 1) throw new Error('Unsupported canonical snapshot version.')
  let totalRows = 0
  for (const table of applicationTableNames) {
    const tableSnapshot = snapshot.tables[table]
    if (!tableSnapshot) throw new Error(`Canonical snapshot is missing ${table}.`)
    if (tableSnapshot.columns.join('\0') !== applicationColumnInventory[table].join('\0')) {
      throw new Error(`Canonical snapshot ${table} columns differ from the exact inventory.`)
    }
    if (tableSnapshot.count !== tableSnapshot.rows.length) {
      throw new Error(`Canonical snapshot ${table} count does not match its rows.`)
    }
    const payloads = tableSnapshot.rows.map(row => {
      if (row.length !== tableSnapshot.columns.length) {
        throw new Error(`Canonical snapshot ${table} row width differs from its columns.`)
      }
      for (const value of row) {
        if (!value || typeof value !== 'object' || !('type' in value)) {
          throw new Error(`Canonical snapshot ${table} contains a malformed value.`)
        }
        if (value.type === 'null') continue
        if (typeof value.value !== 'string') {
          throw new Error(`Canonical snapshot ${table} contains a malformed value.`)
        }
        if (value.type === 'integer' && !/^-?(?:0|[1-9]\d*)$/u.test(value.value)) {
          throw new Error(`Canonical snapshot ${table} contains a malformed integer.`)
        }
        if (value.type === 'blob' && !/^(?:[\dA-F]{2})*$/u.test(value.value)) {
          throw new Error(`Canonical snapshot ${table} contains a malformed blob.`)
        }
        if (!['integer', 'real', 'text', 'blob'].includes(value.type)) {
          throw new Error(`Canonical snapshot ${table} contains an unknown storage type.`)
        }
      }
      return canonicalRowPayload(row)
    })
    if (payloads.join('\0') !== [...payloads].sort(compareCanonicalText).join('\0')) {
      throw new Error(`Canonical snapshot ${table} rows are not in canonical order.`)
    }
    if (sha256(payloads.join('\n')) !== tableSnapshot.checksum) {
      throw new Error(`Canonical snapshot ${table} checksum does not match its rows.`)
    }
    totalRows += tableSnapshot.count
  }
  if (snapshot.totalRows !== totalRows) {
    throw new Error('Canonical snapshot total row count is inconsistent.')
  }
  if (snapshot.checksum !== applicationChecksumFromTableSummaries(snapshot.tables)) {
    throw new Error('Canonical whole-snapshot checksum is inconsistent.')
  }
}

function normalizeSchemaSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, ' ').trim().replace(/;$/u, '')
}

export function schemaProof(
  rows: Array<{ name: string; sql: string; table: string; type: string }>
): SchemaProof {
  const objects = rows
    .map(row => ({ ...row, sql: normalizeSchemaSql(row.sql) }))
    .sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`))
  return { fingerprint: sha256(JSON.stringify(objects)), objects }
}

export async function captureSchemaProof(transport: SnapshotTransport): Promise<SchemaProof> {
  const rows = await transport.query({
    sql: `SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
        AND name!='d1_migrations'
      ORDER BY type,name`,
    params: []
  })
  return schemaProof(
    rows.map(row => ({
      name: String(row.name),
      sql: String(row.sql),
      table: String(row.tbl_name),
      type: String(row.type)
    }))
  )
}

export async function captureDatabaseProof(
  transport: SnapshotTransport,
  options: { excludedMigrationRunIds?: readonly string[]; pageSize?: number } = {}
): Promise<DatabaseProof> {
  const schema = await captureSchemaProof(transport)
  const inventory = new Set(
    schema.objects.filter(item => item.type === 'table').map(item => item.name)
  )
  const missing = applicationTableNames.filter(table => !inventory.has(table))
  const unexpectedTables = [...inventory].filter(
    name => !applicationTableNames.includes(name as ApplicationTableName)
  )
  if (missing.length > 0 || unexpectedTables.length > 0) {
    throw new Error(
      `Application schema inventory mismatch. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpectedTables.join(', ') || 'none'}.`
    )
  }
  const [application, migrationRows, siteRows] = await Promise.all([
    captureApplicationSnapshot(transport, options),
    transport.query({ sql: 'SELECT name FROM d1_migrations ORDER BY name', params: [] }),
    transport.query({ sql: 'SELECT id FROM sites ORDER BY id', params: [] })
  ])
  return {
    application,
    migrationNames: migrationRows.map(row => String(row.name)),
    schema,
    siteIds: siteRows.map(row => String(row.id))
  }
}

function localSchemaProof(migrationDirectory: string, names: readonly string[]): SchemaProof {
  const database = new DatabaseSync(':memory:')
  try {
    for (const name of names) database.exec(readFileSync(resolve(migrationDirectory, name), 'utf8'))
    const rows = database
      .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
          AND name!='d1_migrations'
        ORDER BY type,name`)
      .all()
      .map(row => ({
        name: String(row.name),
        sql: String(row.sql),
        table: String(row.tbl_name),
        type: String(row.type)
      }))
    return schemaProof(rows)
  } finally {
    database.close()
  }
}

export function expectedLegacySchemaProof(): SchemaProof {
  const actual = readdirSync(resolve('d1/migrations'))
    .filter(name => name.endsWith('.sql'))
    .sort()
  if (actual.join('\0') !== canonicalLegacyMigrationNames.join('\0')) {
    throw new Error('Legacy migration inventory must remain the canonical immutable 0001-0009 set.')
  }
  return localSchemaProof('d1/migrations', canonicalLegacyMigrationNames)
}

export function freshMigrationNames(): string[] {
  return readdirSync(resolve('d1/drizzle'))
    .filter(name => name.endsWith('.sql'))
    .sort()
}

export function expectedFreshSchemaProof(): SchemaProof {
  return localSchemaProof('d1/drizzle', freshMigrationNames())
}

export function emptyTableSnapshot(table: ApplicationTableName): CanonicalTableSnapshot {
  return {
    checksum: emptyChecksum,
    columns: applicationColumnInventory[table],
    count: 0,
    rows: []
  }
}

export function emptyApplicationSnapshot(): CanonicalApplicationSnapshot {
  const entries = applicationTableNames.map(table => [table, emptyTableSnapshot(table)] as const)
  return {
    checksum: sha256(
      JSON.stringify(
        [...entries]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([table, snapshot]) => [table, snapshot.count, snapshot.checksum])
      )
    ),
    tables: Object.fromEntries(entries) as CanonicalApplicationSnapshot['tables'],
    totalRows: 0,
    version: 1
  }
}

export function snapshotSummary(
  snapshot: CanonicalApplicationSnapshot
): Record<ApplicationTableName, { checksum: string; count: number }> {
  return Object.fromEntries(
    applicationTableNames.map(table => [
      table,
      { checksum: snapshot.tables[table].checksum, count: snapshot.tables[table].count }
    ])
  ) as Record<ApplicationTableName, { checksum: string; count: number }>
}
