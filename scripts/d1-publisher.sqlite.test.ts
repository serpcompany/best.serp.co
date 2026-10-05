import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { hasFileExtension } from '@serpdirectory/web-core/canonical-url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, manifestSchema, type PublicationPlan } from './d1-publisher.ts'
import { project } from './project'

const beforeChecksum = 'a'.repeat(64)
const afterChecksum = createHash('sha256')
  .update(`${beforeChecksum}\0${createHash('sha256').update('sqlite manifest').digest('hex')}`)
  .digest('hex')
const now = '2026-07-13T01:00:00.000Z'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  db.exec(`
    PRAGMA foreign_keys=ON;
    INSERT INTO categories (id,slug,name) VALUES (1,'seo','SEO');
    INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
      VALUES ('lst_sqlite_test','old-slug','Old','Description','https://example.com','draft','${now}','test','fixture','${'c'.repeat(64)}');
    INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_test',1,0,1);
    UPDATE listings SET status='approved' WHERE id='lst_sqlite_test';
    INSERT INTO publication_state (id,version,manifest_id,checksum,published_at) VALUES (1,4,NULL,'${beforeChecksum}','${now}');
  `)
  return db
}

function plan(overrides: Record<string, unknown> = {}): PublicationPlan {
  const value = manifestSchema.parse({
    version: 1,
    id: 'sqlite-release',
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

/** D1 binds JavaScript booleans as integers; node:sqlite requires the conversion explicitly. */
function d1Binding(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as SQLInputValue
}

function executeInTestTransaction(db: DatabaseSync, publication: PublicationPlan): void {
  db.exec('DROP TABLE IF EXISTS publication_guard; BEGIN IMMEDIATE;')
  try {
    for (const item of publication.statements)
      db.prepare(item.query).run(...item.bindings.map(d1Binding))
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
  expect(db.prepare('SELECT version,checksum FROM publication_state WHERE id=1').get()).toEqual({
    version: 4,
    checksum: beforeChecksum
  })
  expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
}

describe('publisher plan in SQLite transaction (D1 batch emulator)', () => {
  it('rejects the retired multi-site manifest field', () => {
    expect(() =>
      manifestSchema.parse({
        version: 1,
        id: 'sqlite-release',
        siteId: 'serp.software',
        basePublicationVersion: 4,
        provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
        operations: [{ action: 'category-unpublish', slug: 'seo' }]
      })
    ).toThrow(/siteId/u)
  })

  it('refuses a published listing slug that ends in a file extension', () => {
    const manifest = (operation: Record<string, unknown>) => ({
      version: 1,
      id: 'sqlite-release',
      basePublicationVersion: 4,
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
      operations: [operation]
    })
    const rename = (from: string, to: string) =>
      manifest({
        action: 'listing-slug-change',
        id: 'lst_sqlite_test',
        from,
        to,
        categories: ['seo'],
        reason: 'Rename'
      })
    for (const to of ['chart.js', 'p5.js', 'feed.xml', 'data.JSON']) {
      expect(() => manifestSchema.parse(rename('old-slug', to)), to).toThrow(/file extension/u)
    }
    expect(() =>
      manifestSchema.parse(
        manifest({
          action: 'listing-create',
          listing: {
            id: 'lst_sqlite_test_create',
            slug: 'd3.js',
            name: 'D3',
            description: 'Charts',
            website: 'https://d3js.org/',
            publishedAt: now,
            categories: ['seo']
          }
        })
      )
    ).toThrow(/file extension/u)
    // Domain-name slugs are pages, and an existing bad slug can still be renamed away.
    expect(() => manifestSchema.parse(rename('old-slug', 'autoenhance.ai'))).not.toThrow()
    expect(() => manifestSchema.parse(rename('chart.js', 'chart-js'))).not.toThrow()
  })

  it('keeps every slug in the reviewed initial import a page URL', () => {
    const report = parse(readFileSync(resolve(project.artifact.parityReportPath), 'utf8')) as {
      parity: { categories: Array<{ slug: string }>; exactSlugSet: string[] }
    }
    expect(report.parity.exactSlugSet.length).toBeGreaterThan(3000)
    expect(report.parity.exactSlugSet.filter(value => hasFileExtension(value))).toEqual([])
    expect(
      report.parity.categories.map(category => category.slug).filter(hasFileExtension)
    ).toEqual([])
  })

  it('commits a verified checksum transition and audited redirect', () => {
    const db = database()
    const publication = plan()
    executeInTestTransaction(db, publication)
    expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
      slug: 'new-slug'
    })
    expect(db.prepare('SELECT version,checksum FROM publication_state WHERE id=1').get()).toEqual({
      version: 5,
      checksum: afterChecksum
    })
    expect(
      db
        .prepare(
          'SELECT before_checksum,after_checksum,outcome,affected_routes FROM publication_runs'
        )
        .get()
    ).toEqual({
      before_checksum: beforeChecksum,
      after_checksum: afterChecksum,
      outcome: 'succeeded',
      affected_routes: publication.affectedRoutes
    })
    expect(
      db.prepare('SELECT listing_id,old_slug,new_slug FROM listing_slug_redirects').get()
    ).toEqual({ listing_id: 'lst_sqlite_test', old_slug: 'old-slug', new_slug: 'new-slug' })
    expect(publication.affectedRoutes.split('\n')).toEqual(
      expect.arrayContaining([
        '/',
        '/products/',
        '/products/old-slug/',
        '/products/new-slug/',
        '/products/categories/seo/',
        '/sitemap-index.xml',
        '/rss.xml'
      ])
    )
  })

  it('creates a category and a published listing with its primary category', () => {
    const db = database()
    executeInTestTransaction(
      db,
      plan({
        operations: [
          {
            action: 'category-create',
            category: { slug: 'analytics', name: 'Analytics', description: '', order: 2 }
          },
          {
            action: 'listing-create',
            listing: {
              id: 'lst_created_listing',
              slug: 'created-listing',
              name: 'Created',
              description: 'Created listing',
              website: 'https://created.example',
              publishedAt: now,
              categories: ['analytics', 'seo'],
              media: { logo: 'https://created.example/logo.png' },
              faqs: [{ question: 'Q?', answer: 'A.' }]
            }
          }
        ]
      })
    )
    expect(
      db
        .prepare(
          "SELECT status,is_active,display_order,source_kind FROM listings WHERE id='lst_created_listing'"
        )
        .get()
    ).toEqual({
      status: 'approved',
      is_active: 1,
      display_order: 1,
      source_kind: 'yaml-manifest-v1'
    })
    expect(
      db
        .prepare(
          "SELECT c.slug,lc.is_primary FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id='lst_created_listing' ORDER BY lc.sort_order"
        )
        .all()
    ).toEqual([
      { slug: 'analytics', is_primary: 1 },
      { slug: 'seo', is_primary: 0 }
    ])
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 5
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

  it('rolls back when publication state is missing', () => {
    const db = database()
    db.exec('DELETE FROM publication_state')
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
  })

  it('rolls back when the listing is not an eligible published row', () => {
    const db = database()
    db.exec("UPDATE listings SET status='draft'")
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
    db.exec(`
      INSERT INTO categories (id,slug,name) VALUES (2,'extra','Extra');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_test',2,1,0);
    `)
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expectUnchanged(db)
  })

  it('rolls back redirect collision', () => {
    const db = database()
    db.exec(
      `INSERT INTO listing_slug_redirects (listing_id,old_slug,new_slug,manifest_id,reason,created_at) VALUES ('lst_sqlite_test','old-slug','elsewhere','prior','Prior','${now}')`
    )
    expect(() => executeInTestTransaction(db, plan())).toThrow()
    expect(db.prepare("SELECT slug FROM listings WHERE id='lst_sqlite_test'").get()).toEqual({
      slug: 'old-slug'
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
  })
})
