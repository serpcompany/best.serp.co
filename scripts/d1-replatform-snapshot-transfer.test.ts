import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { captureApplicationSnapshot, type SqlStatement } from './d1-application-snapshot'
import { applicationTableNames, canonicalLegacyMigrationNames } from './d1-replatform-inventory'
import {
  captureFrozenSourceSnapshot,
  type IdentifiedSnapshotTransport,
  materializeFrozenSnapshot,
  type SnapshotTransferTransport,
  transferReceiptId,
  transferStageId,
  verifyMaterializedSnapshot
} from './d1-replatform-snapshot-transfer'
import type { SiteId } from './site-targets'

const openDatabases: DatabaseSync[] = []
const cutoverId = 'cutover-2026-09-25'

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

function database(): DatabaseSync {
  const value = new DatabaseSync(':memory:', { readBigInts: true })
  value.exec('PRAGMA foreign_keys=ON')
  openDatabases.push(value)
  return value
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  ).run(...columns.map(column => row[column] ?? null))
}

function ledger(db: DatabaseSync, names: readonly string[]): void {
  db.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  ) STRICT`)
  for (const [index, name] of names.entries()) {
    insert(db, 'd1_migrations', {
      id: index + 1,
      name,
      applied_at: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
    })
  }
}

function sourceDatabase(siteId: SiteId = 'serp.software'): DatabaseSync {
  const db = database()
  for (const name of canonicalLegacyMigrationNames) {
    db.exec(readFileSync(resolve('d1/migrations', name), 'utf8'))
  }
  ledger(db, canonicalLegacyMigrationNames)
  seedAllTables(db, siteId)
  return db
}

function targetDatabase(): DatabaseSync {
  const db = database()
  db.exec(readFileSync(resolve('d1/drizzle/0000_remarkable_manta.sql'), 'utf8'))
  ledger(db, ['0000_remarkable_manta.sql'])
  return db
}

function seedAllTables(db: DatabaseSync, siteId: SiteId): void {
  const now = '2026-09-25T00:00:00.000Z'
  insert(db, 'sites', { id: siteId, created_at: now, updated_at: now })
  insert(db, 'categories', {
    id: 9_007_199_254_740_993n,
    site_id: siteId,
    slug: 'unicode-category',
    name: '日本語 & café',
    description: 'line one\nline two ✓',
    sort_order: 3,
    is_active: 1,
    created_at: now,
    updated_at: now
  })
  insert(db, 'listings', {
    id: 'listing-private-proof',
    site_id: siteId,
    slug: 'unicode-listing',
    name: 'Crème 日本語',
    description: 'Exact Unicode ✓',
    website: 'https://example.test/tool',
    content: 'Long\ncontent\u0000is preserved',
    entity_type: 'software',
    priority: null,
    is_unofficial: 0,
    is_featured: 1,
    is_active: 1,
    status: 'draft',
    published_at: now,
    source_kind: 'legacy-d1',
    source_identity: 'source:unicode',
    source_updated_at: null,
    checksum: 'listing-checksum',
    created_at: now,
    updated_at: now,
    display_order: 9_007_199_254_740_993n
  })
  insert(db, 'listing_categories', {
    listing_id: 'listing-private-proof',
    category_id: 9_007_199_254_740_993n,
    sort_order: 0,
    is_primary: 1
  })
  db.prepare("UPDATE listings SET status='approved' WHERE id='listing-private-proof'").run()
  insert(db, 'listing_media', {
    id: 9_007_199_254_740_994n,
    listing_id: 'listing-private-proof',
    kind: 'logo',
    url: 'https://example.test/logo.png',
    sort_order: 0
  })
  insert(db, 'listing_resource_links', {
    id: 9_007_199_254_740_995n,
    listing_id: 'listing-private-proof',
    label: 'Docs 日本語',
    url: 'https://example.test/docs',
    sort_order: 0
  })
  insert(db, 'listing_faqs', {
    id: 9_007_199_254_740_996n,
    listing_id: 'listing-private-proof',
    question: 'Works?',
    answer: 'Oui ✓',
    sort_order: 0
  })
  insert(db, 'publication_state', {
    site_id: siteId,
    version: 7,
    manifest_id: 'manifest-7',
    checksum: 'publication-checksum',
    published_at: now
  })
  insert(db, 'migration_runs', {
    id: 'legacy-audit',
    site_id: siteId,
    schema_version: 9,
    manifest_identity: 'legacy-audit',
    input_checksum: 'legacy-input',
    target_checksum: 'legacy-target',
    affected_records: 17,
    outcome: 'succeeded',
    error: null,
    started_at: now,
    completed_at: now
  })
  insert(db, 'migration_runs', {
    id: `d1-cutover-lock-v1:${siteId}:${cutoverId}`,
    site_id: siteId,
    schema_version: 9,
    manifest_identity: `cutover-lock:${cutoverId}`,
    input_checksum: 'freeze-input',
    target_checksum: 'freeze-target',
    affected_records: 0,
    outcome: 'started',
    error: null,
    started_at: now,
    completed_at: null
  })
  insert(db, 'migration_runs', {
    id: `d1-cutover-lock-v1:${siteId}:historical-cutover`,
    site_id: siteId,
    schema_version: 9,
    manifest_identity: 'cutover-lock:historical-cutover',
    input_checksum: 'historical-freeze-input',
    target_checksum: 'historical-freeze-target',
    affected_records: 0,
    outcome: 'succeeded',
    error: null,
    started_at: '2026-09-24T00:00:00.000Z',
    completed_at: '2026-09-24T00:05:00.000Z'
  })
  insert(db, 'publication_runs', {
    id: 'publication-audit',
    site_id: siteId,
    manifest_id: 'manifest-7',
    base_version: 6,
    published_version: 7,
    input_checksum: 'publication-input',
    affected_records: 1,
    affected_routes: '/,/products/unicode-listing/',
    outcome: 'succeeded',
    error: null,
    started_at: now,
    completed_at: now,
    actor: 'maintainer',
    workflow: 'protected',
    before_checksum: null,
    after_checksum: 'publication-checksum'
  })
  insert(db, 'listing_slug_redirects', {
    id: 9_007_199_254_740_997n,
    site_id: siteId,
    listing_id: 'listing-private-proof',
    old_slug: 'old-unicode-listing',
    new_slug: 'unicode-listing',
    manifest_id: 'manifest-7',
    reason: 'Exact rename',
    created_at: now
  })
  insert(db, 'listing_submissions', {
    id: 'submission-private',
    site_id: siteId,
    slug: 'private-submission',
    name: 'Private Creator Data',
    description: 'Sensitive staged content',
    website: 'https://creator.example/private',
    content: 'private body',
    category_slug: 'unicode-category',
    logo_url: 'https://creator.example/logo.png',
    video_url: null,
    status: 'verified',
    access_token_hash: 'private-access-hash',
    verification_attempts: 2,
    last_verification_at: now,
    last_verification_error: null,
    badge_verified_at: now,
    reviewed_at: null,
    reviewed_by: null,
    listing_id: null,
    created_at: now,
    updated_at: now
  })
  insert(db, 'listing_submission_resource_links', {
    id: 9_007_199_254_740_998n,
    submission_id: 'submission-private',
    label: 'Private docs',
    url: 'https://creator.example/docs',
    sort_order: 0
  })
  insert(db, 'listing_submission_faqs', {
    id: 9_007_199_254_740_999n,
    submission_id: 'submission-private',
    question: 'Private?',
    answer: 'Yes.',
    sort_order: 0
  })
  insert(db, 'listing_submission_events', {
    id: 9_007_199_254_741_000n,
    submission_id: 'submission-private',
    event_type: 'badge_verified',
    detail: 'private audit detail',
    actor: 'creator',
    created_at: now
  })
  insert(db, 'listing_submission_rate_limits', {
    fingerprint_hash: 'private-fingerprint-hash',
    window_started_at: 9_007_199_254_741_001n,
    request_count: 2
  })
  insert(db, 'listing_submission_notifications', {
    submission_id: 'submission-private',
    channel: 'github_issue',
    external_id: '72',
    external_url: 'https://github.test/private/72',
    recipient: 'maintainer',
    created_at: now,
    updated_at: now,
    preview_token_hash: 'private-preview-token-hash'
  })
}

class SqliteTransport implements SnapshotTransferTransport, IdentifiedSnapshotTransport {
  completedBatches = 0
  failBeforeBatch?: number

  constructor(
    readonly db: DatabaseSync,
    readonly databaseId = 'test-database'
  ) {}

  async observeDatabaseIdentity(): Promise<{ databaseId: string }> {
    return { databaseId: this.databaseId }
  }

  async query(statement: SqlStatement): Promise<Array<Record<string, unknown>>> {
    return this.db.prepare(statement.sql).all(...(statement.params as SQLInputValue[]))
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (this.failBeforeBatch === this.completedBatches + 1)
      throw new Error('simulated interruption')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]))
      }
      this.db.exec('COMMIT')
      this.completedBatches += 1
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

async function frozen(
  db: DatabaseSync,
  siteId: SiteId = 'serp.software',
  capturedAt = '2026-09-25T00:01:00.000Z'
) {
  return captureFrozenSourceSnapshot(
    new SqliteTransport(db, `source-${siteId}`),
    {
      capturedAt,
      cutoverId,
      siteId,
      sourceDatabaseId: `source-${siteId}`
    },
    { pageSize: 2 }
  )
}

describe('canonical frozen D1 snapshot transfer', () => {
  it.each(['serp.software', 'pornvideodownloaders.com'] as const)(
    'preserves all 17 %s tables, private/audit/lock rows, Unicode, nulls, and 64-bit integers',
    async siteId => {
      const source = sourceDatabase(siteId)
      const target = targetDatabase()
      const artifact = await frozen(source, siteId)
      const imported = await materializeFrozenSnapshot(new SqliteTransport(target), artifact, {
        batchSize: 3,
        now: () => '2026-09-25T00:02:00.000Z',
        pageSize: 2
      })
      const verified = await verifyMaterializedSnapshot(new SqliteTransport(target), artifact, {
        pageSize: 2
      })

      expect(imported.mode).toBe('imported')
      expect(verified.mode).toBe('verified-no-op')
      expect(Object.keys(imported.tableCounts).sort()).toEqual([...applicationTableNames].sort())
      expect(Object.values(imported.tableCounts).every(count => count > 0)).toBe(true)
      expect(target.prepare('SELECT name,priority FROM listings').get()).toMatchObject({
        name: 'Crème 日本語',
        priority: null
      })
      expect(target.prepare('SELECT display_order FROM listings').get()?.display_order).toBe(
        9_007_199_254_740_993n
      )
      expect(
        target.prepare('SELECT window_started_at FROM listing_submission_rate_limits').get()
          ?.window_started_at
      ).toBe(9_007_199_254_741_001n)
      expect(
        target.prepare('SELECT preview_token_hash FROM listing_submission_notifications').get()
          ?.preview_token_hash
      ).toBe('private-preview-token-hash')
      expect(
        target
          .prepare("SELECT outcome FROM migration_runs WHERE id LIKE 'd1-cutover-lock-v1:%'")
          .all()
          .map(row => row.outcome)
          .sort()
      ).toEqual(['started', 'succeeded'])
    }
  )

  it('resumes only the exact interrupted cutover and records the receipt after parity', async () => {
    const source = sourceDatabase()
    const target = targetDatabase()
    const artifact = await frozen(source)
    const interrupted = new SqliteTransport(target)
    interrupted.failBeforeBatch = 7

    await expect(
      materializeFrozenSnapshot(interrupted, artifact, { batchSize: 1, pageSize: 2 })
    ).rejects.toThrow('simulated interruption')
    expect(
      target.prepare('SELECT id FROM migration_runs WHERE id=?').get(transferStageId(artifact))?.id
    ).toBe(transferStageId(artifact))
    expect(
      target.prepare('SELECT id FROM migration_runs WHERE id=?').get(transferReceiptId(artifact))
    ).toBeUndefined()

    const laterCapture = await frozen(source, 'serp.software', '2026-09-25T00:05:00.000Z')
    expect(laterCapture.capturedAt).not.toBe(artifact.capturedAt)
    expect(transferStageId(laterCapture)).toBe(transferStageId(artifact))
    expect(transferReceiptId(laterCapture)).toBe(transferReceiptId(artifact))
    const resumed = await materializeFrozenSnapshot(new SqliteTransport(target), laterCapture, {
      batchSize: 2,
      pageSize: 2
    })
    expect(resumed.mode).toBe('resumed')
    expect(
      target.prepare('SELECT id FROM migration_runs WHERE id=?').get(transferStageId(artifact))
    ).toBeUndefined()
    expect(
      target.prepare('SELECT id FROM migration_runs WHERE id=?').get(transferReceiptId(artifact))
        ?.id
    ).toBe(transferReceiptId(artifact))
  })

  it('refuses source drift and wrong schema, ledger, Site, or cutover lock proof', async () => {
    const drifting = sourceDatabase()
    const base = new SqliteTransport(drifting, 'source-serp')
    let schemaReads = 0
    const driftTransport: IdentifiedSnapshotTransport = {
      observeDatabaseIdentity: () => base.observeDatabaseIdentity(),
      async query(statement) {
        if (statement.sql.includes('FROM sqlite_master')) {
          schemaReads += 1
          if (schemaReads === 2) {
            drifting.prepare('UPDATE publication_state SET checksum=?').run('drifted')
          }
        }
        return base.query(statement)
      }
    }
    await expect(
      captureFrozenSourceSnapshot(driftTransport, {
        capturedAt: '2026-09-25T00:01:00.000Z',
        cutoverId,
        siteId: 'serp.software',
        sourceDatabaseId: 'source-serp'
      })
    ).rejects.toThrow('drifted')

    const wrongLedger = sourceDatabase()
    wrongLedger.prepare('UPDATE d1_migrations SET name=? WHERE id=9').run('0009_wrong.sql')
    await expect(frozen(wrongLedger)).rejects.toThrow('migration ledger')

    const wrongSite = sourceDatabase('pornvideodownloaders.com')
    await expect(frozen(wrongSite, 'serp.software')).rejects.toThrow('Site identity')

    const missingLock = sourceDatabase()
    missingLock.prepare("DELETE FROM migration_runs WHERE id LIKE 'd1-cutover-lock-v1:%'").run()
    await expect(frozen(missingLock)).rejects.toThrow('active frozen cutover lock')

    const wrongSchema = sourceDatabase()
    wrongSchema.exec('CREATE TABLE unexpected_source_table (id TEXT PRIMARY KEY) STRICT')
    await expect(frozen(wrongSchema)).rejects.toThrow(/schema inventory|legacy schema/u)

    await expect(
      captureFrozenSourceSnapshot(new SqliteTransport(sourceDatabase(), 'observed-source'), {
        capturedAt: '2026-09-25T00:01:00.000Z',
        cutoverId,
        siteId: 'serp.software',
        sourceDatabaseId: 'claimed-source'
      })
    ).rejects.toThrow('Observed source database identity')

    await expect(
      captureFrozenSourceSnapshot(new SqliteTransport(sourceDatabase(), 'source-unsupported'), {
        capturedAt: '2026-09-25T00:01:00.000Z',
        cutoverId,
        siteId: 'unsupported.example',
        sourceDatabaseId: 'source-unsupported'
      })
    ).rejects.toThrow('Site must be one of')
  })

  it('refuses divergent partial targets and a resume marker for another snapshot', async () => {
    const source = sourceDatabase()
    const artifact = await frozen(source)
    const divergent = targetDatabase()
    const interrupted = new SqliteTransport(divergent)
    interrupted.failBeforeBatch = 7
    await expect(
      materializeFrozenSnapshot(interrupted, artifact, { batchSize: 1 })
    ).rejects.toThrow('simulated interruption')
    divergent.prepare('UPDATE categories SET name=?').run('corrupt target')
    await expect(
      materializeFrozenSnapshot(new SqliteTransport(divergent), artifact)
    ).rejects.toThrow('divergent partial data')

    const changedSource = sourceDatabase()
    changedSource.prepare('UPDATE publication_state SET checksum=?').run('different snapshot')
    const changedArtifact = await frozen(changedSource)
    await expect(
      materializeFrozenSnapshot(new SqliteTransport(divergent), changedArtifact)
    ).rejects.toThrow('different cutover or snapshot')
  })

  it('refuses target schema and fresh-ledger mismatches before writing', async () => {
    const source = sourceDatabase()
    const artifact = await frozen(source)
    const wrongLedger = targetDatabase()
    wrongLedger.prepare('UPDATE d1_migrations SET name=?').run('wrong.sql')
    await expect(
      materializeFrozenSnapshot(new SqliteTransport(wrongLedger), artifact)
    ).rejects.toThrow('fresh migration ledger')

    const wrongSchema = targetDatabase()
    wrongSchema.exec('CREATE TABLE unexpected_target_table (id TEXT PRIMARY KEY) STRICT')
    await expect(
      materializeFrozenSnapshot(new SqliteTransport(wrongSchema), artifact)
    ).rejects.toThrow(/schema inventory|fresh Drizzle schema/u)
  })

  it('refuses a tampered serialized snapshot before target mutation', async () => {
    const source = sourceDatabase()
    const artifact = structuredClone(await frozen(source))
    const target = targetDatabase()
    const nameIndex = artifact.snapshot.tables.categories.columns.indexOf('name')
    artifact.snapshot.tables.categories.rows[0]![nameIndex] = {
      type: 'text',
      value: 'tampered'
    }
    await expect(materializeFrozenSnapshot(new SqliteTransport(target), artifact)).rejects.toThrow(
      'checksum does not match'
    )
    expect(target.prepare('SELECT COUNT(*) count FROM sites').get()?.count).toBe(0n)
  })

  it('rejects an unsupported serialized Site before materialization', async () => {
    const artifact = structuredClone(await frozen(sourceDatabase()))
    const target = targetDatabase()
    ;(artifact as { siteId: string }).siteId = 'unsupported.example'
    await expect(materializeFrozenSnapshot(new SqliteTransport(target), artifact)).rejects.toThrow(
      'Site must be one of'
    )
    expect(target.prepare('SELECT COUNT(*) count FROM sites').get()?.count).toBe(0n)
  })

  it('uses identical canonical checksums regardless of bounded page size', async () => {
    const source = sourceDatabase()
    const transport = new SqliteTransport(source)
    const one = await captureApplicationSnapshot(transport, { pageSize: 1 })
    const many = await captureApplicationSnapshot(transport, { pageSize: 100 })
    expect(one).toEqual(many)
  })
})
