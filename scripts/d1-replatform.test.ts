import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { legacyRecoveryLocalDatabaseIds } from './d1-drizzle-local'
import { migrateLocalD1 } from './d1-replatform'
import {
  applicationColumnInventory,
  applicationTableNames,
  canonicalLegacyMigrationNames
} from './d1-replatform-inventory'
import { resolveSiteTarget, type SiteId } from './site-targets'

const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
})

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const columns = Object.keys(row)
  database
    .prepare(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map(column => row[column] ?? null))
}

function createLedger(database: DatabaseSync, names: string[]): void {
  database.exec(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT'
  )
  for (const [index, name] of names.entries()) {
    insert(database, 'd1_migrations', {
      id: index + 1,
      name,
      applied_at: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
    })
  }
}

function createSource(path: string, siteId: SiteId): void {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of canonicalLegacyMigrationNames) {
    database.exec(readFileSync(resolve('d1/migrations', migration), 'utf8'))
  }
  createLedger(database, canonicalLegacyMigrationNames)
  seed(database, siteId)
  database.close()
}

function createTarget(path: string): void {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(readFileSync(resolve('d1/drizzle/0000_remarkable_manta.sql'), 'utf8'))
  createLedger(database, ['0000_remarkable_manta.sql'])
  database.close()
}

function seed(database: DatabaseSync, siteId: SiteId): void {
  const suffix = siteId === 'serp.software' ? 'serp' : 'pvd'
  const listingId = `listing-${suffix}`
  const submissionId = `submission-${suffix}`
  insert(database, 'sites', {
    id: siteId,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  })
  insert(database, 'categories', {
    id: 17,
    site_id: siteId,
    slug: `category-${suffix}`,
    name: `Category ${suffix}`,
    description: 'Unicode ✓\nand newline',
    sort_order: 4,
    is_active: 1,
    created_at: '2025-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z'
  })
  insert(database, 'listings', {
    id: listingId,
    site_id: siteId,
    slug: `listing-${suffix}`,
    name: `Listing ${suffix}`,
    description: 'Description',
    website: `https://${siteId}/tool`,
    content: 'Long content',
    entity_type: 'software',
    priority: 'high',
    is_unofficial: 0,
    is_featured: 1,
    is_active: 1,
    status: 'draft',
    published_at: '2026-02-03T04:05:06.000Z',
    source_kind: 'legacy-d1',
    source_identity: `legacy:${listingId}`,
    source_updated_at: '2026-02-02T00:00:00.000Z',
    checksum: `checksum-${suffix}`,
    created_at: '2025-01-03T00:00:00.000Z',
    updated_at: '2026-02-03T00:00:00.000Z',
    display_order: 9
  })
  insert(database, 'listing_categories', {
    listing_id: listingId,
    category_id: 17,
    sort_order: 2,
    is_primary: 1
  })
  database.prepare('UPDATE listings SET status = ? WHERE id = ?').run('approved', listingId)
  insert(database, 'listing_media', {
    id: 21,
    listing_id: listingId,
    kind: 'logo',
    url: `https://${siteId}/logo.png`,
    sort_order: 0
  })
  insert(database, 'listing_resource_links', {
    id: 22,
    listing_id: listingId,
    label: 'Docs',
    url: `https://${siteId}/docs`,
    sort_order: 3
  })
  insert(database, 'listing_faqs', {
    id: 23,
    listing_id: listingId,
    question: 'Question?',
    answer: 'Answer.',
    sort_order: 5
  })
  insert(database, 'publication_state', {
    site_id: siteId,
    version: 8,
    manifest_id: `manifest-${suffix}`,
    checksum: `publication-${suffix}`,
    published_at: '2026-02-03T04:05:06.000Z'
  })
  insert(database, 'migration_runs', {
    id: `legacy-run-${suffix}`,
    site_id: siteId,
    schema_version: 9,
    manifest_identity: `legacy-manifest-${suffix}`,
    input_checksum: `input-${suffix}`,
    target_checksum: `target-${suffix}`,
    affected_records: 7,
    outcome: 'succeeded',
    error: null,
    started_at: '2026-02-03T00:00:00.000Z',
    completed_at: '2026-02-03T00:01:00.000Z'
  })
  insert(database, 'publication_runs', {
    id: `publication-run-${suffix}`,
    site_id: siteId,
    manifest_id: `manifest-${suffix}`,
    base_version: 7,
    published_version: 8,
    input_checksum: `publication-input-${suffix}`,
    affected_records: 3,
    affected_routes: '/,/products/listing',
    outcome: 'succeeded',
    error: null,
    started_at: '2026-02-03T00:00:00.000Z',
    completed_at: '2026-02-03T00:01:00.000Z',
    actor: 'fixture-maintainer',
    workflow: 'fixture-workflow',
    before_checksum: `before-${suffix}`,
    after_checksum: `after-${suffix}`
  })
  insert(database, 'listing_slug_redirects', {
    id: 24,
    site_id: siteId,
    listing_id: listingId,
    old_slug: `old-${suffix}`,
    new_slug: `listing-${suffix}`,
    manifest_id: `manifest-${suffix}`,
    reason: 'Renamed',
    created_at: '2026-02-03T00:00:00.000Z'
  })
  insert(database, 'listing_submissions', {
    id: submissionId,
    site_id: siteId,
    slug: `submission-${suffix}`,
    name: `Submission ${suffix}`,
    description: 'Private submission',
    website: `https://${siteId}/submission`,
    content: '',
    category_slug: `category-${suffix}`,
    logo_url: `https://${siteId}/submission.png`,
    video_url: null,
    status: 'verified',
    access_token_hash: `access-hash-${suffix}`,
    verification_attempts: 2,
    last_verification_at: '2026-03-01T00:00:00.000Z',
    last_verification_error: null,
    badge_verified_at: '2026-03-01T00:00:00.000Z',
    reviewed_at: null,
    reviewed_by: null,
    listing_id: listingId,
    created_at: '2026-02-28T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z'
  })
  insert(database, 'listing_submission_resource_links', {
    id: 25,
    submission_id: submissionId,
    label: 'Guide',
    url: `https://${siteId}/guide`,
    sort_order: 1
  })
  insert(database, 'listing_submission_faqs', {
    id: 26,
    submission_id: submissionId,
    question: 'Private question?',
    answer: 'Private answer.',
    sort_order: 1
  })
  insert(database, 'listing_submission_events', {
    id: 27,
    submission_id: submissionId,
    event_type: 'badge_verified',
    detail: 'fixture',
    actor: 'creator',
    created_at: '2026-03-01T00:00:00.000Z'
  })
  insert(database, 'listing_submission_rate_limits', {
    fingerprint_hash: `fingerprint-${suffix}`,
    window_started_at: 9_007_199_254_740_993n,
    request_count: 2
  })
  insert(database, 'listing_submission_notifications', {
    submission_id: submissionId,
    channel: 'github_issue',
    external_id: `69-${suffix}`,
    external_url: `https://github.test/issues/${suffix}`,
    recipient: 'maintainer',
    created_at: '2026-03-01T00:02:00.000Z',
    updated_at: '2026-03-01T00:03:00.000Z',
    preview_token_hash: `preview-hash-${suffix}`
  })
}

function fixture(siteId: SiteId): {
  directory: string
  sourcePath: string
  targetStateRoot: string
  targetPath: string
} {
  const directory = mkdtempSync(join(tmpdir(), `d1-replatform-${siteId}-`))
  temporaryDirectories.push(directory)
  const sourcePath = join(directory, 'source.sqlite')
  const targetStateRoot = join(directory, 'target-state')
  mkdirSync(targetStateRoot)
  const targetPath = join(targetStateRoot, 'target.sqlite')
  createSource(sourcePath, siteId)
  createTarget(targetPath)
  return { directory, sourcePath, targetPath, targetStateRoot }
}

function migrate(siteId: SiteId, sourcePath: string, targetPath: string) {
  return migrateLocalD1(
    {
      now: () => '2026-09-23T00:00:00.000Z',
      siteId,
      sourceDatabaseId: legacyRecoveryLocalDatabaseIds[siteId],
      sourcePath,
      targetDatabaseId: resolveSiteTarget(siteId).local.databaseId,
      targetPath
    },
    { targetStateRoot: resolve(targetPath, '..') }
  )
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('local D1-to-D1 replatform migration', () => {
  it.each(['serp.software', 'pornvideodownloaders.com'] as const)(
    'preserves every %s application row and verifies an exact repeat no-op',
    siteId => {
      const { sourcePath, targetPath } = fixture(siteId)
      const sourceBefore = fileHash(sourcePath)
      const imported = migrate(siteId, sourcePath, targetPath)
      const repeated = migrate(siteId, sourcePath, targetPath)

      expect(imported.mode).toBe('imported')
      expect(repeated).toEqual({ ...imported, mode: 'verified-no-op' })
      expect(fileHash(sourcePath)).toBe(sourceBefore)
      expect(Object.keys(imported.tableCounts).sort()).toEqual([...applicationTableNames].sort())
      expect(Object.values(imported.tableCounts).every(count => count > 0)).toBe(true)

      const source = new DatabaseSync(sourcePath, { readOnly: true })
      const target = new DatabaseSync(targetPath, { readBigInts: true, readOnly: true })
      for (const table of applicationTableNames) {
        const sourceCount = Number(
          source.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count
        )
        const targetCount = Number(
          target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count
        )
        expect(targetCount, table).toBe(sourceCount + (table === 'migration_runs' ? 1 : 0))
      }
      expect(
        target
          .prepare(
            "SELECT COUNT(*) AS count FROM migration_runs WHERE id LIKE 'd1-replatform-v1:%'"
          )
          .get()?.count
      ).toBe(1n)
      expect(
        target
          .prepare('SELECT name FROM d1_migrations')
          .all()
          .map(row => row.name)
      ).toEqual(['0000_remarkable_manta.sql'])
      expect(
        source
          .prepare('SELECT name FROM d1_migrations ORDER BY name')
          .all()
          .map(row => row.name)
      ).toEqual(canonicalLegacyMigrationNames)
      expect(
        target.prepare('SELECT window_started_at FROM listing_submission_rate_limits').get()
          ?.window_started_at
      ).toBe(9_007_199_254_740_993n)
      source.close()
      target.close()
    }
  )

  it('fails closed for wrong identities, dirty targets, changed sources, and target corruption', () => {
    const siteId = 'serp.software'
    const wrongIdentity = fixture(siteId)
    expect(() =>
      migrateLocalD1({
        siteId,
        sourceDatabaseId: 'wrong-source',
        sourcePath: wrongIdentity.sourcePath,
        targetDatabaseId: resolveSiteTarget(siteId).local.databaseId,
        targetPath: wrongIdentity.targetPath
      })
    ).toThrow(/Source database identity/u)
    expect(() =>
      migrateLocalD1({
        siteId,
        sourceDatabaseId: legacyRecoveryLocalDatabaseIds[siteId],
        sourcePath: wrongIdentity.sourcePath,
        targetDatabaseId: 'wrong-target',
        targetPath: wrongIdentity.targetPath
      })
    ).toThrow(/Target database identity/u)

    const wrongSite = fixture('pornvideodownloaders.com')
    expect(() =>
      migrateLocalD1(
        {
          siteId,
          sourceDatabaseId: legacyRecoveryLocalDatabaseIds[siteId],
          sourcePath: wrongSite.sourcePath,
          targetDatabaseId: resolveSiteTarget(siteId).local.databaseId,
          targetPath: wrongSite.targetPath
        },
        { targetStateRoot: wrongSite.targetStateRoot }
      )
    ).toThrow(/explicit Site identity/u)

    expect(() =>
      migrateLocalD1(
        {
          siteId,
          sourceDatabaseId: legacyRecoveryLocalDatabaseIds[siteId],
          sourcePath: wrongIdentity.sourcePath,
          targetDatabaseId: resolveSiteTarget(siteId).local.databaseId,
          targetPath: wrongIdentity.targetPath
        },
        { targetStateRoot: join(wrongIdentity.directory, 'different-state-root') }
      )
    ).toThrow(/harness D1 state root/u)

    const dirty = fixture(siteId)
    const dirtyDatabase = new DatabaseSync(dirty.targetPath)
    insert(dirtyDatabase, 'sites', {
      id: siteId,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    })
    dirtyDatabase.close()
    expect(() => migrate(siteId, dirty.sourcePath, dirty.targetPath)).toThrow(
      /requires an empty fresh target/u
    )

    const changed = fixture(siteId)
    migrate(siteId, changed.sourcePath, changed.targetPath)
    const changedSource = new DatabaseSync(changed.sourcePath)
    changedSource.prepare('UPDATE publication_state SET checksum = ?').run('changed')
    changedSource.close()
    expect(() => migrate(siteId, changed.sourcePath, changed.targetPath)).toThrow(
      /receipt does not exactly match/u
    )

    const corrupt = fixture(siteId)
    migrate(siteId, corrupt.sourcePath, corrupt.targetPath)
    const corruptTarget = new DatabaseSync(corrupt.targetPath)
    corruptTarget.prepare('UPDATE publication_runs SET affected_routes = ?').run('/corrupt')
    corruptTarget.close()
    expect(() => migrate(siteId, corrupt.sourcePath, corrupt.targetPath)).toThrow(
      /parity mismatch/u
    )
  })

  it('rolls back a duplicate that the fresh constraints reject', () => {
    const siteId = 'pornvideodownloaders.com'
    const { sourcePath, targetPath } = fixture(siteId)
    const source = new DatabaseSync(sourcePath)
    const original = source.prepare('SELECT * FROM listing_media').get()
    if (!original) throw new Error('Fixture media row missing.')
    source.exec(`
      DROP TABLE listing_media;
      CREATE TABLE listing_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `)
    insert(source, 'listing_media', original)
    insert(source, 'listing_media', { ...original, id: 99 })
    source.close()

    expect(() => migrate(siteId, sourcePath, targetPath)).toThrow(/UNIQUE constraint failed/u)
    const target = new DatabaseSync(targetPath, { readOnly: true })
    for (const table of applicationTableNames) {
      expect(
        target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count,
        table
      ).toBe(0)
    }
    target.close()
  })

  it('rejects an unexplained table or column contract before target mutation', () => {
    const siteId = 'serp.software'
    const { sourcePath, targetPath } = fixture(siteId)
    const source = new DatabaseSync(sourcePath)
    source.exec('CREATE TABLE unexplained_data (id TEXT PRIMARY KEY) STRICT')
    source.close()
    expect(() => migrate(siteId, sourcePath, targetPath)).toThrow(/schema inventory mismatch/u)

    const target = new DatabaseSync(targetPath, { readOnly: true })
    for (const [table, columns] of Object.entries(applicationColumnInventory)) {
      expect(columns.length, table).toBeGreaterThan(0)
      expect(
        target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count
      ).toBe(0)
    }
    target.close()
  })

  it.each([
    [
      'trigger',
      `DROP TRIGGER listings_require_primary_on_insert;
       CREATE TRIGGER listings_require_primary_on_insert AFTER INSERT ON listings
       BEGIN SELECT 1; END;`
    ],
    [
      'index',
      `DROP INDEX listings_publication_idx;
       CREATE INDEX listings_publication_idx ON listings (site_id);`
    ],
    [
      'table',
      `DROP TABLE listing_submission_rate_limits;
       CREATE TABLE listing_submission_rate_limits (
         fingerprint_hash TEXT PRIMARY KEY NOT NULL,
         window_started_at TEXT NOT NULL,
         request_count INTEGER NOT NULL
       ) STRICT;`
    ]
  ])('rejects a same-named target %s with a changed definition', (_label, sql) => {
    const siteId = 'serp.software'
    const { sourcePath, targetPath } = fixture(siteId)
    const target = new DatabaseSync(targetPath)
    target.exec(sql)
    target.close()

    expect(() => migrate(siteId, sourcePath, targetPath)).toThrow(
      /schema definitions do not exactly match/u
    )
    const unchanged = new DatabaseSync(targetPath, { readOnly: true })
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM sites').get()?.count).toBe(0)
    unchanged.close()
  })
})
