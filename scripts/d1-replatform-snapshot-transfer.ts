import { CUTOVER_LOCK_ID_PREFIX } from '@serpdirectory/data-ops/cutover-lock'
import {
  assertCanonicalSnapshotIntegrity,
  type CanonicalApplicationSnapshot,
  type CanonicalValue,
  canonicalRowPayload,
  captureApplicationSnapshot,
  captureDatabaseProof,
  type DatabaseProof,
  expectedFreshSchemaProof,
  expectedLegacySchemaProof,
  freshMigrationNames,
  quoteIdentifier,
  type SnapshotTransport,
  type SqlStatement,
  sha256
} from './d1-application-snapshot'
import {
  type ApplicationTableName,
  applicationColumnInventory,
  applicationTableNames,
  canonicalLegacyMigrationNames,
  importOrder
} from './d1-replatform-inventory'
import { parseSiteId, type SiteId } from './site-targets'

export interface IdentifiedSnapshotTransport extends SnapshotTransport {
  observeDatabaseIdentity(): Promise<{ databaseId: string }>
}

export interface SnapshotTransferTransport extends SnapshotTransport {
  batch(statements: readonly SqlStatement[]): Promise<void>
}

export interface FrozenSourceSnapshot {
  capturedAt: string
  cutoverId: string
  siteId: SiteId
  snapshot: CanonicalApplicationSnapshot
  sourceDatabaseId: string
  sourceMigrationNames: string[]
  sourceSchemaFingerprint: string
  version: 2
}

export interface MaterializeResult {
  mode: 'imported' | 'resumed' | 'verified-no-op'
  receiptId: string
  siteId: SiteId
  snapshotChecksum: string
  tableChecksums: Record<string, string>
  tableCounts: Record<string, number>
  totalRows: number
}

export interface TransferOptions {
  batchSize?: number
  now?: () => string
  pageSize?: number
}

const stagePrefix = 'd1-replatform-stage-v2:'
const receiptPrefix = 'd1-replatform-v2:'

function textValue(value: CanonicalValue | undefined, label: string): string {
  if (value?.type !== 'text') throw new Error(`${label} must be canonical text.`)
  return value.value
}

function rowObject(
  table: ApplicationTableName,
  row: readonly CanonicalValue[]
): Record<string, CanonicalValue> {
  return Object.fromEntries(
    applicationColumnInventory[table].map((column, index) => [column, row[index]])
  ) as Record<string, CanonicalValue>
}

function proofIdentity(proof: DatabaseProof): string {
  return JSON.stringify({
    application: proof.application.checksum,
    migrationNames: proof.migrationNames,
    schema: proof.schema.fingerprint,
    siteIds: proof.siteIds,
    tables: applicationTableNames.map(table => [
      table,
      proof.application.tables[table].count,
      proof.application.tables[table].checksum
    ])
  })
}

function assertExactList(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${label} differs from the reviewed inventory.`)
  }
}

function assertSourceProof(proof: DatabaseProof, siteId: SiteId, cutoverId: string): void {
  if (proof.siteIds.length !== 1 || proof.siteIds[0] !== siteId) {
    throw new Error(`Frozen source must contain exactly the explicit Site identity ${siteId}.`)
  }
  assertExactList(proof.migrationNames, canonicalLegacyMigrationNames, 'Source migration ledger')
  if (proof.schema.fingerprint !== expectedLegacySchemaProof().fingerprint) {
    throw new Error('Source schema differs from the immutable legacy schema.')
  }
  const lockId = `${CUTOVER_LOCK_ID_PREFIX}${siteId}:${cutoverId}`
  const migrationRows = proof.application.tables.migration_runs.rows.map(row =>
    rowObject('migration_runs', row)
  )
  const lockRows = migrationRows.filter(row => {
    const id = row.id
    const outcome = row.outcome
    return (
      id?.type === 'text' &&
      id.value.startsWith(CUTOVER_LOCK_ID_PREFIX) &&
      outcome?.type === 'text' &&
      outcome.value === 'started'
    )
  })
  if (
    lockRows.length !== 1 ||
    textValue(lockRows[0]?.id, 'Source cutover lock id') !== lockId ||
    textValue(lockRows[0]?.site_id, 'Source cutover lock Site') !== siteId ||
    textValue(lockRows[0]?.outcome, 'Source cutover lock outcome') !== 'started'
  ) {
    throw new Error('Source does not contain the exact active frozen cutover lock.')
  }
  const forbidden = migrationRows.filter(row => {
    const id = row.id
    return (
      id?.type === 'text' &&
      (id.value.startsWith(stagePrefix) ||
        id.value.startsWith(receiptPrefix) ||
        id.value.startsWith('d1-replatform-v1:'))
    )
  })
  if (forbidden.length > 0) throw new Error('Source contains a reserved replatform target row.')
}

function assertFrozenArtifactSource(source: FrozenSourceSnapshot): void {
  const siteId = parseSiteId(source.siteId as string)
  if (!source.cutoverId || source.cutoverId.includes(':')) {
    throw new Error('Frozen snapshot cutover identity is malformed.')
  }
  if (!source.sourceDatabaseId || !source.capturedAt) {
    throw new Error('Frozen snapshot source identity is incomplete.')
  }
  assertCanonicalSnapshotIntegrity(source.snapshot)
  const sites = source.snapshot.tables.sites.rows.map(row => rowObject('sites', row))
  if (sites.length !== 1 || textValue(sites[0]?.id, 'Frozen snapshot Site identity') !== siteId) {
    throw new Error('Frozen snapshot Site identity does not match its envelope.')
  }
  const lockId = `${CUTOVER_LOCK_ID_PREFIX}${siteId}:${source.cutoverId}`
  const migrationRows = source.snapshot.tables.migration_runs.rows.map(row =>
    rowObject('migration_runs', row)
  )
  const locks = migrationRows.filter(row => {
    const id = row.id
    const outcome = row.outcome
    return (
      id?.type === 'text' &&
      id.value.startsWith(CUTOVER_LOCK_ID_PREFIX) &&
      outcome?.type === 'text' &&
      outcome.value === 'started'
    )
  })
  if (
    locks.length !== 1 ||
    textValue(locks[0]?.id, 'Frozen snapshot cutover lock') !== lockId ||
    textValue(locks[0]?.outcome, 'Frozen snapshot cutover lock outcome') !== 'started'
  ) {
    throw new Error('Frozen snapshot does not contain its exact active cutover lock.')
  }
}

export async function captureFrozenSourceSnapshot(
  transport: IdentifiedSnapshotTransport,
  input: { capturedAt: string; cutoverId: string; siteId: string; sourceDatabaseId: string },
  options: Pick<TransferOptions, 'pageSize'> = {}
): Promise<FrozenSourceSnapshot> {
  const siteId = parseSiteId(input.siteId)
  if (!input.cutoverId || input.cutoverId.includes(':')) {
    throw new Error('Cutover identity must be non-empty and must not contain a colon.')
  }
  if (!input.sourceDatabaseId) throw new Error('Source database identity is required.')
  const observedIdentity = await transport.observeDatabaseIdentity()
  if (!observedIdentity.databaseId || observedIdentity.databaseId !== input.sourceDatabaseId) {
    throw new Error('Observed source database identity does not match the requested source UUID.')
  }
  const first = await captureDatabaseProof(transport, { pageSize: options.pageSize })
  assertSourceProof(first, siteId, input.cutoverId)
  const second = await captureDatabaseProof(transport, { pageSize: options.pageSize })
  assertSourceProof(second, siteId, input.cutoverId)
  if (proofIdentity(first) !== proofIdentity(second)) {
    throw new Error('Frozen source drifted while the exact snapshot was being captured.')
  }
  return {
    capturedAt: input.capturedAt,
    cutoverId: input.cutoverId,
    siteId,
    snapshot: first.application,
    sourceDatabaseId: input.sourceDatabaseId,
    sourceMigrationNames: first.migrationNames,
    sourceSchemaFingerprint: first.schema.fingerprint,
    version: 2
  }
}

function transferIdentity(source: FrozenSourceSnapshot): string {
  return JSON.stringify({
    cutoverId: source.cutoverId,
    siteId: source.siteId,
    snapshotChecksum: source.snapshot.checksum,
    sourceDatabaseId: source.sourceDatabaseId,
    sourceMigrationNames: source.sourceMigrationNames,
    sourceSchemaFingerprint: source.sourceSchemaFingerprint,
    version: source.version
  })
}

export function transferStageId(source: FrozenSourceSnapshot): string {
  return `${stagePrefix}${sha256(transferIdentity(source))}`
}

export function transferReceiptId(source: FrozenSourceSnapshot): string {
  return `${receiptPrefix}${sha256(transferIdentity(source))}`
}

function receiptIdentity(source: FrozenSourceSnapshot): string {
  return `d1-replatform-snapshot-v2:${sha256(transferIdentity(source))}`
}

function markerInsert(
  source: FrozenSourceSnapshot,
  id: string,
  outcome: 'started' | 'succeeded',
  timestamp: string
): SqlStatement {
  return {
    sql: `INSERT INTO migration_runs
      (id,site_id,schema_version,manifest_identity,input_checksum,target_checksum,
       affected_records,outcome,error,started_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      id,
      source.siteId,
      '2',
      receiptIdentity(source),
      source.snapshot.checksum,
      source.snapshot.checksum,
      String(source.snapshot.totalRows),
      outcome,
      null,
      timestamp,
      outcome === 'succeeded' ? timestamp : null
    ]
  }
}

function valueExpression(value: CanonicalValue, params: unknown[]): string {
  if (value.type === 'null') return 'NULL'
  if (value.type === 'blob') {
    if (!/^(?:[\dA-F]{2})*$/u.test(value.value)) throw new Error('Canonical blob is malformed.')
    return `X'${value.value}'`
  }
  params.push(value.value)
  if (value.type === 'integer') return 'CAST(? AS INTEGER)'
  if (value.type === 'real') return 'CAST(? AS REAL)'
  return '?'
}

function insertStatement(
  table: ApplicationTableName,
  sourceRow: readonly CanonicalValue[]
): SqlStatement {
  const params: unknown[] = []
  const columns = applicationColumnInventory[table]
  const row = sourceRow.map(value => ({ ...value })) as CanonicalValue[]
  if (table === 'listings') {
    const statusIndex = columns.indexOf('status')
    const activeIndex = columns.indexOf('is_active')
    const publishedIndex = columns.indexOf('published_at')
    if (
      row[statusIndex]?.type === 'text' &&
      row[statusIndex].value === 'approved' &&
      row[activeIndex]?.type === 'integer' &&
      row[activeIndex].value === '1' &&
      row[publishedIndex]?.type !== 'null'
    ) {
      row[statusIndex] = { type: 'text', value: 'draft' }
    }
  }
  return {
    sql: `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${row.map(value => valueExpression(value, params)).join(',')})`,
    params
  }
}

function approvedListingRestores(source: FrozenSourceSnapshot): SqlStatement[] {
  const columns = applicationColumnInventory.listings
  const statusIndex = columns.indexOf('status')
  const idIndex = columns.indexOf('id')
  const activeIndex = columns.indexOf('is_active')
  const publishedIndex = columns.indexOf('published_at')
  return source.snapshot.tables.listings.rows.flatMap(row => {
    if (
      row[statusIndex]?.type !== 'text' ||
      row[statusIndex].value !== 'approved' ||
      row[idIndex]?.type !== 'text' ||
      row[activeIndex]?.type !== 'integer' ||
      row[activeIndex].value !== '1' ||
      row[publishedIndex]?.type === 'null'
    ) {
      return []
    }
    return [
      {
        sql: `UPDATE listings SET status='approved' WHERE id=? AND status='draft'`,
        params: [row[idIndex].value]
      }
    ]
  })
}

function asDraftListing(row: readonly CanonicalValue[]): CanonicalValue[] {
  const result = row.map(value => ({ ...value })) as CanonicalValue[]
  const columns = applicationColumnInventory.listings
  const statusIndex = columns.indexOf('status')
  const activeIndex = columns.indexOf('is_active')
  const publishedIndex = columns.indexOf('published_at')
  if (
    result[statusIndex]?.type === 'text' &&
    result[statusIndex].value === 'approved' &&
    result[activeIndex]?.type === 'integer' &&
    result[activeIndex].value === '1' &&
    result[publishedIndex]?.type !== 'null'
  ) {
    result[statusIndex] = { type: 'text', value: 'draft' }
  }
  return result
}

function assertTargetSubset(
  source: CanonicalApplicationSnapshot,
  target: CanonicalApplicationSnapshot
): void {
  for (const table of applicationTableNames) {
    const expected = new Set(source.tables[table].rows.map(canonicalRowPayload))
    if (table === 'listings') {
      for (const row of source.tables.listings.rows)
        expected.add(canonicalRowPayload(asDraftListing(row)))
    }
    const divergent = target.tables[table].rows.filter(
      row => !expected.has(canonicalRowPayload(row))
    )
    if (divergent.length > 0 || target.tables[table].count > source.tables[table].count) {
      throw new Error(`Target contains divergent partial data in ${table}.`)
    }
  }
}

function assertExactParity(
  source: CanonicalApplicationSnapshot,
  target: CanonicalApplicationSnapshot
): void {
  const mismatches = applicationTableNames.filter(
    table =>
      source.tables[table].count !== target.tables[table].count ||
      source.tables[table].checksum !== target.tables[table].checksum
  )
  if (source.checksum !== target.checksum || mismatches.length > 0) {
    throw new Error(
      `Source/target exact snapshot parity failed${mismatches.length > 0 ? ` in ${mismatches.join(', ')}` : ''}.`
    )
  }
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error('Transfer batch size must be an integer from 1 through 50.')
  }
}

async function executeBounded(
  transport: SnapshotTransferTransport,
  statements: readonly SqlStatement[],
  batchSize: number
): Promise<void> {
  for (let index = 0; index < statements.length; index += batchSize) {
    await transport.batch(statements.slice(index, index + batchSize))
  }
}

async function selectReservedRows(
  transport: SnapshotTransport
): Promise<Array<Record<string, unknown>>> {
  return transport.query({
    sql: `SELECT id,site_id,manifest_identity,input_checksum,target_checksum,affected_records,outcome
      FROM migration_runs
      WHERE id LIKE 'd1-replatform-stage-v2:%' OR id LIKE 'd1-replatform-v2:%'
      ORDER BY id`,
    params: []
  })
}

function assertExactMarker(
  row: Record<string, unknown>,
  source: FrozenSourceSnapshot,
  id: string,
  outcome: 'started' | 'succeeded'
): void {
  if (
    row.id !== id ||
    row.site_id !== source.siteId ||
    row.manifest_identity !== receiptIdentity(source) ||
    row.input_checksum !== source.snapshot.checksum ||
    row.target_checksum !== source.snapshot.checksum ||
    String(row.affected_records) !== String(source.snapshot.totalRows) ||
    row.outcome !== outcome
  ) {
    throw new Error('Target replatform marker belongs to a different cutover or snapshot.')
  }
}

function assertTargetFoundation(proof: DatabaseProof): void {
  assertExactList(proof.migrationNames, freshMigrationNames(), 'Target fresh migration ledger')
  if (proof.schema.fingerprint !== expectedFreshSchemaProof().fingerprint) {
    throw new Error('Target schema differs from the reviewed fresh Drizzle schema.')
  }
}

function result(source: FrozenSourceSnapshot, mode: MaterializeResult['mode']): MaterializeResult {
  return {
    mode,
    receiptId: transferReceiptId(source),
    siteId: source.siteId,
    snapshotChecksum: source.snapshot.checksum,
    tableChecksums: Object.fromEntries(
      applicationTableNames.map(table => [table, source.snapshot.tables[table].checksum])
    ),
    tableCounts: Object.fromEntries(
      applicationTableNames.map(table => [table, source.snapshot.tables[table].count])
    ),
    totalRows: source.snapshot.totalRows
  }
}

export async function materializeFrozenSnapshot(
  transport: SnapshotTransferTransport,
  source: FrozenSourceSnapshot,
  options: TransferOptions = {}
): Promise<MaterializeResult> {
  if (source.version !== 2) throw new Error('Unsupported frozen snapshot version.')
  assertFrozenArtifactSource(source)
  if (
    source.sourceSchemaFingerprint !== expectedLegacySchemaProof().fingerprint ||
    source.sourceMigrationNames.join('\0') !== canonicalLegacyMigrationNames.join('\0')
  ) {
    throw new Error('Frozen snapshot source proof is not the reviewed legacy lineage.')
  }
  const batchSize = options.batchSize ?? 25
  assertBatchSize(batchSize)
  const stageId = transferStageId(source)
  const receiptId = transferReceiptId(source)
  const initialProof = await captureDatabaseProof(transport, {
    excludedMigrationRunIds: [stageId, receiptId],
    pageSize: options.pageSize
  })
  assertTargetFoundation(initialProof)
  const reserved = await selectReservedRows(transport)
  if (reserved.length > 1) throw new Error('Target contains multiple replatform markers.')
  const existing = reserved[0]
  if (existing?.id === receiptId) {
    assertExactMarker(existing, source, receiptId, 'succeeded')
    assertExactParity(source.snapshot, initialProof.application)
    await assertForeignKeys(transport)
    return result(source, 'verified-no-op')
  }
  if (existing && existing.id !== stageId) {
    throw new Error('Target replatform marker belongs to a different cutover or snapshot.')
  }
  const resumed = Boolean(existing)
  if (existing) assertExactMarker(existing, source, stageId, 'started')
  if (!existing && initialProof.application.totalRows !== 0) {
    throw new Error('A populated target without the exact resume marker is not resumable.')
  }
  assertTargetSubset(source.snapshot, initialProof.application)
  const timestamp = (options.now ?? (() => new Date().toISOString()))()
  if (!existing) {
    const siteRows = source.snapshot.tables.sites.rows
    if (siteRows.length !== 1) throw new Error('Frozen snapshot must contain exactly one Site row.')
    await transport.batch([
      insertStatement('sites', siteRows[0] ?? []),
      markerInsert(source, stageId, 'started', timestamp)
    ])
  }

  for (const table of importOrder) {
    await executeBounded(
      transport,
      source.snapshot.tables[table].rows.map(row => insertStatement(table, row)),
      batchSize
    )
  }
  await executeBounded(transport, approvedListingRestores(source), batchSize)
  await assertForeignKeys(transport)
  const beforeReceipt = await captureApplicationSnapshot(transport, {
    excludedMigrationRunIds: [stageId, receiptId],
    pageSize: options.pageSize
  })
  assertExactParity(source.snapshot, beforeReceipt)

  await transport.batch([
    { sql: 'DELETE FROM migration_runs WHERE id=?', params: [stageId] },
    markerInsert(source, receiptId, 'succeeded', timestamp)
  ])
  const afterReceipt = await captureApplicationSnapshot(transport, {
    excludedMigrationRunIds: [receiptId],
    pageSize: options.pageSize
  })
  assertExactParity(source.snapshot, afterReceipt)
  await assertForeignKeys(transport)
  const finalRows = await selectReservedRows(transport)
  if (finalRows.length !== 1) throw new Error('Target final replatform receipt is missing.')
  assertExactMarker(finalRows[0] ?? {}, source, receiptId, 'succeeded')
  return result(source, resumed ? 'resumed' : 'imported')
}

export async function verifyMaterializedSnapshot(
  transport: SnapshotTransferTransport,
  source: FrozenSourceSnapshot,
  options: Pick<TransferOptions, 'pageSize'> = {}
): Promise<MaterializeResult> {
  assertFrozenArtifactSource(source)
  const receiptId = transferReceiptId(source)
  const proof = await captureDatabaseProof(transport, {
    excludedMigrationRunIds: [receiptId],
    pageSize: options.pageSize
  })
  assertTargetFoundation(proof)
  assertExactParity(source.snapshot, proof.application)
  await assertForeignKeys(transport)
  const rows = await selectReservedRows(transport)
  if (rows.length !== 1) throw new Error('Target final replatform receipt is missing.')
  assertExactMarker(rows[0] ?? {}, source, receiptId, 'succeeded')
  return result(source, 'verified-no-op')
}

async function assertForeignKeys(transport: SnapshotTransport): Promise<void> {
  const violations = await transport.query({
    sql: 'SELECT * FROM pragma_foreign_key_check LIMIT 1',
    params: []
  })
  if (violations.length > 0) {
    throw new Error(`Target has ${violations.length} foreign-key violation(s).`)
  }
}
