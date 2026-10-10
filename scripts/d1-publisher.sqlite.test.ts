import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createCatalogOperations } from '../apps/web/src/db/catalog'
import { isUnpublishedListingSlug } from '../apps/web/src/db/catalog-epoch'
import { createDatabase } from '../apps/web/src/db/client'
import {
  openListingClaimStatuses,
  openRevisionStatuses,
  orderStatuses,
  submissionStatuses
} from '../apps/web/src/db/schema'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { MemoryCatalogCache, SqliteD1 } from '../apps/web/src/db/test-support'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import {
  buildPublicationPlan,
  executePublicationPlan,
  LISTING_HAS_OWNERSHIP_RECORDS,
  manifestSchema,
  type PublicationPlan,
  parseManifest
} from './d1-publisher.ts'

vi.mock('server-only', () => ({}))

const beforeChecksum = 'a'.repeat(64)
const afterChecksum = createHash('sha256')
  .update(`${beforeChecksum}\0${createHash('sha256').update('sqlite manifest').digest('hex')}`)
  .digest('hex')
const now = '2026-07-13T01:00:00.000Z'
const hostedLogo = (slug: string) => ({
  bytes: 2048,
  contentType: 'image/png',
  height: 128,
  key: `best.serp.co/listings/${slug}/logo/${'a'.repeat(16)}.png`,
  sha256: 'a'.repeat(64),
  source: 'https://created.example/logo.png',
  width: 128
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  return seed(db)
}

/** The rows every test starts from: the `seo` category, one live listing, and version 4. */
function seed(db: DatabaseSync): DatabaseSync {
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
  db.exec('BEGIN IMMEDIATE;')
  try {
    for (const item of publication.statements) {
      // The production publisher's SQL gets the same D1 limit and self-comparison checks (#77).
      assertD1StatementLimits(item.query, item.bindings)
      db.prepare(item.query).run(...item.bindings.map(d1Binding))
    }
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

  it('takes an ISO instant or the calendar date imported listings store as publishedAt', () => {
    const create = (publishedAt: string) => ({
      version: 1,
      id: 'sqlite-release',
      basePublicationVersion: 4,
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
      operations: [
        {
          action: 'listing-create',
          listing: {
            id: 'lst_sqlite_test_create',
            slug: 'new-listing',
            name: 'New',
            description: 'Description',
            website: 'https://example.com/',
            publishedAt,
            categories: ['seo']
          }
        }
      ]
    })
    // Listings sort by `published_at` text: a manifest must be able to keep `2026-05-16` (#89).
    for (const value of [now, '2026-05-16']) {
      expect(() => manifestSchema.parse(create(value)), value).not.toThrow()
    }
    for (const value of ['2026-5-16', '16/05/2026', '2026-05-16T00:00:00', '2026-13-01', '']) {
      expect(() => manifestSchema.parse(create(value)), value).toThrow()
    }
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
              media: { logo: hostedLogo('created-listing') },
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
    // Media are written as hosted keys, never as URLs (#95).
    expect(
      db
        .prepare(
          "SELECT kind,url,media_key,content_type FROM listing_media WHERE listing_id='lst_created_listing'"
        )
        .all()
    ).toEqual([
      {
        content_type: 'image/png',
        kind: 'logo',
        media_key: hostedLogo('created-listing').key,
        url: 'https://created.example/logo.png'
      }
    ])
  })

  it('refuses logo and image URLs, and keys of another kind or a forged digest (#95)', () => {
    const create = (logo: unknown) =>
      manifestSchema.safeParse({
        version: 1,
        id: 'sqlite-release',
        basePublicationVersion: 4,
        provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
        operations: [
          {
            action: 'listing-create',
            listing: {
              id: 'lst_created_listing',
              slug: 'created-listing',
              name: 'Created',
              description: 'Created listing',
              website: 'https://created.example',
              publishedAt: now,
              categories: ['seo'],
              media: { logo }
            }
          }
        ]
      }).success
    expect(create(hostedLogo('created-listing'))).toBe(true)
    expect(create('https://created.example/logo.png')).toBe(false)
    expect(create({ ...hostedLogo('created-listing'), sha256: 'b'.repeat(64) })).toBe(false)
    expect(create({ ...hostedLogo('created-listing'), contentType: 'image/webp' })).toBe(false)
    expect(
      create({
        ...hostedLogo('created-listing'),
        key: hostedLogo('created-listing').key.replace(
          '/listings/created-listing/',
          '/submissions/s1/'
        )
      })
    ).toBe(false)
  })

  it('clears queued media slots when a listing update replaces its media (#95)', () => {
    const db = database()
    db.exec(`
      INSERT INTO media_ingestions (listing_id,kind,sort_order,source_url,next_attempt_at)
        VALUES ('lst_sqlite_test','logo',0,'https://old.example/logo.png','${now}');
    `)
    executeInTestTransaction(
      db,
      plan({
        operations: [
          {
            action: 'listing-update',
            previousCategories: ['seo'],
            listing: {
              id: 'lst_sqlite_test',
              slug: 'old-slug',
              name: 'Old',
              description: 'Description',
              website: 'https://example.com',
              publishedAt: now,
              categories: ['seo'],
              media: { logo: hostedLogo('old-slug') }
            }
          }
        ]
      })
    )
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_ingestions').get()).toEqual({
      count: 0
    })
    expect(db.prepare("SELECT media_key FROM listing_media WHERE kind='logo'").get()).toEqual({
      media_key: hostedLogo('old-slug').key
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

  describe('listing-media-update (#95)', () => {
    const sha = (digit: string) => digit.repeat(64)
    const hosted = (kind: 'image' | 'logo', digit: string, slug = 'old-slug') => ({
      bytes: 2048,
      contentType: 'image/png',
      height: 128,
      key: `best.serp.co/listings/${slug}/${kind}/${sha(digit).slice(0, 16)}.png`,
      sha256: sha(digit),
      source: `https://assets.example/${kind}-${digit}.png`,
      width: 128
    })
    const mediaUpdate = (overrides: Record<string, unknown> = {}) => ({
      action: 'listing-media-update',
      id: 'lst_sqlite_test',
      slug: 'old-slug',
      expected: [
        { kind: 'image', url: 'https://dead.example/shot.png' },
        { kind: 'logo', url: 'https://imagedelivery.net/x/old-slug/public' }
      ],
      media: { logo: hosted('logo', 'a'), images: [hosted('image', 'b')] },
      ...overrides
    })
    const mediaDatabase = () => {
      const db = database()
      db.exec(`
        INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES
          ('lst_sqlite_test','logo','https://imagedelivery.net/x/old-slug/public',0),
          ('lst_sqlite_test','image','https://dead.example/shot.png',1),
          ('lst_sqlite_test','video','https://www.youtube.com/watch?v=1',0);
        INSERT INTO media_ingestions (listing_id,kind,sort_order,source_url,next_attempt_at)
          VALUES ('lst_sqlite_test','logo',0,'https://queued.example/logo.png','${now}');
      `)
      return db
    }

    it('replaces the logo and images with hosted copies, keeping video and clearing the queue', () => {
      const db = mediaDatabase()
      const publication = plan({ operations: [mediaUpdate()] })
      executeInTestTransaction(db, publication)
      expect(
        db
          .prepare(
            "SELECT kind,url,sort_order,media_key,content_type,width FROM listing_media WHERE listing_id='lst_sqlite_test' ORDER BY kind,sort_order"
          )
          .all()
      ).toEqual([
        {
          content_type: 'image/png',
          kind: 'image',
          media_key: hosted('image', 'b').key,
          sort_order: 0,
          url: hosted('image', 'b').source,
          width: 128
        },
        {
          content_type: 'image/png',
          kind: 'logo',
          media_key: hosted('logo', 'a').key,
          sort_order: 0,
          url: hosted('logo', 'a').source,
          width: 128
        },
        {
          content_type: null,
          kind: 'video',
          media_key: null,
          sort_order: 0,
          url: 'https://www.youtube.com/watch?v=1',
          width: null
        }
      ])
      expect(db.prepare('SELECT COUNT(*) AS count FROM media_ingestions').get()).toEqual({
        count: 0
      })
      expect(publication.affectedRoutes.split('\n')).toContain('/products/old-slug/')
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 5 })
      // Re-hosting media leaves the page as it was, so its lastmod stays (#218).
      expect(
        db.prepare("SELECT updated_at FROM listings WHERE id='lst_sqlite_test'").get()
      ).not.toEqual({ updated_at: now })
    })

    it('drops every image of a listing that has none left, and rolls back when media changed', () => {
      const db = mediaDatabase()
      executeInTestTransaction(db, plan({ operations: [mediaUpdate({ media: {} })] }))
      expect(
        db.prepare("SELECT kind FROM listing_media WHERE listing_id='lst_sqlite_test'").all()
      ).toEqual([{ kind: 'video' }])
      const changed = mediaDatabase()
      changed.exec("UPDATE listing_media SET url='https://new.example/logo.png' WHERE kind='logo'")
      expect(() =>
        executeInTestTransaction(changed, plan({ operations: [mediaUpdate()] }))
      ).toThrow()
      expect(changed.prepare("SELECT url FROM listing_media WHERE kind='logo'").get()).toEqual({
        url: 'https://new.example/logo.png'
      })
      expect(changed.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 4 })
    })

    it('applies a row-level manifest at whatever version each environment is (#97 review B3)', () => {
      const rows = (overrides: Record<string, unknown> = {}) =>
        manifestSchema.parse({
          version: 1,
          id: 'rows-release',
          concurrency: 'rows',
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
          operations: [mediaUpdate()],
          ...overrides
        })
      // Two environments that published different things since the manifest was generated.
      for (const version of [4, 17]) {
        const db = mediaDatabase()
        db.prepare('UPDATE publication_state SET version=?').run(version)
        const live = { checksum: beforeChecksum, version }
        const publication = buildPublicationPlan(rows(), 'rows manifest', now, live)
        expect(publication.base).toEqual(live)
        executeInTestTransaction(db, publication)
        expect(db.prepare('SELECT version,manifest_id FROM publication_state').get()).toEqual({
          manifest_id: 'rows-release',
          version: version + 1
        })
        expect(db.prepare("SELECT media_key FROM listing_media WHERE kind='logo'").get()).toEqual({
          media_key: hosted('logo', 'a').key
        })
      }
      // The live state is required, and a stale one still rolls the batch back.
      expect(() => buildPublicationPlan(rows(), 'rows manifest', now)).toThrow(/live publication/u)
      const stale = mediaDatabase()
      expect(() =>
        executeInTestTransaction(
          stale,
          buildPublicationPlan(rows(), 'rows manifest', now, {
            checksum: beforeChecksum,
            version: 3
          })
        )
      ).toThrow()
      // The row-level guard compares the hosted key too: a row the cron hosted meanwhile wins.
      const hostedMeanwhile = mediaDatabase()
      hostedMeanwhile.exec(
        `UPDATE listing_media SET media_key='${hosted('logo', 'f').key}',sha256='${sha('f')}',
          content_type='image/png',bytes=1,width=1,height=1 WHERE kind='logo'`
      )
      expect(() =>
        executeInTestTransaction(
          hostedMeanwhile,
          buildPublicationPlan(rows(), 'rows manifest', now, {
            checksum: beforeChecksum,
            version: 4
          })
        )
      ).toThrow()
      expect(
        hostedMeanwhile.prepare("SELECT media_key FROM listing_media WHERE kind='logo'").get()
      ).toEqual({ media_key: hosted('logo', 'f').key })
      // A row-level manifest names no base and holds only media updates; others need their base.
      expect(() => rows({ basePublicationVersion: 4 })).toThrow(/names no base/u)
      expect(() =>
        rows({ provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum } })
      ).toThrow(/names no base/u)
      expect(() =>
        rows({
          operations: [
            mediaUpdate(),
            { action: 'category-update', category: { slug: 'seo', name: 'SEO' } }
          ]
        })
      ).toThrow(/only listing-media-update/u)
      expect(() =>
        manifestSchema.parse({
          version: 1,
          id: 'no-base',
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
          operations: [mediaUpdate()]
        })
      ).toThrow(/needs basePublicationVersion/u)
    })

    it('adds a secondary category row-level, refusing a listing whose categories changed (#98)', () => {
      const db = database()
      db.exec("INSERT INTO categories (id,slug,name,is_active) VALUES (2,'adult','Adult',1)")
      const manifest = (expected: string[], add: string[]) =>
        manifestSchema.parse({
          version: 1,
          id: 'adult-category',
          concurrency: 'rows',
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
          operations: [
            {
              action: 'listing-categories-add',
              id: 'lst_sqlite_test',
              slug: 'old-slug',
              expected,
              add
            }
          ]
        })
      const live = { checksum: beforeChecksum, version: 4 }
      const publication = buildPublicationPlan(
        manifest(['seo'], ['adult']),
        'adult manifest',
        now,
        live
      )
      executeInTestTransaction(db, publication)
      expect(
        db
          .prepare(
            `SELECT c.slug, lc.is_primary, lc.sort_order FROM listing_categories lc
             JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id='lst_sqlite_test'
             ORDER BY lc.sort_order`
          )
          .all()
      ).toEqual([
        { is_primary: 1, slug: 'seo', sort_order: 0 },
        { is_primary: 0, slug: 'adult', sort_order: 1 }
      ])
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining(['/products/old-slug/', '/products/categories/adult/'])
      )
      expect(
        db.prepare("SELECT updated_at FROM listings WHERE id='lst_sqlite_test'").get()
      ).toEqual({ updated_at: now })
      // The rows no longer match: the same operation is refused, nothing written.
      expect(() =>
        executeInTestTransaction(
          db,
          buildPublicationPlan(manifest(['seo'], ['adult']), 'adult manifest again', now, {
            checksum: publication.afterChecksum,
            version: 5
          })
        )
      ).toThrow()
      expect(() => manifest(['seo', 'adult'], ['adult'])).toThrow(/already has category adult/u)
    })

    it('removes a secondary category row-level, never a primary one, refusing changed categories (#260)', () => {
      const withAdult = () => {
        const db = database()
        db.exec(`INSERT INTO categories (id,slug,name,is_active) VALUES (2,'adult','Adult',1);
          INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
            VALUES ('lst_sqlite_test',2,1,0);`)
        return db
      }
      const manifest = (expected: string[], remove: string[]) =>
        manifestSchema.parse({
          version: 1,
          id: 'adult-off',
          concurrency: 'rows',
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
          operations: [
            {
              action: 'listing-categories-remove',
              id: 'lst_sqlite_test',
              slug: 'old-slug',
              expected,
              remove
            }
          ]
        })
      const memberships = (db: DatabaseSync) =>
        db
          .prepare(
            `SELECT c.slug, lc.is_primary FROM listing_categories lc JOIN categories c
             ON c.id = lc.category_id WHERE lc.listing_id='lst_sqlite_test' ORDER BY lc.sort_order`
          )
          .all()
      const live = { checksum: beforeChecksum, version: 4 }
      const db = withAdult()
      const publication = buildPublicationPlan(
        manifest(['seo', 'adult'], ['adult']),
        'm',
        now,
        live
      )
      executeInTestTransaction(db, publication)
      expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'seo' }])
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining(['/products/old-slug/', '/products/categories/adult/'])
      )
      expect(
        db.prepare("SELECT updated_at FROM listings WHERE id='lst_sqlite_test'").get()
      ).toEqual({ updated_at: now })
      // Applied once: the categories no longer match, so the same operation is refused.
      expect(() =>
        executeInTestTransaction(
          db,
          buildPublicationPlan(manifest(['seo', 'adult'], ['adult']), 'again', now, {
            checksum: publication.afterChecksum,
            version: 5
          })
        )
      ).toThrow()
      // The primary category is never removed: the batch refuses and writes nothing.
      const primary = withAdult()
      // Adult as the primary (swapped while the listing is a draft, as the triggers require).
      primary.exec(`UPDATE listings SET status='draft' WHERE id='lst_sqlite_test';
        UPDATE listing_categories SET is_primary=0 WHERE category_id=1;
        UPDATE listing_categories SET is_primary=1 WHERE category_id=2;
        UPDATE listings SET status='approved' WHERE id='lst_sqlite_test';`)
      expect(() =>
        executeInTestTransaction(
          primary,
          buildPublicationPlan(manifest(['seo', 'adult'], ['adult']), 'm', now, live)
        )
      ).toThrow()
      expect(memberships(primary)).toEqual([
        { is_primary: 0, slug: 'seo' },
        { is_primary: 1, slug: 'adult' }
      ])
      expect(() => manifest(['seo'], ['adult'])).toThrow(/does not have category adult/u)
      expect(() => manifest(['adult'], ['adult'])).toThrow(/keeps at least one category/u)
    })

    it("refuses another listing's key, a key of the wrong kind, and a forged digest", () => {
      const refused = (operation: Record<string, unknown>) => () =>
        manifestSchema.parse({
          version: 1,
          id: 'sqlite-release',
          basePublicationVersion: 4,
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite', beforeChecksum },
          operations: [operation]
        })
      expect(refused(mediaUpdate())).not.toThrow()
      expect(refused(mediaUpdate({ media: { logo: hosted('logo', 'a', 'other-slug') } }))).toThrow(
        /not this listing's logo/u
      )
      expect(refused(mediaUpdate({ media: { logo: hosted('image', 'a') } }))).toThrow(
        /not this listing's logo/u
      )
      expect(
        refused(mediaUpdate({ media: { logo: { ...hosted('logo', 'a'), sha256: sha('c') } } }))
      ).toThrow(/Invalid hosted media key/u)
      expect(
        refused(
          mediaUpdate({ media: { logo: { ...hosted('logo', 'a'), contentType: 'image/webp' } } })
        )
      ).toThrow(/extension must match/u)
    })
  })
})

describe('listing-unpublish (the admin panel’s unpublished state, #64 and #100)', () => {
  const unpublish = (extra: Record<string, unknown> = {}) =>
    plan({
      operations: [
        {
          action: 'listing-unpublish',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          categories: ['seo'],
          reason: 'hijacked domain: gambling',
          expected: { website: 'https://example.com' },
          ...extra
        }
      ]
    })
  const listingState = (db: DatabaseSync) =>
    db.prepare("SELECT slug,status,is_active FROM listings WHERE id='lst_sqlite_test'").get()

  it('keeps the row, sets is_active=0, logs the reason, and turns over the catalog', () => {
    const db = database()
    const publication = unpublish()
    executeInTestTransaction(db, publication)
    // The row stays: approved and inactive is what the 410 route and Republish look for.
    expect(listingState(db)).toEqual({ slug: 'old-slug', status: 'approved', is_active: 0 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_categories WHERE listing_id='lst_sqlite_test'"
        )
        .get()
    ).toEqual({ count: 1 })
    expect(
      db.prepare('SELECT listing_id,event_type,detail,actor FROM listing_events').all()
    ).toEqual([
      {
        listing_id: 'lst_sqlite_test',
        event_type: 'unpublished',
        detail: JSON.stringify({ manifest: 'sqlite-release', reason: 'hijacked domain: gambling' }),
        actor: 'test@example.com'
      }
    ])
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 5
    })
    expect(publication.affectedRoutes.split('\n')).toEqual(
      expect.arrayContaining([
        '/products/old-slug/',
        '/products/categories/seo/',
        '/search/',
        '/rss.xml'
      ])
    )
  })

  it('records the unpublish on the listing’s approved submission, as the admin panel does', () => {
    const db = database()
    db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,listing_id)
      VALUES ('sub','example.com','Old','d','https://example.com/','c','seo','l','approved','free',
        'lst_sqlite_test')`)
    executeInTestTransaction(db, unpublish())
    expect(
      db.prepare('SELECT submission_id,event_type,detail FROM listing_submission_events').all()
    ).toEqual([
      { submission_id: 'sub', event_type: 'unpublished', detail: 'hijacked domain: gambling' }
    ])
  })

  it.each([
    [
      'the website changed since the manifest was generated',
      (db: DatabaseSync) => db.exec("UPDATE listings SET website='https://moved.example'")
    ],
    [
      'the listing is already unpublished',
      (db: DatabaseSync) => db.exec('UPDATE listings SET is_active=0')
    ],
    [
      'the listing’s own submission is in review',
      (db: DatabaseSync) =>
        db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,
            category_slug,logo_url,status,plan,paid_at,listing_id,published_checksum)
          VALUES ('sub','example.com','Old','d','https://example.com/','c','seo','l',
            'paid_pending_review','paid','${now}','lst_sqlite_test','checksum')`)
    ],
    [
      'its categories changed',
      (db: DatabaseSync) =>
        db.exec(`INSERT INTO categories (id,slug,name) VALUES (2,'extra','Extra');
          INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
            VALUES ('lst_sqlite_test',2,1,0);`)
    ]
  ])('refuses the whole batch when %s', (_name, change) => {
    const db = database()
    change(db)
    const before = listingState(db)
    expect(() => executeInTestTransaction(db, unpublish())).toThrow()
    expect(listingState(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 4
    })
  })

  it('still accepts the original operation without a reason or expected row', () => {
    const db = database()
    executeInTestTransaction(db, unpublish({ reason: undefined, expected: undefined }))
    expect(listingState(db)).toEqual({ slug: 'old-slug', status: 'approved', is_active: 0 })
    expect(db.prepare('SELECT detail FROM listing_events').get()).toEqual({
      detail: JSON.stringify({ manifest: 'sqlite-release', reason: null })
    })
  })

  it('applies row-level at whatever version the environment is at, guarded by its row (#100)', () => {
    const operation = {
      action: 'listing-unpublish',
      id: 'lst_sqlite_test',
      slug: 'old-slug',
      categories: ['seo'],
      reason: 'hijacked domain: gambling',
      expected: { website: 'https://example.com' }
    }
    const rows = (extra: Record<string, unknown> = {}) =>
      manifestSchema.parse({
        version: 1,
        id: 'hijacked-rows',
        concurrency: 'rows',
        provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
        operations: [{ ...operation, ...extra }]
      })
    const db = database()
    // Another publication moved this environment past the version the manifest was written at.
    db.prepare('UPDATE publication_state SET version=9, checksum=?').run('b'.repeat(64))
    executeInTestTransaction(
      db,
      buildPublicationPlan(rows(), 'rows manifest', now, { checksum: 'b'.repeat(64), version: 9 })
    )
    expect(listingState(db)).toEqual({ slug: 'old-slug', status: 'approved', is_active: 0 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 10
    })
    // The row guards still hold: a moved website refuses the batch at any version.
    const moved = database()
    moved.exec("UPDATE listings SET website='https://moved.example'")
    expect(() =>
      executeInTestTransaction(
        moved,
        buildPublicationPlan(rows(), 'rows manifest', now, { checksum: beforeChecksum, version: 4 })
      )
    ).toThrow()
    expect(listingState(moved)).toEqual({ slug: 'old-slug', status: 'approved', is_active: 1 })
    // Row-level, the website guard is required.
    expect(() => rows({ expected: undefined })).toThrow(/needs expected.website/u)
  })

  it('refuses an empty reason and an unknown expected field', () => {
    expect(() => unpublish({ reason: '  ' })).toThrow()
    expect(() => unpublish({ expected: { website: 'https://example.com', name: 'Old' } })).toThrow()
    expect(() => unpublish({ expected: { website: 'not a url' } })).toThrow()
  })
})

describe('listing-unpublish with expected.unowned (#332: retiring a duplicate listing)', () => {
  const retire = (unowned = true) =>
    plan({
      operations: [
        {
          action: 'listing-unpublish',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          categories: ['seo'],
          reason: '#332 duplicate of new-slug',
          expected: { website: 'https://example.com', ...(unowned ? { unowned: true } : {}) }
        }
      ]
    })
  const isActive = (db: DatabaseSync) =>
    db.prepare("SELECT is_active FROM listings WHERE id='lst_sqlite_test'").get()
  const user = `INSERT INTO users (id,name,email,email_verified)
    VALUES ('user_maker','Maker','maker@example.com',1);`
  const owner = (revoked: boolean) => `INSERT INTO listing_owners (listing_id,user_id,verified_via,
      verified_at,revoked_at,revoked_reason)
    VALUES ('lst_sqlite_test','user_maker','badge_claim','${now}',
      ${revoked ? `'${now}','admin removed'` : 'NULL,NULL'});`
  const claim = (
    status: string
  ) => `INSERT INTO listing_claims (id,listing_id,user_id,method,status,
      email,email_domain,product_url,listing_website,code_sent_at,code_expires_at,email_verified_at)
    VALUES ('claim_${status}','lst_sqlite_test','user_maker','paid','${status}','maker@example.com',
      'example.com','https://example.com/','https://example.com','${now}','${now}',
      ${status === 'code_sent' ? 'NULL' : `'${now}'`});`
  /** A paid-claim order on the listing, or with `submission` a paid submission's order. */
  const order = (status: string, number: number, submission?: string) => {
    const paid = status !== 'pending' && status !== 'failed'
    const refund = status === 'refunding' || status === 'refunded'
    const target = submission
      ? `'paid_listing','submission','submission:${submission}','${submission}',NULL,NULL`
      : `'paid_claim','claim','claim:claim_${number}',NULL,'lst_sqlite_test','claim_${number}'`
    return `INSERT INTO orders (id,number,user_id,kind,purpose,target_key,submission_id,listing_id,
        claim_id,amount_cents,currency,provider,status,paid_at,provider_payment_id,charged_cents,
        charged_currency,refund_reason,refund_requested_at,refunded_at,failed_at,created_at,
        updated_at)
      VALUES ('order_${number}',${number},'user_maker',${target},4900,'usd','stripe','${status}',
        ${paid ? `'${now}','pi_${number}',4900,'usd'` : 'NULL,NULL,NULL,NULL'},
        ${refund ? `'rejected','${now}'` : 'NULL,NULL'},
        ${status === 'refunded' ? `'${now}'` : 'NULL'},${status === 'failed' ? `'${now}'` : 'NULL'},
        '${now}','${now}');`
  }
  const revision = (status: string) => `INSERT INTO listing_revisions (id,listing_id,author_user_id,
      status,base_checksum,name,description,content,category_slug,logo_url)
    VALUES ('rev_${status}','lst_sqlite_test','user_maker','${status}','c','Old','d','c','seo',
      'https://example.com/logo.png');`
  const submission = (id: string, status: string) => `INSERT INTO listing_submissions (id,slug,name,
      description,website,content,category_slug,logo_url,status,plan,listing_id,rejection_category,
      rejection_reason,withdrawal_reason)
    VALUES ('${id}','${id}.example','Old','d','https://${id}.example/','c','seo','l','${status}',
      'free','lst_sqlite_test',${status === 'rejected' ? "'other','not a product'" : 'NULL,NULL'},
      ${status === 'withdrawn' ? "'owner'" : 'NULL'});`

  it('retires a listing whose ownership records are all closed', () => {
    const db = database()
    db.exec(
      [
        user,
        owner(true),
        claim('cancelled'),
        order('failed', 1),
        order('refunded', 2),
        revision('rejected'),
        submission('sub_rejected', 'rejected'),
        submission('sub_withdrawn', 'withdrawn')
      ].join('\n')
    )
    executeInTestTransaction(db, retire())
    expect(isActive(db)).toEqual({ is_active: 0 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 5
    })
  })

  it.each([
    ['a current owner', owner(false)],
    ['a claim waiting for its code', claim('code_sent')],
    ['a claim waiting for the badge or the payment', claim('email_verified')],
    ['a pending order', order('pending', 1)],
    ['a paid order', order('paid', 1)],
    ['an order being refunded', order('refunding', 1)],
    [
      'a paid order on its submission',
      `${submission('sub_rejected', 'rejected')}\n${order('paid', 1, 'sub_rejected')}`
    ],
    ['a revision in review', revision('pending_review')],
    ['a revision sent back for changes', revision('changes_requested')],
    ['an open submission', submission('sub_verified', 'verified')],
    ['an approved submission (the badge program’s free listing)', submission('sub_ok', 'approved')]
  ])('refuses the whole batch when the listing has %s', (_name, records) => {
    const db = database()
    db.exec(`${user}\n${records}`)
    expect(() => executeInTestTransaction(db, retire())).toThrow()
    expect(isActive(db)).toEqual({ is_active: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 4
    })
    // The guard is opt-in: without `unowned`, a hygiene unpublish (a hijacked or dead domain)
    // of the same listing still applies.
    executeInTestTransaction(db, retire(false))
    expect(isActive(db)).toEqual({ is_active: 0 })
  })

  it('names the schema’s own open statuses', () => {
    const list = (values: readonly string[]) => values.map(value => `'${value}'`).join(',')
    expect(LISTING_HAS_OWNERSHIP_RECORDS).toContain(`status IN (${list(openListingClaimStatuses)})`)
    expect(LISTING_HAS_OWNERSHIP_RECORDS).toContain(`status IN (${list(openRevisionStatuses)})`)
    // Orders: every status but the two that end without money held.
    expect(LISTING_HAS_OWNERSHIP_RECORDS).toContain(
      `status IN (${list(orderStatuses.filter(status => status !== 'refunded' && status !== 'failed'))})`
    )
    expect(submissionStatuses).toEqual(expect.arrayContaining(['rejected', 'withdrawn']))
  })

  it('takes unowned only as true, and only on the expected row', () => {
    const op = (expected: Record<string, unknown>) =>
      plan({
        operations: [
          {
            action: 'listing-unpublish',
            id: 'lst_sqlite_test',
            slug: 'old-slug',
            categories: ['seo'],
            expected
          }
        ]
      })
    expect(() => op({ website: 'https://example.com', unowned: false })).toThrow()
    expect(() => op({ unowned: true })).toThrow()
  })
})

describe('category-unpublish in a row-level manifest (#260: retire the Adult category)', () => {
  const unpublishListing = {
    action: 'listing-unpublish',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    categories: ['seo', 'adult'],
    reason: '#260 adult',
    expected: { website: 'https://example.com' }
  }
  const rows = (operations: Record<string, unknown>[]) =>
    manifestSchema.parse({
      version: 1,
      id: 'retire-adult',
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations
    })
  /** The fixture listing also filed under Adult, as a secondary category. */
  const withAdult = () => {
    const db = database()
    db.exec(`INSERT INTO categories (id,slug,name) VALUES (2,'adult','Adult');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        VALUES ('lst_sqlite_test',2,1,0);`)
    return db
  }
  const categories = (db: DatabaseSync) =>
    db.prepare('SELECT slug,is_active FROM categories ORDER BY id').all()
  const live = { checksum: beforeChecksum, version: 4 }
  const listingState = (db: DatabaseSync) =>
    db.prepare("SELECT slug,status,is_active FROM listings WHERE id='lst_sqlite_test'").get()

  it('retires the category once its last live listing is unpublished, at any version', () => {
    const db = withAdult()
    db.prepare('UPDATE publication_state SET version=9').run()
    const publication = buildPublicationPlan(
      rows([unpublishListing, { action: 'category-unpublish', slug: 'adult' }]),
      'retire manifest',
      now,
      { ...live, version: 9 }
    )
    executeInTestTransaction(db, publication)
    expect(categories(db)).toEqual([
      { slug: 'seo', is_active: 1 },
      { slug: 'adult', is_active: 0 }
    ])
    expect(listingState(db)).toEqual({ is_active: 0, slug: 'old-slug', status: 'approved' })
    expect(publication.affectedRoutes.split('\n')).toContain('/products/categories/adult/')
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 10
    })
  })

  it('refuses the whole batch while a live listing remains in the category, or it comes first', () => {
    for (const operations of [
      // The listing stays live.
      [{ action: 'category-unpublish', slug: 'adult' }],
      // Retired first, the listing no longer has the active categories its unpublish expects.
      [{ action: 'category-unpublish', slug: 'adult' }, unpublishListing]
    ]) {
      const db = withAdult()
      expect(() =>
        executeInTestTransaction(db, buildPublicationPlan(rows(operations), 'm', now, live))
      ).toThrow()
      expect(categories(db)).toEqual([
        { slug: 'seo', is_active: 1 },
        { slug: 'adult', is_active: 1 }
      ])
      expect(listingState(db)).toEqual({ is_active: 1, slug: 'old-slug', status: 'approved' })
    }
    // An unknown category changes no row.
    const db = database()
    expect(() =>
      executeInTestTransaction(
        db,
        buildPublicationPlan(rows([{ action: 'category-unpublish', slug: 'nope' }]), 'm', now, live)
      )
    ).toThrow()
  })
})

describe('listing-categories-set and category-create in a row-level manifest (#333: out of Other)', () => {
  const live = { checksum: beforeChecksum, version: 4 }
  const rows = (operations: Record<string, unknown>[]) =>
    manifestSchema.parse({
      version: 1,
      id: 'out-of-other',
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations
    })
  const set = (expected: string[], categories: string[], extra: Record<string, unknown> = {}) => ({
    action: 'listing-categories-set',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    expected,
    categories,
    ...extra
  })
  /**
   * The fixture listing and a second live listing, both filed only under Other, with an active
   * AI Chatbots category and a retired one. The fixture listing moves while a draft, as the
   * primary-category triggers require.
   */
  const inOther = () => {
    const db = database()
    db.exec(`INSERT INTO categories (id,slug,name) VALUES (2,'other','Other'),(3,'ai-chatbots','AI Chatbots');
      INSERT INTO categories (id,slug,name,is_active) VALUES (4,'retired','Retired',0);
      UPDATE listings SET status='draft' WHERE id='lst_sqlite_test';
      UPDATE listing_categories SET category_id=2 WHERE listing_id='lst_sqlite_test';
      UPDATE listings SET status='approved' WHERE id='lst_sqlite_test';
      INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
        VALUES ('lst_sqlite_other','other-product','Other product','Description','https://other.example','draft','${now}','test','fixture','${'d'.repeat(64)}');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_other',2,0,1);
      UPDATE listings SET status='approved' WHERE id='lst_sqlite_other';`)
    return db
  }
  const memberships = (db: DatabaseSync, id = 'lst_sqlite_test') =>
    db
      .prepare(
        `SELECT c.slug, lc.is_primary, lc.sort_order FROM listing_categories lc
         JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id=? ORDER BY lc.sort_order`
      )
      .all(id)
  /** Live listings per category, as the category index counts them (primary or secondary). */
  const liveCounts = (db: DatabaseSync) =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT c.slug, COUNT(l.id) AS count FROM categories c
             LEFT JOIN listing_categories lc ON lc.category_id=c.id
             LEFT JOIN listings l ON l.id=lc.listing_id AND l.status='approved' AND l.is_active=1
             WHERE c.is_active=1 GROUP BY c.slug`
          )
          .all() as Array<{ slug: string; count: number }>
      ).map(row => [row.slug, row.count])
    )
  const listingState = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT status,is_active,checksum,updated_at FROM listings WHERE id='lst_sqlite_test'"
      )
      .get()
  /** Asserts the batch was refused whole: the listing, its categories, and the version as before. */
  const expectRefused = (db: DatabaseSync, before: ReturnType<typeof listingState>) => {
    expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'other', sort_order: 0 }])
    expect(listingState(db)).toEqual(before)
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 4
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
  }

  it('moves a listing out of Other to a new primary and secondaries, and Other loses it', () => {
    const db = inOther()
    expect(liveCounts(db)).toMatchObject({ other: 2, 'ai-chatbots': 0, seo: 0 })
    const before = listingState(db) as { checksum: string }
    db.prepare('UPDATE publication_state SET version=9').run()
    const publication = buildPublicationPlan(
      rows([set(['other'], ['ai-chatbots', 'seo'])]),
      'out of other',
      now,
      { ...live, version: 9 }
    )
    // `is_primary` binds as 1 or 0: D1's REST API gets the same values as the Worker binding.
    expect(
      publication.statements.flatMap(item => item.bindings).filter(b => typeof b === 'boolean')
    ).toEqual([])
    executeInTestTransaction(db, publication)
    expect(memberships(db)).toEqual([
      { is_primary: 1, slug: 'ai-chatbots', sort_order: 0 },
      { is_primary: 0, slug: 'seo', sort_order: 1 }
    ])
    expect(liveCounts(db)).toMatchObject({ other: 1, 'ai-chatbots': 1, seo: 1 })
    expect(memberships(db, 'lst_sqlite_other')).toEqual([
      { is_primary: 1, slug: 'other', sort_order: 0 }
    ])
    // Published again, with a new checksum (a stale admin edit is refused) and lastmod.
    const after = listingState(db) as { checksum: string; status: string; updated_at: string }
    expect(after).toMatchObject({ status: 'approved', is_active: 1, updated_at: now })
    expect(after.checksum).not.toBe(before.checksum)
    expect(
      db.prepare('SELECT listing_id,event_type,detail,actor FROM listing_events').all()
    ).toEqual([
      {
        listing_id: 'lst_sqlite_test',
        event_type: 'edited',
        detail: JSON.stringify({
          fields: ['categories'],
          manifest: 'out-of-other',
          from: ['other'],
          to: ['ai-chatbots', 'seo']
        }),
        actor: 'test@example.com'
      }
    ])
    // The catalog epoch turns over, and the run names every page the move changed.
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 10
    })
    expect(publication.affectedRoutes.split('\n')).toEqual(
      expect.arrayContaining([
        '/products/old-slug/',
        '/products/categories/other/',
        '/products/categories/ai-chatbots/',
        '/products/categories/seo/'
      ])
    )
    // Applied once: the categories no longer match, so the same operation is refused.
    expect(() =>
      executeInTestTransaction(
        db,
        buildPublicationPlan(rows([set(['other'], ['ai-chatbots', 'seo'])]), 'again', now, {
          checksum: publication.afterChecksum,
          version: 10
        })
      )
    ).toThrow()
    expect(memberships(db)).toEqual([
      { is_primary: 1, slug: 'ai-chatbots', sort_order: 0 },
      { is_primary: 0, slug: 'seo', sort_order: 1 }
    ])
  })

  it('promotes a secondary to primary and drops the old primary', () => {
    const db = inOther()
    const first = buildPublicationPlan(
      rows([set(['other'], ['ai-chatbots', 'other'])]),
      'm',
      now,
      live
    )
    executeInTestTransaction(db, first)
    expect(memberships(db)).toEqual([
      { is_primary: 1, slug: 'ai-chatbots', sort_order: 0 },
      { is_primary: 0, slug: 'other', sort_order: 1 }
    ])
    executeInTestTransaction(
      db,
      buildPublicationPlan(rows([set(['ai-chatbots', 'other'], ['other'])]), 'm2', now, {
        checksum: first.afterChecksum,
        version: 5
      })
    )
    expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'other', sort_order: 0 }])
  })

  it('refuses the whole batch when the categories changed since generation', () => {
    const db = inOther()
    const before = listingState(db)
    for (const [expected, categories] of [
      [['seo'], ['ai-chatbots']],
      [['other', 'seo'], ['ai-chatbots']],
      [['ai-chatbots'], ['seo']]
    ]) {
      expect(() =>
        executeInTestTransaction(
          db,
          buildPublicationPlan(rows([set(expected, categories)]), 'm', now, live)
        )
      ).toThrow()
      expectRefused(db, before)
    }
    // Another listing's change in the same batch is rolled back with it.
    expect(() =>
      executeInTestTransaction(
        db,
        buildPublicationPlan(
          rows([
            set(['other'], ['ai-chatbots'], { id: 'lst_sqlite_other', slug: 'other-product' }),
            set(['seo'], ['ai-chatbots'])
          ]),
          'm',
          now,
          live
        )
      )
    ).toThrow()
    expect(memberships(db, 'lst_sqlite_other')).toEqual([
      { is_primary: 1, slug: 'other', sort_order: 0 }
    ])
    // A renamed listing: the slug no longer matches.
    expect(() =>
      executeInTestTransaction(
        db,
        buildPublicationPlan(
          rows([set(['other'], ['ai-chatbots'], { slug: 'new-slug' })]),
          'm',
          now,
          live
        )
      )
    ).toThrow()
    expectRefused(db, before)
  })

  it('refuses an unknown or retired category, as primary or secondary', () => {
    for (const categories of [
      ['nope'],
      ['retired'],
      ['ai-chatbots', 'retired'],
      ['ai-chatbots', 'nope']
    ]) {
      const db = inOther()
      const before = listingState(db)
      expect(
        () =>
          executeInTestTransaction(
            db,
            buildPublicationPlan(rows([set(['other'], categories)]), 'm', now, live)
          ),
        categories.join(',')
      ).toThrow()
      expectRefused(db, before)
    }
  })

  it.each(['paid_pending_review', 'changes_requested'])(
    'refuses a listing whose own submission is %s, so that paid submission can still be approved',
    status => {
      const db = inOther()
      // A paid submission's approval requires the listing's checksum to equal `published_checksum`,
      // written once at payment (`submission-plans.ts`).
      db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,
        category_slug,logo_url,status,plan,paid_at,listing_id,published_checksum)
      VALUES ('sub','example.com','Old','d','https://example.com/','c','other','l',
        '${status}','paid','${now}','lst_sqlite_test',
        (SELECT checksum FROM listings WHERE id='lst_sqlite_test'))`)
      const before = listingState(db)
      expect(() =>
        executeInTestTransaction(
          db,
          buildPublicationPlan(rows([set(['other'], ['ai-chatbots'])]), 'm', now, live)
        )
      ).toThrow()
      expectRefused(db, before)
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM listings l JOIN listing_submissions s ON s.listing_id=l.id WHERE s.id='sub' AND l.checksum=s.published_checksum"
          )
          .get()
      ).toEqual({ count: 1 })
      // Once that submission is decided, the listing moves.
      db.exec("UPDATE listing_submissions SET status='approved' WHERE id='sub'")
      executeInTestTransaction(
        db,
        buildPublicationPlan(rows([set(['other'], ['ai-chatbots'])]), 'm', now, live)
      )
      expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'ai-chatbots', sort_order: 0 }])
    }
  )

  it.each(['review', 'rejected'])(
    'refuses a listing in %s, which never comes back approved or live',
    status => {
      const db = inOther()
      // Still active with a `published_at`: approving it again would publish it.
      db.exec(`UPDATE listings SET status='${status}' WHERE id='lst_sqlite_test'`)
      const before = listingState(db)
      expect(() =>
        executeInTestTransaction(
          db,
          buildPublicationPlan(rows([set(['other'], ['ai-chatbots'])]), 'm', now, live)
        )
      ).toThrow()
      expectRefused(db, before)
      expect(listingState(db)).toMatchObject({ status, is_active: 1 })
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM listings WHERE id='lst_sqlite_test' AND status='approved' AND is_active=1 AND published_at IS NOT NULL"
          )
          .get()
      ).toEqual({ count: 0 })
    }
  )

  it('replaces an unpublished listing’s categories and leaves it unpublished', () => {
    const db = inOther()
    db.exec("UPDATE listings SET is_active=0 WHERE id='lst_sqlite_test'")
    executeInTestTransaction(
      db,
      buildPublicationPlan(rows([set(['other'], ['ai-chatbots'])]), 'm', now, live)
    )
    expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'ai-chatbots', sort_order: 0 }])
    expect(listingState(db)).toMatchObject({ status: 'approved', is_active: 0 })
  })

  it('refuses no change, a duplicate category, and an empty list', () => {
    expect(() => rows([set(['other'], ['other'])])).toThrow(/already has exactly these categories/u)
    expect(() => rows([set(['other'], ['seo', 'seo'])])).toThrow(/Duplicate affected category/u)
    expect(() => rows([set(['other'], [])])).toThrow()
    expect(() => rows([set([], ['seo'])])).toThrow()
    // A different order is a change: the first category is the primary.
    expect(() => rows([set(['seo', 'other'], ['other', 'seo'])])).not.toThrow()
  })

  it('creates a category row-level at any version and files a listing under it', () => {
    const db = inOther()
    db.prepare('UPDATE publication_state SET version=12').run()
    const publication = buildPublicationPlan(
      rows([
        {
          action: 'category-create',
          category: {
            slug: 'ai-transcription',
            name: 'AI Transcription',
            description: 'Speech to text.'
          }
        },
        set(['other'], ['ai-transcription'])
      ]),
      'new category',
      now,
      { ...live, version: 12 }
    )
    expect(
      publication.statements.flatMap(item => item.bindings).filter(b => typeof b === 'boolean')
    ).toEqual([])
    executeInTestTransaction(db, publication)
    expect(
      db
        .prepare(
          "SELECT name,description,sort_order,is_active FROM categories WHERE slug='ai-transcription'"
        )
        .get()
    ).toEqual({
      name: 'AI Transcription',
      description: 'Speech to text.',
      sort_order: 0,
      is_active: 1
    })
    expect(memberships(db)).toEqual([{ is_primary: 1, slug: 'ai-transcription', sort_order: 0 }])
    expect(publication.affectedRoutes.split('\n')).toContain(
      '/products/categories/ai-transcription/'
    )
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 13
    })
  })

  it('refuses to create a category whose slug exists, active or retired, writing nothing', () => {
    for (const slug of ['seo', 'retired']) {
      const db = inOther()
      const before = listingState(db)
      expect(
        () =>
          executeInTestTransaction(
            db,
            buildPublicationPlan(
              rows([
                { action: 'category-create', category: { slug, name: 'Again' } },
                set(['other'], ['ai-chatbots'])
              ]),
              'm',
              now,
              live
            )
          ),
        slug
      ).toThrow()
      expectRefused(db, before)
      expect(db.prepare('SELECT name FROM categories WHERE slug=?').get(slug)).not.toEqual({
        name: 'Again'
      })
    }
    // category-update still names its base version.
    expect(() =>
      rows([{ action: 'category-update', category: { slug: 'seo', name: 'SEO' } }])
    ).toThrow(/only listing-media-update/u)
  })
})

describe('listing-content-remove-suffix (#105: imported FAQ blocks move to the FAQs section)', () => {
  const body = 'Intro with an emoji 🚀 and more.'
  const suffix = '\n\n## FAQ\n\n### Is it free?\n\nYes.'
  const content = `${body}${suffix}`
  const seeded = () => {
    const db = database()
    db.prepare("UPDATE listings SET content=? WHERE id='lst_sqlite_test'").run(content)
    return db
  }
  const remove = (extra: Record<string, unknown> = {}) =>
    plan({
      operations: [
        {
          action: 'listing-content-remove-suffix',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          reason: '#105 FAQs show in the FAQs section',
          // SQLite counts characters (code points), not UTF-16 units: the emoji is one.
          expected: { contentLength: [...content].length },
          suffix,
          ...extra
        }
      ]
    })
  const row = (db: DatabaseSync) =>
    db.prepare("SELECT content,checksum FROM listings WHERE id='lst_sqlite_test'").get() as {
      checksum: string
      content: string
    }

  it('removes exactly the suffix, keeps every other character, and turns over the catalog', () => {
    const db = seeded()
    const before = row(db)
    const publication = remove()
    executeInTestTransaction(db, publication)
    const after = row(db)
    expect(after.content).toBe(body)
    // A new checksum: a revision or admin edit based on the old description is now stale.
    expect(after.checksum).not.toBe(before.checksum)
    expect(db.prepare('SELECT event_type,detail,actor FROM listing_events').all()).toEqual([
      {
        actor: 'test@example.com',
        detail: JSON.stringify({
          fields: ['content'],
          manifest: 'sqlite-release',
          reason: '#105 FAQs show in the FAQs section'
        }),
        event_type: 'edited'
      }
    ])
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 5
    })
    expect(publication.affectedRoutes.split('\n')).toContain('/products/old-slug/')
  })

  it.each([
    [
      'the description changed length',
      (db: DatabaseSync) =>
        db
          .prepare("UPDATE listings SET content=? WHERE id='lst_sqlite_test'")
          .run(`${body}!${suffix}`)
    ],
    [
      'the description no longer ends with the block',
      (db: DatabaseSync) =>
        db
          .prepare("UPDATE listings SET content=? WHERE id='lst_sqlite_test'")
          .run(`${body}${suffix.replace('Yes.', 'No!')}`)
    ],
    [
      'the listing’s own submission is in review',
      (db: DatabaseSync) =>
        db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,
          category_slug,logo_url,status,plan,paid_at,listing_id,published_checksum)
        VALUES ('sub','example.com','Old','d','https://example.com/','c','seo','l',
          'paid_pending_review','paid','${now}','lst_sqlite_test','checksum')`)
    ],
    ['the slug changed', (db: DatabaseSync) => db.exec("UPDATE listings SET slug='renamed'")]
  ])('refuses the whole batch when %s', (_name, change) => {
    const db = seeded()
    change(db)
    const before = row(db)
    expect(() => executeInTestTransaction(db, remove())).toThrow()
    expect(row(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 4
    })
  })

  it('applies row-level at whatever version each environment is, still guarded by the row', () => {
    const rows = manifestSchema.parse({
      version: 1,
      id: 'rows-faqs',
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations: [
        {
          action: 'listing-content-remove-suffix',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          reason: '#105 FAQs show in the FAQs section',
          expected: { contentLength: [...content].length },
          suffix
        }
      ]
    })
    for (const version of [4, 17]) {
      const db = seeded()
      db.prepare('UPDATE publication_state SET version=?').run(version)
      const live = { checksum: beforeChecksum, version }
      executeInTestTransaction(db, buildPublicationPlan(rows, 'rows faqs', now, live))
      expect(row(db).content).toBe(body)
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({
        version: version + 1
      })
    }
    const edited = seeded()
    edited
      .prepare("UPDATE listings SET content=? WHERE id='lst_sqlite_test'")
      .run(`${body}!${suffix}`)
    const live = { checksum: beforeChecksum, version: 4 }
    expect(() =>
      executeInTestTransaction(edited, buildPublicationPlan(rows, 'rows faqs', now, live))
    ).toThrow()
    expect(row(edited).content).toBe(`${body}!${suffix}`)
  })

  it('refuses a suffix as long as the description, and a missing reason', () => {
    expect(() => remove({ expected: { contentLength: [...suffix].length } })).toThrow(
      /shorter than the description/u
    )
    expect(() => remove({ reason: ' ' })).toThrow()
  })
})

describe('listing-claim-hold-add and -clear (#67: holds for the owner’s review)', () => {
  let live = { checksum: beforeChecksum, version: 4 }
  const rowsPlan = (operations: unknown[], version = 4) =>
    buildPublicationPlan(
      manifestSchema.parse({
        version: 1,
        id: `rows-holds-${version}`,
        concurrency: 'rows',
        provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
        operations
      }),
      'rows holds',
      now,
      { ...live, version }
    )
  const add = {
    action: 'listing-claim-hold-add',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    reason: 'off_domain',
    note: 'ends on other.example, not example.com',
    expected: { website: 'https://example.com' }
  }
  const clear = {
    action: 'listing-claim-hold-clear',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    note: 'owner checked: the product moved'
  }
  const holds = (db: DatabaseSync) =>
    db.prepare('SELECT reason,source,cleared_at,cleared_by FROM listing_claim_holds').all()

  it('places a hold row-level, leaves an active one as it is, and clears it', () => {
    const db = database()
    const sync = () => {
      live = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as typeof live
    }
    executeInTestTransaction(db, rowsPlan([add]))
    expect(holds(db)).toEqual([
      {
        cleared_at: null,
        cleared_by: null,
        reason: 'off_domain',
        source: 'manifest rows-holds-4: ends on other.example, not example.com'
      }
    ])
    // Again at the next version (an environment that already has it): no change, still held.
    sync()
    executeInTestTransaction(db, rowsPlan([add], 5))
    expect(holds(db)).toHaveLength(1)
    sync()
    executeInTestTransaction(db, rowsPlan([clear], 6))
    expect(holds(db)).toEqual([
      expect.objectContaining({
        cleared_at: now,
        cleared_by: 'test@example.com (manifest rows-holds-6: owner checked: the product moved)'
      })
    ])
    // Clearing twice is refused; adding again places a new hold.
    sync()
    expect(() => executeInTestTransaction(db, rowsPlan([clear], 7))).toThrow()
    executeInTestTransaction(db, rowsPlan([add], 7))
    expect(holds(db)).toEqual([expect.objectContaining({ cleared_at: null, cleared_by: null })])
  })

  it('refuses a listing whose slug or website changed since the report', () => {
    live = { checksum: beforeChecksum, version: 4 }
    for (const change of [
      "UPDATE listings SET website='https://moved.example/' WHERE id='lst_sqlite_test'",
      "UPDATE listings SET slug='renamed' WHERE id='lst_sqlite_test'"
    ]) {
      const db = database()
      db.exec(change)
      expect(() => executeInTestTransaction(db, rowsPlan([add])), change).toThrow()
      expect(holds(db)).toEqual([])
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 4 })
    }
  })
})

describe('listing-slug-redirect (#338: a retired duplicate answers 308 to the listing it duplicated)', () => {
  const live = { checksum: beforeChecksum, version: 4 }
  const redirect = {
    action: 'listing-slug-redirect',
    from: { id: 'lst_sqlite_test', slug: 'old-slug' },
    to: { id: 'lst_sqlite_kept', slug: 'kept-slug' },
    reason: '#332 duplicate of kept-slug'
  }
  const rows = (operations: Record<string, unknown>[]) =>
    manifestSchema.parse({
      version: 1,
      id: 'duplicate-redirects',
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations
    })
  /** A second live listing, `kept-slug`, and the fixture listing unpublished: its duplicate. */
  const KEPT_AND_RETIRED = `
    INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
      VALUES ('lst_sqlite_kept','kept-slug','Kept','Description','https://kept.example','draft','${now}','test','fixture','${'d'.repeat(64)}');
    INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_kept',1,0,1);
    UPDATE listings SET status='approved' WHERE id='lst_sqlite_kept';
    UPDATE listings SET is_active=0 WHERE id='lst_sqlite_test';`
  const retired = () => {
    const db = database()
    db.exec(KEPT_AND_RETIRED)
    return db
  }
  const redirects = (db: DatabaseSync) =>
    db
      .prepare(
        'SELECT listing_id,old_slug,new_slug,manifest_id,reason,created_at FROM listing_slug_redirects ORDER BY id'
      )
      .all()
  const listings = (db: DatabaseSync) => db.prepare('SELECT * FROM listings ORDER BY id').all()
  const version = (db: DatabaseSync) =>
    db.prepare('SELECT version FROM publication_state WHERE id=1').get()
  const redirectRow = (listingId: string, oldSlug: string, newSlug: string) =>
    `INSERT INTO listing_slug_redirects (listing_id,old_slug,new_slug,manifest_id,reason,created_at)
      VALUES ('${listingId}','${oldSlug}','${newSlug}','prior','Prior','${now}');`

  it('adds one redirect row to the kept listing at any version, and changes neither listing', () => {
    const db = retired()
    db.prepare('UPDATE publication_state SET version=9').run()
    const before = listings(db)
    const publication = buildPublicationPlan(rows([redirect]), 'redirect manifest', now, {
      ...live,
      version: 9
    })
    executeInTestTransaction(db, publication)
    expect(redirects(db)).toEqual([
      {
        listing_id: 'lst_sqlite_kept',
        old_slug: 'old-slug',
        new_slug: 'kept-slug',
        manifest_id: 'duplicate-redirects',
        reason: '#332 duplicate of kept-slug',
        created_at: now
      }
    ])
    // The retired row stays unpublished, so Republish in /admin can still bring it back.
    expect(listings(db)).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
    // The epoch advances, so the cached 410 turns over.
    expect(version(db)).toEqual({ version: 10 })
    const routes = publication.affectedRoutes.split('\n')
    expect(routes).toEqual(
      expect.arrayContaining(['/products/old-slug/', '/search/', '/sitemap-index.xml', '/rss.xml'])
    )
    expect(routes).not.toContain('/products/kept-slug/')
  })

  it('makes the product page’s lookup answer the kept slug, through a rename; the retired listing stays out of the sitemap and search', async () => {
    const sqlite = new SqliteD1()
    seed(sqlite.database).exec(KEPT_AND_RETIRED)
    const binding = sqlite.asD1Database()
    const client = createDatabase(binding)
    // A fresh operations object per read, as each request gets.
    const catalog = () =>
      createCatalogOperations({
        cache: new MemoryCatalogCache(),
        client,
        clock: () => new Date('2026-07-14T00:00:00.000Z'),
        observe: () => undefined
      })
    const gone = () => isUnpublishedListingSlug({ client, slug: 'old-slug' })
    // Before: no redirect, so the Worker answers the gone page (410).
    expect(await catalog().getCanonicalSlugForRedirect('old-slug')).toBeNull()
    expect(await gone()).toBe(true)

    await executePublicationPlan(
      binding,
      buildPublicationPlan(rows([redirect]), 'redirect manifest', now, live)
    )
    // The product page finds no listing, then this redirect: `permanentRedirect`, a 308.
    const after = catalog()
    expect(await after.getListingBySlug('old-slug')).toBeNull()
    expect(await after.getCanonicalSlugForRedirect('old-slug')).toBe('kept-slug')
    expect((await after.getSitemapListings()).map(listing => listing.slug)).toEqual(['kept-slug'])
    expect((await after.searchListings('old')).map(listing => listing.slug)).toEqual([])
    expect((await after.searchListings('kept')).map(listing => listing.slug)).toEqual(['kept-slug'])

    // The kept listing renamed later: the redirect follows its id, still one hop.
    const state = sqlite.database
      .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
      .get() as { checksum: string; version: number }
    await executePublicationPlan(
      binding,
      buildPublicationPlan(
        manifestSchema.parse({
          version: 1,
          id: 'rename-kept',
          basePublicationVersion: state.version,
          provenance: {
            actor: 'test@example.com',
            workflow: 'test/sqlite',
            beforeChecksum: state.checksum
          },
          operations: [
            {
              action: 'listing-slug-change',
              id: 'lst_sqlite_kept',
              from: 'kept-slug',
              to: 'renamed-slug',
              categories: ['seo'],
              reason: 'Rename'
            }
          ]
        }),
        'rename manifest',
        now
      )
    )
    expect(await catalog().getCanonicalSlugForRedirect('old-slug')).toBe('renamed-slug')

    // The kept listing unpublished too: no redirect, and the retired slug is the gone page again.
    sqlite.database.exec("UPDATE listings SET is_active=0 WHERE id='lst_sqlite_kept'")
    expect(await catalog().getCanonicalSlugForRedirect('old-slug')).toBeNull()
    expect(await gone()).toBe(true)
  })

  it.each([
    ['the source is live', "UPDATE listings SET is_active=1 WHERE id='lst_sqlite_test'"],
    [
      'the source was never published',
      "UPDATE listings SET status='draft' WHERE id='lst_sqlite_test'"
    ],
    ['the source has another slug', "UPDATE listings SET slug='moved' WHERE id='lst_sqlite_test'"],
    [
      'the source is filed under a retired category (#260: it answers 404)',
      `INSERT INTO categories (id,slug,name,is_active) VALUES (2,'adult','Adult',0);
        INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
          VALUES ('lst_sqlite_test',2,1,0);`
    ],
    ['the target is unpublished', "UPDATE listings SET is_active=0 WHERE id='lst_sqlite_kept'"],
    [
      'the target is scheduled for later',
      "UPDATE listings SET published_at='2099-01-01T00:00:00.000Z' WHERE id='lst_sqlite_kept'"
    ],
    ['the target has another slug', "UPDATE listings SET slug='moved' WHERE id='lst_sqlite_kept'"],
    ['a redirect exists for the slug', redirectRow('lst_sqlite_kept', 'old-slug', 'kept-slug')],
    [
      'the target’s slug is itself redirected (a chain)',
      `INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
        VALUES ('lst_sqlite_third','third-slug','Third','Description','https://third.example','draft','${now}','test','fixture','${'e'.repeat(64)}');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_third',1,0,1);
      UPDATE listings SET status='approved' WHERE id='lst_sqlite_third';
      ${redirectRow('lst_sqlite_third', 'kept-slug', 'third-slug')}`
    ],
    [
      'the target’s slug redirects to the source (a loop)',
      redirectRow('lst_sqlite_test', 'kept-slug', 'old-slug')
    ],
    [
      'an older slug redirects to the source (a chain)',
      redirectRow('lst_sqlite_test', 'older-slug', 'old-slug')
    ]
  ])('refuses the whole batch when %s, and says why', (name, change) => {
    const db = retired()
    db.exec(change)
    const before = { listings: listings(db), redirects: redirects(db) }
    // Each guard names the operation and its reason in the error D1 reports.
    const reason = name.startsWith('the source ')
      ? 'the source is not this unpublished listing'
      : /^the target (is|has) /u.test(name)
        ? 'the target is not this live listing'
        : 'the slug already redirects, or this would make a chain or a loop'
    expect(() =>
      executeInTestTransaction(db, buildPublicationPlan(rows([redirect]), 'm', now, live))
    ).toThrow(`listing-slug-redirect old-slug to kept-slug: ${reason}`)
    expect({ listings: listings(db), redirects: redirects(db) }).toEqual(before)
    expect(version(db)).toEqual({ version: 4 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM publication_runs').get()).toEqual({ count: 0 })
  })

  /** The retired listing also filed under `retiring`, an active category nothing live is in. */
  const inRetiring = () => {
    const db = retired()
    db.exec(`INSERT INTO categories (id,slug,name) VALUES (2,'retiring','Retiring');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        VALUES ('lst_sqlite_test',2,1,0);`)
    return db
  }
  const categoryState = (db: DatabaseSync) =>
    db.prepare("SELECT is_active FROM categories WHERE slug='retiring'").get()
  const retire = { action: 'category-unpublish', slug: 'retiring' }

  it('refuses a batch that retires the source’s category after the redirect, or before it (#338 review)', () => {
    for (const [operations, reason] of [
      // The redirect first: `category-unpublish` refuses while a redirect's source is filed under
      // it (and the end-of-batch check would refuse too). Retired, the listing must answer 404.
      [
        [redirect, retire],
        'category-unpublish retiring: a listing filed under it is the source of a slug redirect; re-file that listing first'
      ],
      // The retirement first: the redirect's own guard refuses a source in a retired category.
      [
        [retire, redirect],
        'listing-slug-redirect old-slug to kept-slug: the source is not this unpublished listing, or is filed under a retired category'
      ]
    ] as const) {
      const db = inRetiring()
      expect(() =>
        executeInTestTransaction(db, buildPublicationPlan(rows([...operations]), 'm', now, live))
      ).toThrow(reason)
      expect(categoryState(db)).toEqual({ is_active: 1 })
      expect(redirects(db)).toEqual([])
      expect(version(db)).toEqual({ version: 4 })
    }
  })

  it('refuses retiring a category in a later manifest while a published redirect’s source is filed under it; re-filed first, it retires', () => {
    const db = inRetiring()
    executeInTestTransaction(db, buildPublicationPlan(rows([redirect]), 'redirect', now, live))
    const published = db
      .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
      .get() as { checksum: string; version: number }
    const later = (operations: Record<string, unknown>[]) =>
      buildPublicationPlan(
        manifestSchema.parse({
          version: 1,
          id: 'retire-later',
          concurrency: 'rows',
          provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
          operations
        }),
        'retire later',
        now,
        published
      )
    expect(() => executeInTestTransaction(db, later([retire]))).toThrow(
      're-file that listing first'
    )
    expect(categoryState(db)).toEqual({ is_active: 1 })
    // Re-filed off the category in the same batch, the listing keeps its redirect, and the
    // category retires.
    executeInTestTransaction(
      db,
      later([
        {
          action: 'listing-categories-remove',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          expected: ['seo', 'retiring'],
          remove: ['retiring']
        },
        retire
      ])
    )
    expect(categoryState(db)).toEqual({ is_active: 0 })
    expect(redirects(db)).toEqual([expect.objectContaining({ old_slug: 'old-slug' })])
    expect(version(db)).toEqual({ version: 6 })
  })

  it('refuses a batch that leaves the target not live by its end, in either order (#338 review)', () => {
    /** A `listing-update` of the kept listing, as a `publication` manifest may hold. */
    const update = (publishedAt: string) => ({
      action: 'listing-update',
      previousCategories: ['seo'],
      listing: {
        id: 'lst_sqlite_kept',
        slug: 'kept-slug',
        name: 'Kept',
        description: 'Description',
        website: 'https://kept.example',
        publishedAt,
        categories: ['seo']
      }
    })
    const later = '2099-01-01T00:00:00.000Z'
    for (const [operations, reason] of [
      // The update after the redirect: only the end-of-batch check sees it.
      [
        [redirect, update(later)],
        'listing-slug-redirect old-slug to kept-slug: by the end of the batch, its source is no longer unpublished outside retired categories, or its target is no longer live'
      ],
      [[update(later), redirect], 'the target is not this live listing']
    ] as const) {
      const db = retired()
      const before = listings(db)
      expect(() => executeInTestTransaction(db, plan({ operations: [...operations] }))).toThrow(
        reason
      )
      expect(listings(db)).toEqual(before)
      expect(redirects(db)).toEqual([])
      expect(version(db)).toEqual({ version: 4 })
    }
    // Still public by the end (an earlier date): the redirect stands.
    const db = retired()
    executeInTestTransaction(db, plan({ operations: [redirect, update('2026-05-16')] }))
    expect(redirects(db)).toEqual([expect.objectContaining({ listing_id: 'lst_sqlite_kept' })])
  })

  it('refuses a redirect to its own listing, a bad reason, a target the manifest unpublishes, and a second redirect of a slug', () => {
    expect(() => rows([{ ...redirect, to: { id: 'lst_sqlite_test', slug: 'kept-slug' } }])).toThrow(
      /own listing/u
    )
    expect(() => rows([{ ...redirect, to: { id: 'lst_sqlite_kept', slug: 'old-slug' } }])).toThrow(
      /own listing/u
    )
    for (const reason of [undefined, '  ', 'x'.repeat(201)]) {
      expect(() => rows([{ ...redirect, reason }]), String(reason)).toThrow()
    }
    expect(() =>
      rows([{ ...redirect, to: { ...redirect.to, website: 'https://kept.example' } }])
    ).toThrow()
    // Its own guard refuses a target unpublished earlier in the batch; this, one unpublished later.
    const unpublishKept = {
      action: 'listing-unpublish',
      id: 'lst_sqlite_kept',
      slug: 'kept-slug',
      categories: ['seo'],
      expected: { website: 'https://kept.example' }
    }
    for (const operations of [
      [redirect, unpublishKept],
      [unpublishKept, redirect]
    ]) {
      expect(() => rows(operations)).toThrow(/same manifest/u)
    }
    expect(() => rows([redirect, { ...redirect, reason: 'again' }])).toThrow(
      /Duplicate listing operation/u
    )
    // Two retired duplicates may share a kept listing.
    expect(() =>
      rows([redirect, { ...redirect, from: { id: 'lst_sqlite_other', slug: 'other-slug' } }])
    ).not.toThrow()
  })

  it('the committed follow-up sends exactly #337’s 14 retired slugs to their kept listings', () => {
    const read = (file: string) => {
      const source = readFileSync(resolve('d1/publications', file), 'utf8')
      return { manifest: parseManifest(source), source }
    }
    const duplicates = read('2026-10-10-duplicate-listings.yaml').manifest
    const { manifest, source } = read('2026-10-10-duplicate-listings-redirects.yaml')
    const retirements = duplicates.operations.flatMap(op =>
      op.action === 'listing-unpublish' ? [op] : []
    )
    const operations = manifest.operations.flatMap(op =>
      op.action === 'listing-slug-redirect' ? [op] : []
    )
    expect(manifest.concurrency).toBe('rows')
    expect(operations).toHaveLength(manifest.operations.length)
    expect(retirements).toHaveLength(14)
    expect(operations.map(op => op.from)).toEqual(
      retirements.map(op => ({ id: op.id, slug: op.slug }))
    )
    // Each goes to the listing #337's reason names as kept, by its v1 import id
    // (`lst_` + sha256("legacy-product-map" NUL <slug>)[0:24], docs/data-model.md).
    const importId = (value: string) =>
      `lst_${createHash('sha256').update(`legacy-product-map\0${value}`).digest('hex').slice(0, 24)}`
    for (const [index, op] of operations.entries()) {
      const kept = op.to.slug.replaceAll('.', '\\.')
      expect(retirements[index]?.reason, op.from.slug).toMatch(
        new RegExp(`^#332 duplicate of ${kept}[,:]`, 'u')
      )
      expect(op.to.id, op.to.slug).toBe(importId(op.to.slug))
    }
    // Where #337 gave a kept listing media, it named the same id and slug.
    for (const op of duplicates.operations) {
      if (op.action === 'listing-media-update')
        expect(operations.map(redirect => redirect.to)).toContainEqual({ id: op.id, slug: op.slug })
    }

    /** The 28 listings: kept ones live, retired ones live (`retiredActive` 1) or unpublished. */
    const environment = (retiredActive: 0 | 1) => {
      const db = database()
      const insert = db.prepare(
        `INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
          VALUES (?,?,?,'Description',?,'draft','2026-05-16','test',?,'c')`
      )
      const file = db.prepare(
        'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES (?,1,0,1)'
      )
      const publish = db.prepare("UPDATE listings SET status='approved',is_active=? WHERE id=?")
      for (const { from, to } of operations) {
        for (const [listing, active] of [
          [to, 1],
          [from, retiredActive]
        ] as const) {
          insert.run(
            listing.id,
            listing.slug,
            listing.slug,
            `https://${listing.slug}/`,
            listing.slug
          )
          file.run(listing.id)
          publish.run(active, listing.id)
        }
      }
      return db
    }
    // After #337's manifest: one redirect per retired slug, to its kept listing.
    const db = environment(0)
    executeInTestTransaction(db, buildPublicationPlan(manifest, source, now, live))
    expect(
      db
        .prepare(
          'SELECT r.old_slug AS retired, l.slug AS kept FROM listing_slug_redirects r JOIN listings l ON l.id=r.listing_id ORDER BY r.id'
        )
        .all()
    ).toEqual(operations.map(op => ({ retired: op.from.slug, kept: op.to.slug })))
    // Before it, the retired listings are live: the whole batch refuses, and says why.
    const early = environment(1)
    expect(() =>
      executeInTestTransaction(early, buildPublicationPlan(manifest, source, now, live))
    ).toThrow(
      'listing-slug-redirect facebook-downloader to facebook-video-downloader: the source is not this unpublished listing'
    )
    expect(redirects(early)).toEqual([])
    expect(version(early)).toEqual({ version: 4 })
  })
})
