import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildPublicationPlan, manifestSchema, type PublicationPlan } from './d1-publisher.ts'

const beforeChecksum = 'a'.repeat(64)
const afterChecksum = createHash('sha256')
  .update(`${beforeChecksum}\0${createHash('sha256').update('sqlite manifest').digest('hex')}`)
  .digest('hex')
const now = '2026-07-13T01:00:00.000Z'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sites (id TEXT PRIMARY KEY);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, is_active INTEGER NOT NULL);
    CREATE TABLE listings (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, status TEXT NOT NULL, is_active INTEGER NOT NULL, updated_at TEXT, UNIQUE(site_id,slug));
    CREATE TABLE listing_categories (listing_id TEXT NOT NULL, category_id INTEGER NOT NULL);
    CREATE TABLE listing_slug_redirects (id INTEGER PRIMARY KEY, site_id TEXT NOT NULL, listing_id TEXT NOT NULL, old_slug TEXT NOT NULL, new_slug TEXT NOT NULL, manifest_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(site_id,old_slug));
    CREATE TABLE publication_state (site_id TEXT PRIMARY KEY, version INTEGER NOT NULL, manifest_id TEXT, checksum TEXT NOT NULL, published_at TEXT NOT NULL);
    CREATE TABLE publication_runs (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, manifest_id TEXT NOT NULL, base_version INTEGER NOT NULL, published_version INTEGER, input_checksum TEXT NOT NULL, affected_records INTEGER NOT NULL DEFAULT 0, affected_routes TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, completed_at TEXT, actor TEXT, workflow TEXT, before_checksum TEXT, after_checksum TEXT, UNIQUE(site_id,manifest_id));
    CREATE TABLE migration_runs (id TEXT PRIMARY KEY,site_id TEXT NOT NULL,outcome TEXT NOT NULL,started_at TEXT NOT NULL);
    INSERT INTO sites VALUES ('serp.software');
    INSERT INTO categories VALUES (1,'serp.software','seo',1);
    INSERT INTO listings VALUES ('lst_sqlite_test','serp.software','old-slug','approved',1,NULL);
    INSERT INTO listing_categories VALUES ('lst_sqlite_test',1);
    INSERT INTO publication_state VALUES ('serp.software',4,NULL,'${beforeChecksum}','${now}');
  `)
  return db
}

function plan(overrides: Record<string, unknown> = {}): PublicationPlan {
  const value = manifestSchema.parse({
    version: 1,
    id: 'sqlite-release',
    siteId: 'serp.software',
    basePublicationVersion: 4,
    provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
    operations: [
      {
        action: 'listing-slug-change',
        id: 'lst_sqlite_test',
        from: 'old-slug',
        to: 'new-slug',
        categories: ['seo'],
        reason: 'Rename'
      }
    ],
    ...overrides
  })
  return buildPublicationPlan(value, 'sqlite manifest', now)
}

function executeInTestTransaction(db: DatabaseSync, publication: PublicationPlan): void {
  db.exec('DROP TABLE IF EXISTS publication_guard; BEGIN IMMEDIATE;')
  try {
    for (const item of publication.statements)
      db.prepare(item.query).run(...(item.bindings as Array<string | number | bigint | null>))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function expectUnchanged(db: DatabaseSync): void {
  expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
    slug: 'old-slug'
  })
  expect(
    db.prepare("SELECT version,checksum FROM publication_state WHERE site_id='serp.software'").get()
  ).toEqual({ version: 4, checksum: beforeChecksum })
  expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
}

describe('publisher plan in SQLite transaction (D1 batch emulator)', () => {
  it('commits a verified checksum transition and audited redirect', () => {
    const db = database()
    executeInTestTransaction(db, plan())
    expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
      slug: 'new-slug'
    })
    expect(
      db
        .prepare("SELECT version,checksum FROM publication_state WHERE site_id='serp.software'")
        .get()
    ).toEqual({ version: 5, checksum: afterChecksum })
    expect(
      db.prepare('SELECT before_checksum,after_checksum,outcome FROM publication_runs').get()
    ).toEqual({
      before_checksum: beforeChecksum,
      after_checksum: afterChecksum,
      outcome: 'succeeded'
    })
  })

  it.each([
    ['stale version', () => plan({ basePublicationVersion: 3 })],
    [
      'before-checksum mismatch',
      () =>
        plan({
          provenance: {
            actor: 'test@example.com',
            workflow: 'test/sqlite',
            beforeChecksum: 'c'.repeat(64)
          }
        })
    ]
  ])('rolls back for %s', (_name, makePlan) => {
    const db = database()
    expect(() => executeInTestTransaction(db, makePlan())).toThrow()
    expectUnchanged(db)
  })

  it('rolls back when the listing is not an eligible tenant row', () => {
    const db = database()
    db.exec("UPDATE listings SET site_id='other',status='draft'")
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
  })

  it('rolls back duplicate/idempotent publication', () => {
    const db = database()
    executeInTestTransaction(db, plan())
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
      slug: 'new-slug'
    })
  })

  it('rolls back category membership mismatch', () => {
    const db = database()
    db.exec('DELETE FROM listing_categories')
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expectUnchanged(db)
  })

  it('rolls back redirect collision', () => {
    const db = database()
    db.exec(
      "INSERT INTO listing_slug_redirects VALUES (1,'serp.software','lst_sqlite_test','old-slug','elsewhere','prior','Prior', '${now}')"
    )
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
      slug: 'old-slug'
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
  })

  it('rolls back before publication or audit mutation while cutover is locked', () => {
    const db = database()
    db.exec(
      "INSERT INTO migration_runs VALUES ('d1-cutover-lock-v1:serp.software:run-1','serp.software','started','2026-07-13T00:00:00.000Z')"
    )
    expect(() => executeInTestTransaction(db, plan())).toThrow(/malformed JSON/u)
    expectUnchanged(db)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_slug_redirects').get()).toEqual({
      count: 0
    })
  })
})
