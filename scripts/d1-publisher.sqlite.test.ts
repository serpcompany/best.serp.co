import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hasFileExtension } from '../apps/web/src/lib/seo/canonical-url'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, manifestSchema, type PublicationPlan } from './d1-publisher.ts'
import { project } from './project'

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
        rows({ operations: [mediaUpdate(), { action: 'category-unpublish', slug: 'seo' }] })
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
