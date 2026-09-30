import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { canonicalRowFromSqlite, canonicalRowPayload } from './d1-application-snapshot'
import { freshMigrationNames, legacyRecoveryLocalDatabaseIds } from './d1-drizzle-local'
import { configuredFreshD1StateRoot } from './d1-local-state'
import {
  type ApplicationTableName,
  applicationColumnInventory,
  applicationTableNames,
  canonicalLegacyMigrationNames,
  importOrder,
  toolOwnedTableNames
} from './d1-replatform-inventory'
import { resolveSiteTarget, type SiteId } from './site-targets'

type Row = Record<string, SQLOutputValue>

interface TableSnapshot {
  checksum: string
  count: number
  rows: Row[]
}

interface DatabaseSnapshot {
  checksum: string
  listingIds: string[]
  listingSlugs: string[]
  categorySlugs: string[]
  tables: Record<ApplicationTableName, TableSnapshot>
  totalRows: number
}

interface MigrationOptions {
  now?: () => string
  siteId: SiteId
  sourceDatabaseId: string
  sourcePath: string
  targetDatabaseId: string
  targetPath: string
}

interface MigrationDependencies {
  targetStateRoot?: string
}

export interface MigrationResult {
  categorySlugs: string[]
  listingIds: string[]
  listingSlugs: string[]
  mode: 'imported' | 'verified-no-op'
  siteId: SiteId
  snapshotChecksum: string
  tableChecksums: Record<string, string>
  tableCounts: Record<string, number>
  totalRows: number
}

const receiptPrefix = 'd1-replatform-v1:'

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalRow(row: Row, columns: readonly string[]): string {
  return canonicalRowPayload(canonicalRowFromSqlite(row, columns))
}

function tableRows(
  database: DatabaseSync,
  table: ApplicationTableName,
  excludedReceiptId?: string
): Row[] {
  const columns = applicationColumnInventory[table]
  const where = table === 'migration_runs' && excludedReceiptId ? ' WHERE id != ?' : ''
  const statement = database.prepare(
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}${where}`
  )
  const rows =
    excludedReceiptId && table === 'migration_runs'
      ? statement.all(excludedReceiptId)
      : statement.all()
  return rows.sort((left, right) =>
    compareText(canonicalRow(left, columns), canonicalRow(right, columns))
  )
}

function stringSet(rows: Row[], column: string): string[] {
  return rows
    .map(row => {
      const value = row[column]
      if (typeof value !== 'string') throw new Error(`Expected ${column} to be text.`)
      return value
    })
    .sort()
}

function takeSnapshot(database: DatabaseSync, excludedReceiptId?: string): DatabaseSnapshot {
  const tableEntries = applicationTableNames.map(table => {
    const rows = tableRows(database, table, excludedReceiptId)
    const rowPayload = rows.map(row => canonicalRow(row, applicationColumnInventory[table]))
    return [table, { checksum: sha256(rowPayload.join('\n')), count: rows.length, rows }] as const
  })
  const tables = Object.fromEntries(tableEntries) as DatabaseSnapshot['tables']
  const checksum = sha256(
    JSON.stringify(
      [...tableEntries]
        .sort(([left], [right]) => compareText(left, right))
        .map(([table, snapshot]) => [table, snapshot.count, snapshot.checksum])
    )
  )
  return {
    checksum,
    listingIds: stringSet(tables.listings.rows, 'id'),
    listingSlugs: stringSet(tables.listings.rows, 'slug'),
    categorySlugs: stringSet(tables.categories.rows, 'slug'),
    tables,
    totalRows: tableEntries.reduce((total, [, snapshot]) => total + snapshot.count, 0)
  }
}

function schemaTableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(row => String(row.name))
    .filter(name => !name.startsWith('sqlite_') && !name.startsWith('_cf_'))
}

function schemaFingerprint(database: DatabaseSync): string {
  const definitions = database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND name != 'd1_migrations'
       ORDER BY type, name`
    )
    .all()
    .map(row => ({
      name: String(row.name),
      sql: String(row.sql).replaceAll(/\s+/gu, ' ').trim().replace(/;$/u, ''),
      table: String(row.tbl_name),
      type: String(row.type)
    }))
  return sha256(JSON.stringify(definitions))
}

function expectedFreshSchemaFingerprint(): string {
  const expected = new DatabaseSync(':memory:')
  try {
    for (const migration of freshMigrationNames()) {
      expected.exec(readFileSync(resolve('d1/drizzle', migration), 'utf8'))
    }
    return schemaFingerprint(expected)
  } finally {
    expected.close()
  }
}

function assertSchema(database: DatabaseSync, label: string): void {
  const expectedTables = [...applicationTableNames].sort()
  const actualTables = schemaTableNames(database)
  const unexpected = actualTables.filter(
    table =>
      !expectedTables.includes(table as ApplicationTableName) &&
      !toolOwnedTableNames.includes(table as 'd1_migrations')
  )
  const missing = expectedTables.filter(table => !actualTables.includes(table))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} schema inventory mismatch. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`
    )
  }
  for (const table of applicationTableNames) {
    const actualColumns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map(row => String(row.name))
    const expectedColumns = [...applicationColumnInventory[table]]
    if (actualColumns.join('\0') !== expectedColumns.join('\0')) {
      throw new Error(
        `${label} ${table} column inventory mismatch. Expected ${expectedColumns.join(', ')}; received ${actualColumns.join(', ')}.`
      )
    }
  }
}

function assertExactSet(actual: string[], expected: readonly string[], label: string): void {
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  if (sortedActual.join('\0') !== sortedExpected.join('\0')) {
    throw new Error(
      `${label} mismatch. Expected ${sortedExpected.join(', ')}; received ${sortedActual.join(', ')}.`
    )
  }
}

function assertMigrationLedger(
  database: DatabaseSync,
  expected: readonly string[],
  label: string
): void {
  if (!schemaTableNames(database).includes('d1_migrations')) {
    throw new Error(`${label} is missing the Wrangler d1_migrations ledger.`)
  }
  const names = database
    .prepare('SELECT name FROM d1_migrations ORDER BY name')
    .all()
    .map(row => String(row.name))
  assertExactSet(names, expected, `${label} migration ledger`)
}

function assertFreshSchemaObjects(database: DatabaseSync): void {
  if (schemaFingerprint(database) !== expectedFreshSchemaFingerprint()) {
    throw new Error(
      'Target schema definitions do not exactly match the reviewed fresh Drizzle migration.'
    )
  }
}

function assertHarnessTargetPath(targetPath: string, stateRoot: string): void {
  if (!existsSync(stateRoot)) {
    throw new Error('Selected Site harness D1 state root does not exist.')
  }
  for (const [root, candidate] of [
    [resolve(stateRoot), targetPath],
    [realpathSync(stateRoot), realpathSync(targetPath)]
  ]) {
    const containedPath = relative(root, candidate)
    if (
      !containedPath ||
      containedPath === '..' ||
      containedPath.startsWith(`..${sep}`) ||
      isAbsolute(containedPath)
    ) {
      throw new Error('Target database must be inside the selected Site harness D1 state root.')
    }
  }
}

function assertForeignKeys(database: DatabaseSync, label: string): void {
  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) {
    throw new Error(`${label} has ${violations.length} foreign-key violation(s).`)
  }
}

function assertSourceIdentity(database: DatabaseSync, siteId: SiteId): void {
  const sourceSites = database.prepare('SELECT id FROM sites ORDER BY id').all()
  if (sourceSites.length !== 1 || sourceSites[0]?.id !== siteId) {
    throw new Error(`Source database must contain exactly the explicit Site identity ${siteId}.`)
  }
  const reservedRows = database
    .prepare('SELECT id FROM migration_runs WHERE id LIKE ? ORDER BY id')
    .all(`${receiptPrefix}%`)
  if (reservedRows.length > 0) {
    throw new Error('Source database contains a reserved replatform receipt row.')
  }
}

function receiptIdentity(siteId: SiteId, sourceDatabaseId: string, checksum: string): string {
  return `${receiptPrefix}${siteId}:${sourceDatabaseId}:${checksum}`
}

function receiptId(identity: string): string {
  return `${receiptPrefix}${sha256(identity)}`
}

function readReceipt(database: DatabaseSync): Row | undefined {
  const rows = database
    .prepare('SELECT * FROM migration_runs WHERE id LIKE ? ORDER BY id')
    .all(`${receiptPrefix}%`)
  if (rows.length > 1) throw new Error('Target database contains multiple replatform receipts.')
  return rows[0]
}

function assertEmptyTarget(database: DatabaseSync): void {
  const nonEmpty = applicationTableNames
    .map(table => ({
      count: Number(
        database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count
      ),
      table
    }))
    .filter(entry => entry.count !== 0)
  if (nonEmpty.length > 0) {
    throw new Error(
      `First import requires an empty fresh target; application rows exist in ${nonEmpty.map(entry => entry.table).join(', ')}.`
    )
  }
}

function insertRow(database: DatabaseSync, table: ApplicationTableName, row: Row): void {
  const columns = applicationColumnInventory[table]
  const statement = database.prepare(
    `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  )
  statement.run(...columns.map(column => row[column] ?? null))
}

function writeSnapshot(
  database: DatabaseSync,
  source: DatabaseSnapshot,
  receipt: { id: string; identity: string; siteId: SiteId; timestamp: string }
): void {
  for (const table of importOrder) {
    for (const sourceRow of source.tables[table].rows) {
      const row = { ...sourceRow }
      if (
        table === 'listings' &&
        row.status === 'approved' &&
        row.is_active === 1n &&
        row.published_at !== null
      ) {
        row.status = 'draft'
      }
      insertRow(database, table, row)
    }
  }
  for (const row of source.tables.listings.rows) {
    if (row.status === 'approved' && row.is_active === 1n && row.published_at !== null) {
      database
        .prepare('UPDATE listings SET status = ? WHERE id = ?')
        .run('approved', row.id ?? null)
    }
  }
  insertRow(database, 'migration_runs', {
    id: receipt.id,
    site_id: receipt.siteId,
    schema_version: 1,
    manifest_identity: receipt.identity,
    input_checksum: source.checksum,
    target_checksum: source.checksum,
    affected_records: source.totalRows,
    outcome: 'succeeded',
    error: null,
    started_at: receipt.timestamp,
    completed_at: receipt.timestamp
  })
  assertForeignKeys(database, 'Imported target')
}

function assertExactParity(source: DatabaseSnapshot, target: DatabaseSnapshot): void {
  const mismatches = applicationTableNames.filter(table => {
    const sourceTable = source.tables[table]
    const targetTable = target.tables[table]
    return sourceTable.count !== targetTable.count || sourceTable.checksum !== targetTable.checksum
  })
  if (
    source.checksum !== target.checksum ||
    source.listingIds.join('\0') !== target.listingIds.join('\0') ||
    source.listingSlugs.join('\0') !== target.listingSlugs.join('\0') ||
    source.categorySlugs.join('\0') !== target.categorySlugs.join('\0') ||
    mismatches.length > 0
  ) {
    throw new Error(
      `Source/target parity mismatch${mismatches.length > 0 ? ` in ${mismatches.join(', ')}` : ''}.`
    )
  }
}

function result(
  siteId: SiteId,
  mode: MigrationResult['mode'],
  snapshot: DatabaseSnapshot
): MigrationResult {
  return {
    categorySlugs: snapshot.categorySlugs,
    listingIds: snapshot.listingIds,
    listingSlugs: snapshot.listingSlugs,
    mode,
    siteId,
    snapshotChecksum: snapshot.checksum,
    tableChecksums: Object.fromEntries(
      applicationTableNames.map(table => [table, snapshot.tables[table].checksum])
    ),
    tableCounts: Object.fromEntries(
      applicationTableNames.map(table => [table, snapshot.tables[table].count])
    ),
    totalRows: snapshot.totalRows
  }
}

export function migrateLocalD1(
  options: MigrationOptions,
  dependencies: MigrationDependencies = {}
): MigrationResult {
  const target = resolveSiteTarget(options.siteId)
  if (options.sourceDatabaseId !== legacyRecoveryLocalDatabaseIds[options.siteId]) {
    throw new Error(
      `Source database identity must be the registered local ${options.siteId} database.`
    )
  }
  if (options.targetDatabaseId !== target.local.databaseId) {
    throw new Error(
      `Target database identity must be the registered fresh local ${options.siteId} database.`
    )
  }
  const sourcePath = resolve(options.sourcePath)
  const targetPath = resolve(options.targetPath)
  if (sourcePath === targetPath) throw new Error('Source and target database paths must differ.')
  if (!existsSync(sourcePath) || !existsSync(targetPath)) {
    throw new Error('Source and target database files must already exist locally.')
  }
  assertHarnessTargetPath(
    targetPath,
    dependencies.targetStateRoot ?? configuredFreshD1StateRoot(options.siteId)
  )
  if (realpathSync(sourcePath) === realpathSync(targetPath)) {
    throw new Error('Source and target database files must be physically distinct.')
  }
  const sourceFile = statSync(sourcePath)
  const targetFile = statSync(targetPath)
  if (sourceFile.dev === targetFile.dev && sourceFile.ino === targetFile.ino) {
    throw new Error('Source and target database files must be physically distinct.')
  }

  const source = new DatabaseSync(sourcePath, { readBigInts: true, readOnly: true })
  const destination = new DatabaseSync(targetPath, { readBigInts: true })
  let sourceTransaction = false
  let targetTransaction = false
  try {
    source.exec('PRAGMA query_only = ON')
    source.exec('BEGIN')
    sourceTransaction = true
    destination.exec('PRAGMA foreign_keys = ON')
    destination.exec('BEGIN IMMEDIATE')
    targetTransaction = true
    assertSchema(source, 'Source')
    assertSchema(destination, 'Target')
    assertMigrationLedger(source, canonicalLegacyMigrationNames, 'Source')
    assertMigrationLedger(destination, freshMigrationNames(), 'Target')
    assertFreshSchemaObjects(destination)
    assertSourceIdentity(source, options.siteId)
    assertForeignKeys(source, 'Source')
    const sourceSnapshot = takeSnapshot(source)
    const identity = receiptIdentity(
      options.siteId,
      options.sourceDatabaseId,
      sourceSnapshot.checksum
    )
    const id = receiptId(identity)
    const existingReceipt = readReceipt(destination)

    if (existingReceipt) {
      if (
        existingReceipt.id !== id ||
        existingReceipt.site_id !== options.siteId ||
        existingReceipt.manifest_identity !== identity ||
        existingReceipt.input_checksum !== sourceSnapshot.checksum ||
        existingReceipt.target_checksum !== sourceSnapshot.checksum ||
        existingReceipt.outcome !== 'succeeded'
      ) {
        throw new Error('Target replatform receipt does not exactly match this source snapshot.')
      }
      assertForeignKeys(destination, 'Target')
      const targetSnapshot = takeSnapshot(destination, id)
      assertExactParity(sourceSnapshot, targetSnapshot)
      const verified = result(options.siteId, 'verified-no-op', sourceSnapshot)
      destination.exec('COMMIT')
      targetTransaction = false
      return verified
    }

    assertEmptyTarget(destination)
    writeSnapshot(destination, sourceSnapshot, {
      id,
      identity,
      siteId: options.siteId,
      timestamp: (options.now ?? (() => new Date().toISOString()))()
    })
    const targetSnapshot = takeSnapshot(destination, id)
    assertExactParity(sourceSnapshot, targetSnapshot)
    const imported = result(options.siteId, 'imported', sourceSnapshot)
    destination.exec('COMMIT')
    targetTransaction = false
    return imported
  } finally {
    if (targetTransaction) destination.exec('ROLLBACK')
    if (sourceTransaction) source.exec('ROLLBACK')
    destination.close()
    source.close()
  }
}

function parseArguments(args: string[]): MigrationOptions {
  if (args[0] !== 'migrate') {
    throw new Error(
      'Usage: d1-replatform.ts migrate --site <site> --source <local sqlite> --source-database-id <id> --target <local sqlite> --target-database-id <id>'
    )
  }
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value)
      throw new Error('Every replatform flag requires a value.')
    if (values.has(flag)) throw new Error(`Duplicate replatform flag: ${flag}.`)
    values.set(flag, value)
  }
  const allowed = new Set([
    '--site',
    '--source',
    '--source-database-id',
    '--target',
    '--target-database-id'
  ])
  const unknown = [...values.keys()].filter(flag => !allowed.has(flag))
  if (unknown.length > 0) throw new Error(`Unknown replatform flag(s): ${unknown.join(', ')}.`)
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (!value) throw new Error(`Missing required replatform flag: ${flag}.`)
    return value
  }
  const target = resolveSiteTarget(required('--site'))
  return {
    siteId: target.siteId,
    sourceDatabaseId: required('--source-database-id'),
    sourcePath: required('--source'),
    targetDatabaseId: required('--target-database-id'),
    targetPath: required('--target')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify(migrateLocalD1(parseArguments(process.argv.slice(2)))))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
