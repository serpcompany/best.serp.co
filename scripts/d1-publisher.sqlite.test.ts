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
import { d1CompatViolations } from './d1-compat'
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
    // The site's own pages under /products/ are reserved (#341).
    for (const to of ['categories', 'tags']) {
      expect(() => manifestSchema.parse(rename('old-slug', to)), to).toThrow(/categories or tags/u)
    }
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

describe('listing-details-set in a row-level manifest (#340: a renamed product)', () => {
  const live = { checksum: beforeChecksum, version: 4 }
  const rows = (operations: Record<string, unknown>[]) =>
    manifestSchema.parse({
      version: 1,
      id: 'renamed',
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations
    })
  const current = { name: 'Old', description: 'Description', website: 'https://example.com' }
  const set = (details: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    action: 'listing-details-set',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    reason: 'Old is now New',
    expected: current,
    details,
    ...extra
  })
  const websiteTaken =
    'listing-details-set old-slug: the new website belongs to another listing or a submission in flight, or is blocked'
  const renamed = {
    name: 'New',
    description: 'What New does.',
    website: 'https://www.new.example/product/'
  }
  const details = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT slug,name,description,website,status,is_active,checksum,updated_at FROM listings WHERE id='lst_sqlite_test'"
      )
      .get() as Record<string, unknown>
  const publish = (db: DatabaseSync, operations: Record<string, unknown>[]) =>
    executeInTestTransaction(db, buildPublicationPlan(rows(operations), 'renamed', now, live))
  /** Asserts the batch was refused whole: the listing, the version, and the log as before. */
  const expectRefused = (db: DatabaseSync, before: Record<string, unknown>) => {
    expect(details(db)).toEqual(before)
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 4
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({ count: 0 })
  }

  it('replaces the name, description, and website, and logs the edit', () => {
    const db = database()
    const before = details(db)
    db.prepare('UPDATE publication_state SET version=9').run()
    const publication = buildPublicationPlan(rows([set(renamed)]), 'renamed', now, {
      ...live,
      version: 9
    })
    expect(
      publication.statements.flatMap(item => item.bindings).filter(b => typeof b === 'boolean')
    ).toEqual([])
    executeInTestTransaction(db, publication)
    // Published as before, with a new checksum (a stale admin edit is refused) and lastmod.
    const after = details(db)
    expect(after).toMatchObject({
      ...renamed,
      slug: 'old-slug',
      status: 'approved',
      is_active: 1,
      updated_at: now
    })
    expect(after.checksum).not.toBe(before.checksum)
    expect(
      db.prepare('SELECT listing_id,event_type,detail,actor FROM listing_events').all()
    ).toEqual([
      {
        listing_id: 'lst_sqlite_test',
        event_type: 'edited',
        detail: JSON.stringify({
          fields: ['name', 'description', 'website'],
          manifest: 'renamed',
          reason: 'Old is now New'
        }),
        actor: 'test@example.com'
      }
    ])
    // The listing keeps its categories, and the catalog epoch turns over.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_categories WHERE listing_id='lst_sqlite_test'"
        )
        .get()
    ).toEqual({ count: 1 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 10
    })
    expect(publication.affectedRoutes.split('\n')).toContain('/products/old-slug/')
    // Applied once: the listing no longer has the expected details, so it is refused.
    expect(() =>
      executeInTestTransaction(
        db,
        buildPublicationPlan(rows([set(renamed)]), 'again', now, {
          checksum: publication.afterChecksum,
          version: 10
        })
      )
    ).toThrow()
    expect(details(db)).toEqual(after)
  })

  it('changes only the fields it names (#340: a one-line description fix)', () => {
    const db = database()
    publish(db, [set({ description: 'Fixed.' })])
    expect(details(db)).toMatchObject({ ...current, description: 'Fixed.' })
    expect(db.prepare('SELECT detail FROM listing_events').get()).toEqual({
      detail: JSON.stringify({
        fields: ['description'],
        manifest: 'renamed',
        reason: 'Old is now New'
      })
    })
  })

  it('refuses the whole batch when the listing changed since generation', () => {
    for (const changed of [
      { expected: { ...current, name: 'Older' } },
      { expected: { ...current, description: 'Edited by an admin' } },
      { expected: { ...current, website: 'https://example.com/' } },
      { slug: 'new-slug' },
      { id: 'lst_sqlite_missing' }
    ]) {
      const db = database()
      const before = details(db)
      // Each refusal names the operation and its reason in the error D1 reports (#338's guards).
      expect(() => publish(db, [set(renamed, changed)]), JSON.stringify(changed)).toThrow(
        `listing-details-set ${'slug' in changed ? changed.slug : 'old-slug'}: the listing is not approved, or its slug, name, description, or website changed since the manifest`
      )
      expectRefused(db, before)
    }
  })

  it.each([
    ["another listing's website", "'https://new.example/product?ref=x'", 'other.example'],
    ['a listing whose slug is the new host', "'https://other.example'", 'new.example']
  ])('refuses a website that is %s', (_name, website, slug) => {
    const db = database()
    db.exec(`INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
      VALUES ('lst_sqlite_other','${slug}','Other','Description',${website},'draft','${now}','test','fixture','${'d'.repeat(64)}');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_other',1,0,1);`)
    const before = details(db)
    expect(() => publish(db, [set(renamed)])).toThrow(websiteTaken)
    expectRefused(db, before)
    // The name and description alone still change.
    publish(db, [set({ name: 'New' })])
    expect(details(db)).toMatchObject({ ...current, name: 'New' })
  })

  it('refuses a website a submission in flight or a block covers, and accepts it after', () => {
    const db = database()
    db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,logo_url,status,plan)
      VALUES ('sub_new','new.example','New','d','https://new.example/','c','seo','l','verified','free')`)
    const before = details(db)
    expect(() => publish(db, [set(renamed)])).toThrow(websiteTaken)
    expectRefused(db, before)
    db.exec(`UPDATE listing_submissions SET status='rejected', rejection_reason='No',
        rejection_category='prohibited' WHERE id='sub_new';
      INSERT INTO listing_submission_url_blocks (url_key,covers_subdomains,submission_id,reason,blocked_by,blocked_at)
        VALUES ('new.example',1,'sub_new','No','admin','${now}')`)
    expect(() => publish(db, [set(renamed)])).toThrow(websiteTaken)
    expectRefused(db, before)
    db.exec(`UPDATE listing_submission_url_blocks SET lifted_at='${now}', lifted_by='admin'`)
    publish(db, [set(renamed)])
    expect(details(db)).toMatchObject(renamed)
  })

  it.each(['paid_pending_review', 'changes_requested'])(
    'refuses a listing whose own submission is %s',
    status => {
      const db = database()
      db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,
        category_slug,logo_url,status,plan,paid_at,listing_id,published_checksum)
      VALUES ('sub','example.com','Old','d','https://example.com/','c','seo','l',
        '${status}','paid','${now}','lst_sqlite_test',
        (SELECT checksum FROM listings WHERE id='lst_sqlite_test'))`)
      const before = details(db)
      expect(() => publish(db, [set(renamed)])).toThrow(
        'listing-details-set old-slug: its own submission is in review'
      )
      expectRefused(db, before)
    }
  )

  it('refuses a listing whose own submission was rejected, which stays down and read-only', () => {
    const db = database()
    // A live rejection unpublishes the listing and leaves its row approved (submission-plans.ts).
    db.exec(`UPDATE listings SET is_active=0 WHERE id='lst_sqlite_test';
      INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,
        logo_url,status,plan,paid_at,listing_id,rejection_reason,rejection_category)
      VALUES ('sub','example.com','Old','d','https://example.com/','c','seo','l','rejected',
        'paid','${now}','lst_sqlite_test','No','prohibited')`)
    const before = details(db)
    for (const change of [renamed, { description: 'Fixed.' }]) {
      expect(() => publish(db, [set(change)]), JSON.stringify(change)).toThrow(
        'listing-details-set old-slug: its own submission was rejected'
      )
      expectRefused(db, before)
    }
  })

  it.each(['draft', 'review', 'rejected'])('refuses a listing in %s', status => {
    const db = database()
    db.exec(`UPDATE listings SET status='${status}' WHERE id='lst_sqlite_test'`)
    const before = details(db)
    expect(() => publish(db, [set(renamed)])).toThrow(
      /listing-details-set old-slug: the listing is not approved/u
    )
    expectRefused(db, before)
  })

  it('renames an unpublished listing and leaves it unpublished', () => {
    const db = database()
    db.exec("UPDATE listings SET is_active=0 WHERE id='lst_sqlite_test'")
    publish(db, [set(renamed)])
    expect(details(db)).toMatchObject({ ...renamed, status: 'approved', is_active: 0 })
  })

  it('stores the website trimmed, as the admin edit does, so exact website matches find it', () => {
    const db = database()
    const padded = { ...renamed, website: ` ${renamed.website}\n` }
    expect(rows([set(padded)]).operations[0]).toMatchObject({ details: renamed })
    publish(db, [set(padded)])
    expect(details(db)).toMatchObject(renamed)
  })

  it('refuses details that change nothing, a non-public website, and over-long copy', () => {
    expect(() => rows([set({})])).toThrow(/only the fields that change/u)
    expect(() => rows([set({ name: 'Old' })])).toThrow(/only the fields that change/u)
    expect(() => rows([set({ name: 'New', website: current.website })])).toThrow(
      /only the fields that change/u
    )
    for (const website of ['http://localhost:3000/', 'http://10.0.0.1/', 'ftp://new.example/'])
      expect(() => rows([set({ website })]), website).toThrow(/public HTTP\(S\) URL/u)
    expect(() => rows([set({ name: 'N'.repeat(81) })])).toThrow()
    expect(() => rows([set({ description: 'D'.repeat(161) })])).toThrow()
    expect(() => rows([set({ name: '  ' })])).toThrow()
    expect(() => rows([set(renamed, { reason: undefined })])).toThrow()
    // Trimmed like the admin panel's edit; a listing is named once per manifest.
    expect(rows([set({ name: '  New  ' })]).operations[0]).toMatchObject({
      details: { name: 'New' }
    })
    expect(() => rows([set(renamed), set({ name: 'Newer' })])).toThrow(/Duplicate listing/u)
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

  it('with expected.website, clears only once the listing has it (#340: after the renames)', () => {
    const website = 'https://www.new.example/'
    const ordered = { ...clear, expected: { website } }
    const rename = {
      action: 'listing-details-set',
      id: 'lst_sqlite_test',
      slug: 'old-slug',
      reason: 'the product moved',
      expected: { name: 'Old', description: 'Description', website: 'https://example.com' },
      details: { website }
    }
    const db = database()
    const sync = () => {
      live = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as typeof live
    }
    live = { checksum: beforeChecksum, version: 4 }
    executeInTestTransaction(db, rowsPlan([add]))
    // Dispatched before the rename: refused whole, with the reason bound like every guard's.
    sync()
    expect(() => executeInTestTransaction(db, rowsPlan([ordered], 5))).toThrow(
      `listing-claim-hold-clear old-slug: its website is not ${website} yet; publish the manifest that sets it first`
    )
    expect(holds(db)).toEqual([expect.objectContaining({ cleared_at: null, cleared_by: null })])
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 5 })
    // After the rename sets the website, the same clear applies.
    executeInTestTransaction(db, rowsPlan([rename], 5))
    sync()
    executeInTestTransaction(db, rowsPlan([ordered], 6))
    expect(holds(db)).toEqual([expect.objectContaining({ cleared_at: now })])
    // Without the field, the operation plans as it did before #340: no website guard.
    expect(rowsPlan([clear]).statements.some(item => item.query.includes('website=?'))).toBe(false)
    expect(rowsPlan([ordered]).statements.some(item => item.query.includes('website=?'))).toBe(true)
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

describe('taxonomy operations in a row-level manifest (#344, #341 design 4.1)', () => {
  type Operation = Record<string, unknown>
  let sequence = 0
  const rows = (operations: Operation[], id = 'taxonomy') =>
    manifestSchema.parse({
      version: 1,
      id,
      concurrency: 'rows',
      provenance: { actor: 'test@example.com', workflow: 'test/sqlite' },
      operations
    })
  /** Plans `operations` as a row-level manifest against the database's live publication state. */
  const planFor = (db: DatabaseSync, operations: Operation[]) => {
    sequence += 1
    const state = db.prepare('SELECT version,checksum FROM publication_state WHERE id=1').get() as {
      checksum: string
      version: number
    }
    return buildPublicationPlan(
      rows(operations, `taxonomy-${sequence}`),
      `taxonomy ${sequence}`,
      now,
      state
    )
  }
  const publish = (db: DatabaseSync, operations: Operation[]) => {
    const publication = planFor(db, operations)
    executeInTestTransaction(db, publication)
    return publication
  }
  /**
   * The fixture listing (`old-slug`, under `seo`) and a second live listing (`other-product`),
   * with a taxonomy: hubs `seo` and `writing`, an empty hub, and a retired hub; active tags
   * `ai-writing` and `ai-seo`; `old-tag`, retired under `writing` but still on `other-product`;
   * `stale-tag`, retired under the retired hub; an active best page `ai-seo-tools` on `ai-seo`,
   * and a retired one, `old-best`. Retired rows are written active first, then retired, as the
   * triggers require.
   */
  const seeded = () => {
    const db = database()
    db.exec(`
      INSERT INTO categories (id,slug,name) VALUES (2,'writing','Writing'),(3,'retired-hub','Retired hub'),(4,'empty-hub','Empty hub');
      INSERT INTO tags (id,slug,name,description,category_id,sort_order) VALUES
        (1,'ai-writing','AI Writing','Words.',2,0),
        (2,'ai-seo','AI SEO','',1,1),
        (3,'old-tag','Old tag','',2,2),
        (4,'stale-tag','Stale tag','',3,0);
      INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
        VALUES ('lst_sqlite_other','other-product','Other product','Description','https://other.example','draft','${now}','test','fixture','${'d'.repeat(64)}');
      INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_sqlite_other',1,0,1);
      UPDATE listings SET status='approved' WHERE id='lst_sqlite_other';
      INSERT INTO listing_tags (listing_id,tag_id,sort_order) VALUES ('lst_sqlite_other',3,0),('lst_sqlite_other',1,1);
      UPDATE tags SET is_active=0 WHERE slug IN ('old-tag','stale-tag');
      UPDATE categories SET is_active=0 WHERE slug='retired-hub';
      INSERT INTO best_pages (id,slug,keyword,title,heading,intro,tag_id) VALUES
        (1,'ai-seo-tools','ai seo tools','Best AI SEO Tools','Best AI SEO Tools','The intro.',2),
        (2,'old-best','old best','Best Old','Best Old','Old intro.',1);
      UPDATE best_pages SET is_active=0 WHERE slug='old-best';
    `)
    return db
  }
  /** Everything a taxonomy operation may write, so a refusal can be shown to write nothing. */
  const snapshot = (db: DatabaseSync) => ({
    bestPageListings: db.prepare('SELECT * FROM best_page_listings ORDER BY 1, 2').all(),
    bestPages: db.prepare('SELECT * FROM best_pages ORDER BY id').all(),
    events: db.prepare('SELECT * FROM listing_events ORDER BY id').all(),
    listingTags: db.prepare('SELECT * FROM listing_tags ORDER BY 1, 2').all(),
    listings: db
      .prepare('SELECT id,slug,status,is_active,checksum,updated_at FROM listings ORDER BY id')
      .all(),
    redirects: db.prepare('SELECT * FROM taxonomy_redirects ORDER BY 1, 2').all(),
    runs: db.prepare('SELECT * FROM publication_runs ORDER BY id').all(),
    state: db.prepare('SELECT * FROM publication_state').all(),
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all()
  })
  /** Asserts the batch is refused with exactly `reason`, writing nothing. */
  const refuses = (db: DatabaseSync, operations: Operation[], reason: string) => {
    const before = snapshot(db)
    expect(() => publish(db, operations), reason).toThrow(`bad JSON path: '${reason}'`)
    expect(snapshot(db)).toEqual(before)
  }
  const tagOf = (db: DatabaseSync, slug: string) =>
    db
      .prepare(
        'SELECT t.name,t.description,c.slug AS category,t.sort_order,t.is_active,t.updated_at FROM tags t JOIN categories c ON c.id=t.category_id WHERE t.slug=?'
      )
      .get(slug)
  const listingTags = (db: DatabaseSync, id = 'lst_sqlite_test') =>
    db
      .prepare(
        'SELECT t.slug,lt.sort_order FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.listing_id=? ORDER BY lt.sort_order'
      )
      .all(id)
  /** Every redirect as `source -> target`, the target named by kind and slug. */
  const redirects = (db: DatabaseSync) =>
    (
      db
        .prepare(
          `SELECT r.source_kind||' '||r.source_slug||' -> '||r.target_kind||COALESCE(' '||c.slug,' '||t.slug,' '||b.slug,'') AS redirect, r.manifest_id
           FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id
           LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id
           ORDER BY r.source_kind, r.source_slug`
        )
        .all() as Array<{ manifest_id: string; redirect: string }>
    ).map(row => row.redirect)
  const booleanBindings = (publication: PublicationPlan) =>
    publication.statements.flatMap(item => item.bindings).filter(b => typeof b === 'boolean')
  const tagCreate = (tag: Record<string, unknown>) => ({ action: 'tag-create', tag })
  const tagsSet = (expected: string[], tags: string[], extra: Operation = {}) => ({
    action: 'listing-tags-set',
    id: 'lst_sqlite_test',
    slug: 'old-slug',
    expected,
    tags,
    ...extra
  })
  const redirectSet = (from: Operation, expected: Operation | null, to: Operation) => ({
    action: 'taxonomy-redirect-set',
    from,
    expected,
    to
  })
  const seoTools = {
    keyword: 'ai seo tools',
    title: 'Best AI SEO Tools',
    heading: 'Best AI SEO Tools',
    intro: 'The intro.',
    tag: 'ai-seo',
    category: null,
    listSize: 10,
    keywordVolume: null,
    keywordCheckedAt: null,
    order: 0
  }
  const pin = (id: string, slug: string, blurb?: string) => ({
    id,
    slug,
    ...(blurb ? { blurb } : {})
  })
  const test = pin('lst_sqlite_test', 'old-slug')
  const other = pin('lst_sqlite_other', 'other-product')
  const pins = (db: DatabaseSync, slug = 'ai-seo-tools') =>
    db
      .prepare(
        `SELECT l.slug,bpl.position,bpl.excluded,bpl.blurb FROM best_page_listings bpl
         JOIN best_pages b ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id
         WHERE b.slug=? ORDER BY bpl.excluded, bpl.position, l.slug`
      )
      .all(slug)

  describe('tag-create', () => {
    it('adds an active tag under its hub, at any version, binding no boolean', () => {
      const db = seeded()
      db.prepare('UPDATE publication_state SET version=11').run()
      const publication = publish(db, [
        tagCreate({
          slug: 'ai-copywriting',
          name: 'AI Copywriting',
          description: 'Ads.',
          category: 'writing',
          order: 3
        }),
        // A tag may share a category's slug: the URLs differ (design 1.5).
        tagCreate({ slug: 'seo', name: 'SEO', category: 'seo' })
      ])
      expect(booleanBindings(publication)).toEqual([])
      expect(tagOf(db, 'ai-copywriting')).toEqual({
        category: 'writing',
        description: 'Ads.',
        is_active: 1,
        name: 'AI Copywriting',
        sort_order: 3,
        updated_at: now
      })
      expect(tagOf(db, 'seo')).toMatchObject({ description: '', sort_order: 0, is_active: 1 })
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 12 })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/products/tags/',
          '/products/tags/ai-copywriting/',
          '/products/tags/seo/',
          '/products/categories/writing/',
          '/products/categories/seo/',
          '/sitemap-tags.xml',
          '/sitemap-best.xml',
          '/sitemap-categories.xml'
        ])
      )
    })

    it('refuses a slug a tag has, active or retired', () => {
      for (const slug of ['ai-writing', 'old-tag']) {
        refuses(
          seeded(),
          [tagCreate({ slug, name: 'Again', category: 'writing' })],
          `tag-create ${slug}: a tag has this slug, active or retired`
        )
      }
    })

    it('refuses a missing or retired hub', () => {
      for (const category of ['nope', 'retired-hub']) {
        refuses(
          seeded(),
          [tagCreate({ slug: 'new-tag', name: 'New', category })],
          `tag-create new-tag: the category ${category} is missing or retired`
        )
      }
    })
  })

  describe('tag-update', () => {
    const update = (slug: string, expected: Operation, tag: Operation) => ({
      action: 'tag-update',
      slug,
      expected,
      tag
    })
    const aiWriting = { name: 'AI Writing', description: 'Words.', category: 'writing' }

    it('renames a tag, moves it to another hub, and keeps it active', () => {
      const db = seeded()
      const publication = publish(db, [
        update('ai-writing', aiWriting, {
          name: 'AI Writing Tools',
          description: 'More words.',
          category: 'seo',
          order: 7
        })
      ])
      expect(tagOf(db, 'ai-writing')).toEqual({
        category: 'seo',
        description: 'More words.',
        is_active: 1,
        name: 'AI Writing Tools',
        sort_order: 7,
        updated_at: now
      })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/products/tags/ai-writing/',
          '/products/categories/writing/',
          '/products/categories/seo/'
        ])
      )
    })

    it('edits a retired tag with a plain UPDATE and leaves it retired', () => {
      // An upsert would fire the BEFORE INSERT trigger and be refused (#354 review).
      const db = seeded()
      publish(db, [
        update(
          'old-tag',
          { name: 'Old tag', description: '', category: 'writing' },
          { name: 'Older tag', description: 'Gone.', category: 'seo', order: 2 }
        )
      ])
      expect(tagOf(db, 'old-tag')).toMatchObject({
        category: 'seo',
        is_active: 0,
        name: 'Older tag'
      })
      // Its membership stays.
      expect(listingTags(db, 'lst_sqlite_other')).toEqual([
        { slug: 'old-tag', sort_order: 0 },
        { slug: 'ai-writing', sort_order: 1 }
      ])
    })

    it('refuses a tag that is missing or not as expected', () => {
      for (const [slug, expected] of [
        ['nope', aiWriting],
        ['ai-writing', { ...aiWriting, name: 'Renamed since' }],
        ['ai-writing', { ...aiWriting, description: 'Edited since.' }],
        ['ai-writing', { ...aiWriting, category: 'seo' }]
      ] as const) {
        refuses(
          seeded(),
          [update(slug, expected, { ...aiWriting, name: 'New name', order: 0 })],
          `tag-update ${slug}: the tag is missing or not as expected`
        )
      }
    })

    it('refuses a missing or retired hub, also for a retired tag that keeps its retired hub', () => {
      for (const category of ['nope', 'retired-hub']) {
        refuses(
          seeded(),
          [update('ai-writing', aiWriting, { ...aiWriting, category, order: 0 })],
          `tag-update ai-writing: the category ${category} is missing or retired`
        )
      }
      // The triggers allow this rename (a retired tag, its hub unchanged); the publisher doesn't.
      const stale = { name: 'Stale tag', description: '', category: 'retired-hub' }
      refuses(
        seeded(),
        [update('stale-tag', stale, { ...stale, name: 'Renamed', order: 0 })],
        'tag-update stale-tag: the category retired-hub is missing or retired'
      )
    })
  })

  describe('tag-unpublish', () => {
    const unpublish = (slug: string, redirect: Operation) => ({
      action: 'tag-unpublish',
      slug,
      redirect
    })

    it('retires a tag, keeps its memberships, and redirects its URL and every redirect aimed at it', () => {
      const db = seeded()
      publish(db, [
        // Old category and best page URLs already sent to the tag.
        redirectSet({ kind: 'category', slug: 'ai-content' }, null, {
          kind: 'tag',
          slug: 'ai-writing'
        }),
        redirectSet({ kind: 'best', slug: 'ai-writer' }, null, { kind: 'tag', slug: 'ai-writing' }),
        // A redirect from the new target's own URL to the tag would point at itself: removed.
        redirectSet({ kind: 'tag', slug: 'ai-seo' }, null, { kind: 'tag', slug: 'ai-writing' })
      ])
      db.exec("UPDATE best_pages SET is_active=0 WHERE slug='ai-seo-tools'")
      const publication = publish(db, [unpublish('ai-writing', { kind: 'tag', slug: 'ai-seo' })])
      expect(tagOf(db, 'ai-writing')).toMatchObject({ is_active: 0, updated_at: now })
      expect(listingTags(db, 'lst_sqlite_other')).toEqual([
        { slug: 'old-tag', sort_order: 0 },
        { slug: 'ai-writing', sort_order: 1 }
      ])
      expect(redirects(db)).toEqual([
        'best ai-writer -> tag ai-seo',
        'category ai-content -> tag ai-seo',
        'tag ai-writing -> tag ai-seo'
      ])
      expect(db.prepare('SELECT DISTINCT manifest_id FROM taxonomy_redirects').all()).toEqual([
        { manifest_id: publication.manifest.id }
      ])
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining(['/products/tags/ai-writing/', '/products/tags/ai-seo/'])
      )
      expect(booleanBindings(publication)).toEqual([])
    })

    it('replaces a redirect pre-staged for its own URL', () => {
      const db = seeded()
      publish(db, [redirectSet({ kind: 'tag', slug: 'ai-writing' }, null, { kind: 'directory' })])
      publish(db, [unpublish('ai-writing', { kind: 'category', slug: 'writing' })])
      expect(redirects(db)).toEqual(['tag ai-writing -> category writing'])
    })

    it('refuses a target whose own URL redirects elsewhere: a chain', () => {
      const db = seeded()
      publish(db, [redirectSet({ kind: 'tag', slug: 'ai-seo' }, null, { kind: 'directory' })])
      refuses(
        db,
        [unpublish('ai-writing', { kind: 'tag', slug: 'ai-seo' })],
        'tag-unpublish ai-writing: the redirect target itself redirects elsewhere; this would make a chain'
      )
    })

    it('redirects to the directory, a category, or a best page', () => {
      for (const [redirect, expected] of [
        [{ kind: 'directory' }, 'tag ai-writing -> directory'],
        [{ kind: 'category', slug: 'writing' }, 'tag ai-writing -> category writing'],
        [{ kind: 'best', slug: 'ai-seo-tools' }, 'tag ai-writing -> best ai-seo-tools']
      ] as const) {
        const db = seeded()
        publish(db, [unpublish('ai-writing', redirect)])
        expect(redirects(db)).toEqual([expected])
      }
    })

    it('refuses while an active best page uses the tag; a retired one does not count', () => {
      const db = seeded()
      refuses(
        db,
        [unpublish('ai-seo', { kind: 'directory' })],
        'tag-unpublish ai-seo: an active best page uses the tag'
      )
      // `old-best` uses `ai-writing`, but it is retired.
      publish(db, [unpublish('ai-writing', { kind: 'directory' })])
      expect(tagOf(db, 'ai-writing')).toMatchObject({ is_active: 0 })
    })

    it('refuses a missing or retired target', () => {
      for (const [kind, slug] of [
        ['tag', 'nope'],
        ['tag', 'old-tag'],
        ['category', 'retired-hub'],
        ['best', 'old-best']
      ]) {
        refuses(
          seeded(),
          [unpublish('ai-writing', { kind, slug })],
          `tag-unpublish ai-writing: the redirect target ${kind === 'best' ? 'best page' : kind} ${slug} is missing or retired`
        )
      }
    })

    it('refuses a missing or already retired tag, and a redirect to itself', () => {
      for (const slug of ['nope', 'old-tag']) {
        refuses(
          seeded(),
          [unpublish(slug, { kind: 'directory' })],
          `tag-unpublish ${slug}: no active tag has this slug`
        )
      }
      expect(() => rows([unpublish('ai-writing', { kind: 'tag', slug: 'ai-writing' })])).toThrow(
        /cannot redirect to itself/u
      )
    })
  })

  describe('listing-tags-set', () => {
    it('sets a listing’s tags in order without changing its checksum, and logs the edit', () => {
      const db = seeded()
      const before = db.prepare("SELECT checksum FROM listings WHERE id='lst_sqlite_test'").get()
      db.prepare('UPDATE publication_state SET version=20').run()
      const publication = publish(db, [tagsSet([], ['ai-writing', 'ai-seo'])])
      expect(booleanBindings(publication)).toEqual([])
      expect(listingTags(db)).toEqual([
        { slug: 'ai-writing', sort_order: 0 },
        { slug: 'ai-seo', sort_order: 1 }
      ])
      expect(
        db.prepare("SELECT checksum,updated_at FROM listings WHERE id='lst_sqlite_test'").get()
      ).toEqual({ ...before, updated_at: now })
      expect(
        db.prepare('SELECT listing_id,event_type,detail,actor FROM listing_events').all()
      ).toEqual([
        {
          listing_id: 'lst_sqlite_test',
          event_type: 'edited',
          detail: JSON.stringify({
            fields: ['tags'],
            manifest: publication.manifest.id,
            from: [],
            to: ['ai-writing', 'ai-seo']
          }),
          actor: 'test@example.com'
        }
      ])
      expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 21 })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/products/old-slug/',
          '/products/tags/',
          '/products/tags/ai-writing/',
          '/products/tags/ai-seo/'
        ])
      )
      // Replaced again, compared on the order just written; and emptied.
      publish(db, [tagsSet(['ai-writing', 'ai-seo'], ['ai-seo'])])
      expect(listingTags(db)).toEqual([{ slug: 'ai-seo', sort_order: 0 }])
      publish(db, [tagsSet(['ai-seo'], [])])
      expect(listingTags(db)).toEqual([])
    })

    it('drops a retired tag’s membership, which expected names, and refuses keeping it', () => {
      const db = seeded()
      refuses(
        db,
        [
          tagsSet(['old-tag', 'ai-writing'], ['ai-writing', 'old-tag'], {
            id: 'lst_sqlite_other',
            slug: 'other-product'
          })
        ],
        'listing-tags-set other-product: the tag old-tag is missing or retired'
      )
      publish(db, [
        tagsSet(['old-tag', 'ai-writing'], ['ai-writing'], {
          id: 'lst_sqlite_other',
          slug: 'other-product'
        })
      ])
      expect(listingTags(db, 'lst_sqlite_other')).toEqual([{ slug: 'ai-writing', sort_order: 0 }])
    })

    it('tags an unpublished listing, and one whose paid submission is in review', () => {
      const db = seeded()
      db.exec("UPDATE listings SET is_active=0 WHERE id='lst_sqlite_test'")
      publish(db, [tagsSet([], ['ai-seo'])])
      expect(listingTags(db)).toEqual([{ slug: 'ai-seo', sort_order: 0 }])
      // The checksum stays, so that paid submission can still be approved (design 4.1).
      db.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,
        category_slug,logo_url,status,plan,paid_at,listing_id,published_checksum)
      VALUES ('sub','other.example','Other','d','https://other.example/','c','seo','l',
        'paid_pending_review','paid','${now}','lst_sqlite_other',
        (SELECT checksum FROM listings WHERE id='lst_sqlite_other'))`)
      publish(db, [
        tagsSet(['old-tag', 'ai-writing'], ['ai-seo'], {
          id: 'lst_sqlite_other',
          slug: 'other-product'
        })
      ])
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM listings l JOIN listing_submissions s ON s.listing_id=l.id WHERE s.id='sub' AND l.checksum=s.published_checksum"
          )
          .get()
      ).toEqual({ count: 1 })
    })

    it('refuses tags that changed since generation, in content or order', () => {
      const db = seeded()
      for (const expected of [['ai-writing'], ['ai-writing', 'old-tag'], ['old-tag']]) {
        refuses(
          db,
          [tagsSet(expected, ['ai-seo'], { id: 'lst_sqlite_other', slug: 'other-product' })],
          'listing-tags-set other-product: its tags are not the expected ones'
        )
      }
      // Another listing's change in the same batch is rolled back with it.
      refuses(
        db,
        [
          tagsSet([], ['ai-seo']),
          tagsSet(['ai-writing'], ['ai-seo'], { id: 'lst_sqlite_other', slug: 'other-product' })
        ],
        'listing-tags-set other-product: its tags are not the expected ones'
      )
    })

    it('refuses a listing that is renamed, missing, or not approved', () => {
      refuses(
        seeded(),
        [tagsSet([], ['ai-seo'], { slug: 'new-slug' })],
        'listing-tags-set new-slug: no approved listing has this id and slug'
      )
      refuses(
        seeded(),
        [tagsSet([], ['ai-seo'], { id: 'lst_sqlite_missing' })],
        'listing-tags-set old-slug: no approved listing has this id and slug'
      )
      for (const status of ['review', 'rejected']) {
        const db = seeded()
        db.exec(`UPDATE listings SET status='${status}' WHERE id='lst_sqlite_test'`)
        refuses(
          db,
          [tagsSet([], ['ai-seo'])],
          'listing-tags-set old-slug: no approved listing has this id and slug'
        )
      }
    })

    it('refuses a missing or retired tag', () => {
      for (const tags of [['nope'], ['ai-seo', 'old-tag'], ['ai-seo', 'stale-tag']]) {
        refuses(
          seeded(),
          [tagsSet([], tags)],
          `listing-tags-set old-slug: the tag ${tags.at(-1)} is missing or retired`
        )
      }
    })

    it('refuses no change and duplicates, and sits beside a categories operation', () => {
      expect(() => rows([tagsSet(['ai-seo'], ['ai-seo'])])).toThrow(
        /already has exactly these tags/u
      )
      expect(() => rows([tagsSet([], ['ai-seo', 'ai-seo'])])).toThrow(/Duplicate listing tag/u)
      expect(() => rows([tagsSet([], ['ai-seo']), tagsSet([], ['ai-writing'])])).toThrow(
        /Duplicate listing-tags-set listing/u
      )
      // The migration moves a listing's tags and categories in one manifest (design 4.2).
      const db = seeded()
      db.exec("INSERT INTO categories (id,slug,name) VALUES (5,'marketing','Marketing')")
      publish(db, [
        tagsSet([], ['ai-seo']),
        {
          action: 'listing-categories-set',
          id: 'lst_sqlite_test',
          slug: 'old-slug',
          expected: ['seo'],
          categories: ['marketing']
        }
      ])
      expect(listingTags(db)).toEqual([{ slug: 'ai-seo', sort_order: 0 }])
    })
  })

  describe('best-page-create', () => {
    const create = (page: Operation) => ({ action: 'best-page-create', page })
    const page = {
      slug: 'ai-writing-assistant',
      keyword: 'ai writing assistant',
      title: 'Best AI Writing Assistants',
      heading: 'Best AI Writing Assistants',
      intro: 'Tools that draft and edit.'
    }
    const bestOf = (db: DatabaseSync, slug: string) =>
      db
        .prepare(
          `SELECT b.keyword,b.title,b.heading,b.intro,t.slug AS tag,c.slug AS category,b.list_size,
             b.keyword_volume,b.keyword_checked_at,b.sort_order,b.is_active,b.created_at,b.updated_at
           FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c ON c.id=b.category_id
           WHERE b.slug=?`
        )
        .get(slug)

    it('creates a page on a tag, a category, or both, with its defaults', () => {
      const db = seeded()
      const publication = publish(db, [
        create({ ...page, tag: 'ai-writing' }),
        create({
          ...page,
          slug: 'seo-software',
          category: 'seo',
          listSize: 25,
          keywordVolume: 5400,
          keywordCheckedAt: '2026-10-10T08:00:00.000Z',
          order: 4
        }),
        create({ ...page, slug: 'ai-seo-writing', tag: 'ai-writing', category: 'seo' })
      ])
      expect(booleanBindings(publication)).toEqual([])
      expect(bestOf(db, 'ai-writing-assistant')).toEqual({
        category: null,
        created_at: now,
        heading: 'Best AI Writing Assistants',
        intro: 'Tools that draft and edit.',
        is_active: 1,
        keyword: 'ai writing assistant',
        keyword_checked_at: null,
        keyword_volume: null,
        list_size: 10,
        sort_order: 0,
        tag: 'ai-writing',
        title: 'Best AI Writing Assistants',
        updated_at: now
      })
      expect(bestOf(db, 'seo-software')).toMatchObject({
        category: 'seo',
        keyword_checked_at: '2026-10-10T08:00:00.000Z',
        keyword_volume: 5400,
        list_size: 25,
        sort_order: 4,
        tag: null
      })
      expect(bestOf(db, 'ai-seo-writing')).toMatchObject({ category: 'seo', tag: 'ai-writing' })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/best/',
          '/best/ai-writing-assistant/',
          '/best/seo-software/',
          '/products/tags/ai-writing/',
          '/products/categories/seo/',
          '/sitemap-best.xml'
        ])
      )
    })

    it('refuses a slug a best page has, active or retired', () => {
      for (const slug of ['ai-seo-tools', 'old-best']) {
        refuses(
          seeded(),
          [create({ ...page, slug, tag: 'ai-writing' })],
          `best-page-create ${slug}: a best page has this slug, active or retired`
        )
      }
    })

    it('refuses a missing or retired tag or category', () => {
      for (const [field, value, kind] of [
        ['tag', 'nope', 'tag'],
        ['tag', 'old-tag', 'tag'],
        ['category', 'nope', 'category'],
        ['category', 'retired-hub', 'category']
      ]) {
        refuses(
          seeded(),
          [create({ ...page, tag: 'ai-writing', category: 'seo', [field as string]: value })],
          `best-page-create ai-writing-assistant: the ${kind} ${value} is missing or retired`
        )
      }
    })

    it('refuses a page without a pool, a list size out of range, and a loose instant', () => {
      expect(() => rows([create(page)])).toThrow(/needs a tag, a category, or both/u)
      for (const listSize of [4, 26]) {
        expect(() => rows([create({ ...page, tag: 'ai-seo', listSize })])).toThrow()
      }
      for (const keywordCheckedAt of [
        '2026-10-10T08:00:00Z',
        '2026-10-10',
        '2026-02-30T00:00:00.000Z'
      ]) {
        expect(() => rows([create({ ...page, tag: 'ai-seo', keywordCheckedAt })])).toThrow()
      }
      expect(() => rows([create({ ...page, tag: 'ai-seo', title: '   ' })])).toThrow(/blank/u)
      expect(() =>
        rows([create({ ...page, tag: 'ai-seo' }), create({ ...page, tag: 'ai-writing' })])
      ).toThrow(/Duplicate best page operation target/u)
    })
  })

  describe('best-page-update', () => {
    const update = (expected: Operation, page: Operation) => ({
      action: 'best-page-update',
      slug: 'ai-seo-tools',
      expected,
      page
    })
    const changed = {
      keyword: 'best seo ai',
      title: 'Best SEO AI',
      heading: 'The best SEO AI',
      intro: 'A new intro.',
      tag: null,
      category: 'seo',
      listSize: 15,
      keywordVolume: 900,
      keywordCheckedAt: '2026-10-09T00:00:00.000Z',
      order: 2
    }

    it('rewrites every field but the slug, and back', () => {
      const db = seeded()
      const publication = publish(db, [update(seoTools, changed)])
      expect(booleanBindings(publication)).toEqual([])
      expect(
        db
          .prepare(
            `SELECT b.keyword,b.title,b.heading,b.intro,b.tag_id,c.slug AS category,b.list_size,
               b.keyword_volume,b.keyword_checked_at,b.sort_order,b.is_active,b.updated_at
             FROM best_pages b LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug='ai-seo-tools'`
          )
          .get()
      ).toEqual({
        category: 'seo',
        heading: 'The best SEO AI',
        intro: 'A new intro.',
        is_active: 1,
        keyword: 'best seo ai',
        keyword_checked_at: '2026-10-09T00:00:00.000Z',
        keyword_volume: 900,
        list_size: 15,
        sort_order: 2,
        tag_id: null,
        title: 'Best SEO AI',
        updated_at: now
      })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/best/ai-seo-tools/',
          '/products/tags/ai-seo/',
          '/products/categories/seo/'
        ])
      )
      publish(db, [update(changed, seoTools)])
      expect(
        db
          .prepare("SELECT keyword,tag_id,category_id FROM best_pages WHERE slug='ai-seo-tools'")
          .get()
      ).toEqual({ keyword: 'ai seo tools', tag_id: 2, category_id: null })
    })

    it('refuses a page that is missing or differs from expected in any field', () => {
      refuses(
        seeded(),
        [{ ...update(seoTools, changed), slug: 'nope' }],
        'best-page-update nope: the best page is missing or not as expected'
      )
      const stale: Record<string, unknown> = {
        keyword: 'other',
        title: 'Other',
        heading: 'Other',
        intro: 'Other.',
        tag: 'ai-writing',
        category: 'seo',
        listSize: 11,
        keywordVolume: 1,
        keywordCheckedAt: '2026-01-01T00:00:00.000Z',
        order: 9
      }
      for (const [field, value] of Object.entries(stale)) {
        refuses(
          seeded(),
          [update({ ...seoTools, [field]: value }, changed)],
          'best-page-update ai-seo-tools: the best page is missing or not as expected'
        )
      }
    })

    it('refuses a missing or retired tag or category', () => {
      for (const [field, value] of [
        ['tag', 'old-tag'],
        ['category', 'retired-hub'],
        ['category', 'nope']
      ]) {
        refuses(
          seeded(),
          [update(seoTools, { ...changed, [field]: value })],
          `best-page-update ai-seo-tools: the ${field} ${value} is missing or retired`
        )
      }
    })

    it('refuses no change and a page without a pool', () => {
      expect(() => rows([update(seoTools, seoTools)])).toThrow(/already has exactly these values/u)
      expect(() => rows([update(seoTools, { ...seoTools, tag: null })])).toThrow(
        /needs a tag, a category, or both/u
      )
    })
  })

  describe('best-page-listings-set', () => {
    const set = (expected: Operation, next: Operation, slug = 'ai-seo-tools') => ({
      action: 'best-page-listings-set',
      slug,
      expected,
      ...next
    })
    const none = { pins: [], exclude: [] }

    it('pins listings in order with blurbs and excludes others, then replaces them', () => {
      const db = seeded()
      const first = { pins: [pin(other.id, other.slug, 'The pick.'), test], exclude: [] }
      const publication = publish(db, [set(none, first)])
      expect(booleanBindings(publication)).toEqual([])
      expect(pins(db)).toEqual([
        { blurb: 'The pick.', excluded: 0, position: 1, slug: 'other-product' },
        { blurb: null, excluded: 0, position: 2, slug: 'old-slug' }
      ])
      expect(
        db.prepare("SELECT updated_at FROM best_pages WHERE slug='ai-seo-tools'").get()
      ).toEqual({ updated_at: now })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining(['/best/', '/best/ai-seo-tools/'])
      )
      const second = { pins: [test], exclude: [other] }
      publish(db, [set(first, second)])
      expect(pins(db)).toEqual([
        { blurb: null, excluded: 0, position: 1, slug: 'old-slug' },
        { blurb: null, excluded: 1, position: null, slug: 'other-product' }
      ])
      // And emptied.
      publish(db, [set(second, none)])
      expect(pins(db)).toEqual([])
    })

    it('refuses pins and exclusions that changed since generation', () => {
      const db = seeded()
      const reason =
        'best-page-listings-set ai-seo-tools: its pins and exclusions are not the expected ones'
      const ordered = { pins: [pin(test.id, test.slug, 'Why.'), other], exclude: [] }
      publish(db, [set(none, ordered)])
      for (const expected of [
        none,
        // Another order, or another blurb.
        { pins: [other, pin(test.id, test.slug, 'Why.')], exclude: [] },
        { pins: [test, other], exclude: [] },
        { pins: [pin(test.id, test.slug, 'Why.')], exclude: [other] }
      ]) {
        refuses(db, [set(expected, { pins: [], exclude: [test] })], reason)
      }
      // The same pins, other exclusions.
      const excluded = { pins: [pin(test.id, test.slug, 'Why.')], exclude: [other] }
      publish(db, [set(ordered, excluded)])
      refuses(
        db,
        [set({ pins: excluded.pins, exclude: [] }, { pins: [], exclude: [test] })],
        reason
      )
    })

    it('refuses a missing page', () => {
      refuses(
        seeded(),
        [set(none, { pins: [test], exclude: [] }, 'nope')],
        'best-page-listings-set nope: no best page has this slug'
      )
    })

    it('refuses a pin or exclusion that is renamed, missing, or not approved', () => {
      for (const next of [
        { pins: [pin(test.id, 'renamed')], exclude: [] },
        { pins: [], exclude: [pin(test.id, 'renamed')] }
      ]) {
        refuses(
          seeded(),
          [set(none, next)],
          `best-page-listings-set ai-seo-tools: no approved listing is renamed (${test.id})`
        )
      }
      refuses(
        seeded(),
        [set(none, { pins: [pin('lst_sqlite_missing', 'gone')], exclude: [] })],
        'best-page-listings-set ai-seo-tools: no approved listing is gone (lst_sqlite_missing)'
      )
      for (const status of ['review', 'rejected']) {
        for (const next of [
          { pins: [other, test], exclude: [] },
          { pins: [other], exclude: [test] }
        ]) {
          const db = seeded()
          db.exec(`UPDATE listings SET status='${status}' WHERE id='lst_sqlite_test'`)
          refuses(
            db,
            [set(none, next)],
            `best-page-listings-set ai-seo-tools: no approved listing is old-slug (${test.id})`
          )
        }
      }
    })

    it('refuses a listing pinned and excluded, named twice, too many pins, or no change', () => {
      expect(() => rows([set(none, { pins: [test], exclude: [test] })])).toThrow(
        /pinned or excluded twice/u
      )
      expect(() => rows([set(none, { pins: [test, test], exclude: [] })])).toThrow(
        /pinned or excluded twice/u
      )
      expect(() =>
        rows([set({ pins: [test], exclude: [test] }, { pins: [], exclude: [] })])
      ).toThrow(/pinned or excluded twice/u)
      const many = Array.from({ length: 26 }, (_, index) =>
        pin(`lst_sqlite_pin_${index}`, `pin-${index}`)
      )
      expect(() => rows([set(none, { pins: many, exclude: [] })])).toThrow()
      expect(() => rows([set(none, none)])).toThrow(/already has exactly these pins/u)
      // Created and pinned in one manifest, as the first set is (design 4.2).
      expect(() =>
        rows([
          {
            action: 'best-page-create',
            page: { ...seoTools, slug: 'new-best' }
          },
          set(none, { pins: [test], exclude: [] }, 'new-best')
        ])
      ).not.toThrow()
    })
  })

  describe('best-page-unpublish', () => {
    const unpublish = (slug: string, redirect: Operation) => ({
      action: 'best-page-unpublish',
      slug,
      redirect
    })

    it('retires a page, keeps its pins, and redirects its URL and every redirect aimed at it', () => {
      const db = seeded()
      publish(db, [
        redirectSet({ kind: 'category', slug: 'ai-seo' }, null, {
          kind: 'best',
          slug: 'ai-seo-tools'
        }),
        {
          action: 'best-page-listings-set',
          slug: 'ai-seo-tools',
          expected: { pins: [], exclude: [] },
          pins: [test],
          exclude: []
        }
      ])
      const publication = publish(db, [unpublish('ai-seo-tools', { kind: 'tag', slug: 'ai-seo' })])
      expect(booleanBindings(publication)).toEqual([])
      expect(
        db.prepare("SELECT is_active,updated_at FROM best_pages WHERE slug='ai-seo-tools'").get()
      ).toEqual({ is_active: 0, updated_at: now })
      expect(pins(db)).toHaveLength(1)
      expect(redirects(db)).toEqual([
        'best ai-seo-tools -> tag ai-seo',
        'category ai-seo -> tag ai-seo'
      ])
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining(['/best/', '/best/ai-seo-tools/', '/products/tags/ai-seo/'])
      )
      // With the page retired, its tag can retire too.
      publish(db, [{ action: 'tag-unpublish', slug: 'ai-seo', redirect: { kind: 'directory' } }])
      expect(redirects(db)).toEqual([
        'best ai-seo-tools -> directory',
        'category ai-seo -> directory',
        'tag ai-seo -> directory'
      ])
    })

    it('refuses a target whose own URL redirects elsewhere: a chain', () => {
      const db = seeded()
      publish(db, [
        redirectSet({ kind: 'tag', slug: 'ai-seo' }, null, { kind: 'category', slug: 'writing' })
      ])
      refuses(
        db,
        [unpublish('ai-seo-tools', { kind: 'tag', slug: 'ai-seo' })],
        'best-page-unpublish ai-seo-tools: the redirect target itself redirects elsewhere; this would make a chain'
      )
    })

    it('refuses a missing or retired target, a missing or retired page, and itself', () => {
      for (const [kind, slug] of [
        ['best', 'old-best'],
        ['tag', 'old-tag'],
        ['category', 'nope']
      ]) {
        refuses(
          seeded(),
          [unpublish('ai-seo-tools', { kind, slug })],
          `best-page-unpublish ai-seo-tools: the redirect target ${kind === 'best' ? 'best page' : kind} ${slug} is missing or retired`
        )
      }
      for (const slug of ['nope', 'old-best']) {
        refuses(
          seeded(),
          [unpublish(slug, { kind: 'directory' })],
          `best-page-unpublish ${slug}: no active best page has this slug`
        )
      }
      expect(() =>
        rows([unpublish('ai-seo-tools', { kind: 'best', slug: 'ai-seo-tools' })])
      ).toThrow(/cannot redirect to itself/u)
    })
  })

  describe('taxonomy-redirect-set', () => {
    it('adds a redirect, re-points it, and sends it to the directory, from any source kind', () => {
      const db = seeded()
      const publication = publish(db, [
        // A category that still renders: its page wins until it empties (design 2.2).
        redirectSet({ kind: 'category', slug: 'seo' }, null, {
          kind: 'best',
          slug: 'ai-seo-tools'
        }),
        redirectSet({ kind: 'tag', slug: 'gone-tag' }, null, { kind: 'category', slug: 'writing' }),
        redirectSet({ kind: 'best', slug: 'gone-best' }, null, { kind: 'directory' })
      ])
      expect(booleanBindings(publication)).toEqual([])
      expect(redirects(db)).toEqual([
        'best gone-best -> directory',
        'category seo -> best ai-seo-tools',
        'tag gone-tag -> category writing'
      ])
      expect(
        db
          .prepare(
            "SELECT target_category_id,target_tag_id,target_best_page_id,manifest_id,created_at FROM taxonomy_redirects WHERE source_slug='gone-best'"
          )
          .get()
      ).toEqual({
        created_at: now,
        manifest_id: publication.manifest.id,
        target_best_page_id: null,
        target_category_id: null,
        target_tag_id: null
      })
      expect(publication.affectedRoutes.split('\n')).toEqual(
        expect.arrayContaining([
          '/products/categories/seo/',
          '/best/ai-seo-tools/',
          '/products/tags/gone-tag/',
          '/products/categories/writing/',
          '/best/gone-best/',
          '/products/'
        ])
      )
      const repoint = publish(db, [
        redirectSet(
          { kind: 'category', slug: 'seo' },
          { kind: 'best', slug: 'ai-seo-tools' },
          { kind: 'tag', slug: 'ai-writing' }
        ),
        redirectSet(
          { kind: 'best', slug: 'gone-best' },
          { kind: 'directory' },
          {
            kind: 'best',
            slug: 'ai-seo-tools'
          }
        )
      ])
      expect(redirects(db)).toEqual([
        'best gone-best -> best ai-seo-tools',
        'category seo -> tag ai-writing',
        'tag gone-tag -> category writing'
      ])
      expect(
        db.prepare("SELECT manifest_id FROM taxonomy_redirects WHERE source_slug='seo'").get()
      ).toEqual({ manifest_id: repoint.manifest.id })
    })

    it('refuses a current target other than expected', () => {
      const db = seeded()
      publish(db, [redirectSet({ kind: 'category', slug: 'old' }, null, { kind: 'directory' })])
      for (const [from, expected] of [
        [{ kind: 'category', slug: 'old' }, null],
        [
          { kind: 'category', slug: 'old' },
          { kind: 'tag', slug: 'ai-writing' }
        ],
        [{ kind: 'tag', slug: 'old' }, { kind: 'directory' }],
        [{ kind: 'category', slug: 'new' }, { kind: 'directory' }]
      ] as const) {
        refuses(
          db,
          [redirectSet(from, expected, { kind: 'best', slug: 'ai-seo-tools' })],
          `taxonomy-redirect-set ${from.kind} ${from.slug}: its current target is not the expected one`
        )
      }
    })

    it('refuses a missing or retired target', () => {
      for (const [kind, slug] of [
        ['category', 'retired-hub'],
        ['category', 'nope'],
        ['tag', 'old-tag'],
        ['tag', 'nope'],
        ['best', 'old-best'],
        ['best', 'nope']
      ]) {
        refuses(
          seeded(),
          [redirectSet({ kind: 'category', slug: 'old' }, null, { kind, slug })],
          `taxonomy-redirect-set category old: the redirect target ${kind === 'best' ? 'best page' : kind} ${slug} is missing or retired`
        )
      }
    })

    it('refuses a chain or a loop, in either order within a batch', () => {
      const chain = (from: { kind: string; slug: string }) =>
        `taxonomy-redirect-set ${from.kind} ${from.slug}: this would make a chain: the target redirects too, or a redirect already ends at this URL`
      const db = seeded()
      publish(db, [
        redirectSet({ kind: 'tag', slug: 'ai-writing' }, null, { kind: 'directory' }),
        redirectSet({ kind: 'category', slug: 'empty-hub' }, null, {
          kind: 'best',
          slug: 'ai-seo-tools'
        })
      ])
      // To a URL that redirects.
      const elsewhere = { kind: 'category', slug: 'elsewhere' }
      refuses(
        db,
        [redirectSet(elsewhere, null, { kind: 'tag', slug: 'ai-writing' })],
        chain(elsewhere)
      )
      // From a URL a redirect ends at, to the directory too.
      const bestPage = { kind: 'best', slug: 'ai-seo-tools' }
      for (const to of [{ kind: 'directory' }, { kind: 'tag', slug: 'ai-seo' }])
        refuses(db, [redirectSet(bestPage, null, to)], chain(bestPage))
      // A loop back to the category that redirects here.
      refuses(
        db,
        [redirectSet(bestPage, null, { kind: 'category', slug: 'empty-hub' })],
        chain(bestPage)
      )
      // Within one batch, whichever comes first.
      const source = { kind: 'category', slug: 'old' }
      const tag = { kind: 'tag', slug: 'ai-seo' }
      refuses(
        seeded(),
        [redirectSet(source, null, tag), redirectSet(tag, null, { kind: 'directory' })],
        chain(tag)
      )
      refuses(
        seeded(),
        [redirectSet(tag, null, { kind: 'directory' }), redirectSet(source, null, tag)],
        chain(source)
      )
    })

    it('refuses a redirect to itself, one that changes nothing, and a source written twice', () => {
      const from = { kind: 'tag', slug: 'ai-seo' }
      expect(() => rows([redirectSet(from, null, from)])).toThrow(/cannot redirect to itself/u)
      expect(() => rows([redirectSet(from, { kind: 'directory' }, { kind: 'directory' })])).toThrow(
        /already points there/u
      )
      expect(() =>
        rows([
          redirectSet(from, null, { kind: 'directory' }),
          redirectSet(from, { kind: 'directory' }, { kind: 'category', slug: 'seo' })
        ])
      ).toThrow(/Duplicate taxonomy redirect source/u)
      // A retirement writes its own URL's redirect.
      expect(() =>
        rows([
          { action: 'tag-unpublish', slug: 'ai-seo', redirect: { kind: 'directory' } },
          redirectSet(from, null, { kind: 'directory' })
        ])
      ).toThrow(/Duplicate taxonomy redirect source/u)
      // The same slug under another kind is another URL.
      expect(() =>
        rows([
          redirectSet(from, null, { kind: 'directory' }),
          redirectSet({ kind: 'category', slug: 'ai-seo' }, null, { kind: 'directory' })
        ])
      ).not.toThrow()
    })
  })

  describe('the end of the batch (#338 review’s ordering gap)', () => {
    const retireEmptyHub = { action: 'category-unpublish', slug: 'empty-hub' }

    it('refuses a redirect whose target a later operation retires', () => {
      const toHub = redirectSet({ kind: 'category', slug: 'old' }, null, {
        kind: 'category',
        slug: 'empty-hub'
      })
      refuses(
        seeded(),
        [toHub, retireEmptyHub],
        'taxonomy-redirect-set category old: by the end of the batch, its redirect is gone or its target is retired'
      )
      // In the other order, the target guard refuses it.
      refuses(
        seeded(),
        [retireEmptyHub, toHub],
        'taxonomy-redirect-set category old: the redirect target category empty-hub is missing or retired'
      )
      // A tag's retirement re-points its redirects in the batch, so it never leaves one behind.
      const db = seeded()
      publish(db, [
        redirectSet({ kind: 'category', slug: 'old' }, null, { kind: 'tag', slug: 'ai-writing' }),
        {
          action: 'tag-unpublish',
          slug: 'ai-writing',
          redirect: { kind: 'category', slug: 'writing' }
        }
      ])
      expect(redirects(db)).toEqual([
        'category old -> category writing',
        'tag ai-writing -> category writing'
      ])
    })

    it('refuses a retirement redirect whose target a later operation retires', () => {
      refuses(
        seeded(),
        [
          {
            action: 'tag-unpublish',
            slug: 'ai-writing',
            redirect: { kind: 'category', slug: 'empty-hub' }
          },
          retireEmptyHub
        ],
        'tag-unpublish ai-writing: by the end of the batch, its redirect is gone or its target is retired'
      )
    })

    it('refuses a best page whose category a later operation retires', () => {
      refuses(
        seeded(),
        [
          {
            action: 'best-page-create',
            page: { ...seoTools, slug: 'hub-best', tag: null, category: 'empty-hub' }
          },
          retireEmptyHub
        ],
        'best-page-create hub-best: by the end of the batch, its tag or category is retired'
      )
      refuses(
        seeded(),
        [
          {
            action: 'best-page-update',
            slug: 'ai-seo-tools',
            expected: seoTools,
            page: { ...seoTools, category: 'empty-hub' }
          },
          retireEmptyHub
        ],
        'best-page-update ai-seo-tools: by the end of the batch, its tag or category is retired'
      )
    })

    it('lets a retired best page keep a category a later operation retires', () => {
      const db = seeded()
      const oldBest = {
        ...seoTools,
        keyword: 'old best',
        title: 'Best Old',
        heading: 'Best Old',
        intro: 'Old intro.',
        tag: 'ai-writing'
      }
      publish(db, [
        {
          action: 'best-page-update',
          slug: 'old-best',
          expected: oldBest,
          page: { ...oldBest, category: 'empty-hub' }
        },
        retireEmptyHub
      ])
      expect(
        db
          .prepare(
            `SELECT b.is_active, c.slug AS category, c.is_active AS category_active
             FROM best_pages b JOIN categories c ON c.id=b.category_id WHERE b.slug='old-best'`
          )
          .get()
      ).toEqual({ category: 'empty-hub', category_active: 0, is_active: 0 })
    })

    it('refuses a batch whose retirement removes a redirect it wrote', () => {
      // Retiring `ai-writing` would re-point the new `ai-seo` redirect at `ai-seo` itself, so it
      // removes that redirect, and the batch is refused.
      refuses(
        seeded(),
        [
          redirectSet({ kind: 'tag', slug: 'ai-seo' }, null, { kind: 'tag', slug: 'ai-writing' }),
          { action: 'tag-unpublish', slug: 'ai-writing', redirect: { kind: 'tag', slug: 'ai-seo' } }
        ],
        'taxonomy-redirect-set tag ai-seo: by the end of the batch, its redirect is gone or its target is retired'
      )
    })
  })

  it('plans every taxonomy operation in one row-level manifest D1 accepts, binding no boolean', () => {
    const db = seeded()
    db.exec(`INSERT INTO best_pages (slug,keyword,title,heading,intro,category_id)
      VALUES ('writing-tools','writing tools','Best Writing Tools','Best Writing Tools','Intro.',2)`)
    const writingTools = {
      ...seoTools,
      keyword: 'writing tools',
      title: 'Best Writing Tools',
      heading: 'Best Writing Tools',
      intro: 'Intro.',
      tag: null,
      category: 'writing'
    }
    const publication = publish(db, [
      tagCreate({ slug: 'ai-copywriting', name: 'AI Copywriting', category: 'writing' }),
      {
        action: 'tag-update',
        slug: 'ai-writing',
        expected: { name: 'AI Writing', description: 'Words.', category: 'writing' },
        tag: { name: 'AI Writers', description: 'Words.', category: 'writing', order: 1 }
      },
      tagsSet([], ['ai-copywriting', 'ai-writing']),
      {
        action: 'best-page-create',
        page: { ...seoTools, slug: 'ai-copywriter', tag: 'ai-copywriting' }
      },
      {
        action: 'best-page-update',
        slug: 'writing-tools',
        expected: writingTools,
        page: { ...writingTools, listSize: 12 }
      },
      {
        action: 'best-page-listings-set',
        slug: 'ai-copywriter',
        expected: { pins: [], exclude: [] },
        pins: [test],
        exclude: [other]
      },
      {
        action: 'best-page-unpublish',
        slug: 'ai-seo-tools',
        redirect: { kind: 'tag', slug: 'ai-seo' }
      },
      {
        action: 'tag-unpublish',
        slug: 'ai-seo',
        redirect: { kind: 'best', slug: 'ai-copywriter' }
      },
      redirectSet({ kind: 'category', slug: 'ai-content' }, null, {
        kind: 'best',
        slug: 'ai-copywriter'
      })
    ])
    expect(booleanBindings(publication)).toEqual([])
    for (const item of publication.statements) {
      expect(d1CompatViolations(item.query), item.query).toEqual([])
    }
    expect(redirects(db)).toEqual([
      'best ai-seo-tools -> best ai-copywriter',
      'category ai-content -> best ai-copywriter',
      'tag ai-seo -> best ai-copywriter'
    ])
    // A manifest without a taxonomy operation records the routes it always did.
    const plain = buildPublicationPlan(
      rows([{ action: 'category-unpublish', slug: 'empty-hub' }]),
      'plain',
      now,
      { checksum: beforeChecksum, version: 4 }
    )
    expect(plain.affectedRoutes).not.toMatch(/sitemap-(?:tags|best)/u)
    expect(publication.affectedRoutes.split('\n')).toEqual(
      expect.arrayContaining(['/sitemap-tags.xml', '/sitemap-best.xml'])
    )
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
