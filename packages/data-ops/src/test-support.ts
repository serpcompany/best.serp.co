import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'
import type { CatalogDataCache } from './contracts'

export class MemoryCatalogCache implements CatalogDataCache {
  readonly ttlSeconds = new Map<string, number>()
  readonly values = new Map<string, unknown>()

  async get(key: string): Promise<unknown | null> {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.values.set(key, structuredClone(value))
    this.ttlSeconds.set(key, ttlSeconds)
  }
}

export interface RecordedStatement {
  bindings: unknown[]
  sql: string
}

export class SqliteD1 {
  readonly database: DatabaseSync
  readonly statements: RecordedStatement[] = []

  constructor(path = ':memory:', initializeCatalog = true) {
    this.database = new DatabaseSync(path)
    if (!initializeCatalog) return
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sites (id TEXT PRIMARY KEY);
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(site_id, slug)
      );
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        website TEXT NOT NULL,
        content TEXT,
        entity_type TEXT,
        priority TEXT,
        is_unofficial INTEGER NOT NULL DEFAULT 0,
        is_featured INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'approved',
        published_at TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(site_id, slug)
      );
      CREATE TABLE listing_categories (
        listing_id TEXT NOT NULL,
        category_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_primary INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(listing_id, category_id)
      );
      CREATE TABLE listing_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE listing_resource_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE listing_faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE listing_slug_redirects (
        site_id TEXT NOT NULL,
        old_slug TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        PRIMARY KEY(site_id, old_slug)
      );
      CREATE TABLE publication_state (
        site_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
      CREATE INDEX listings_slug_lookup_idx ON listings(site_id, slug);
      CREATE INDEX listings_publication_idx
        ON listings(site_id, status, is_active, published_at DESC, display_order, slug);
      CREATE INDEX listings_featured_idx
        ON listings(site_id, status, is_active, is_featured, published_at DESC, display_order);
      CREATE INDEX listings_related_name_idx
        ON listings(site_id, name, slug)
        WHERE status = 'approved' AND is_active = 1 AND published_at IS NOT NULL;
      CREATE INDEX listing_categories_category_idx
        ON listing_categories(category_id, listing_id);
      CREATE INDEX listing_categories_listing_order_idx
        ON listing_categories(listing_id, sort_order);
      CREATE INDEX listing_media_listing_idx ON listing_media(listing_id, sort_order);
      CREATE INDEX listing_resource_links_listing_idx
        ON listing_resource_links(listing_id, sort_order);
      CREATE INDEX categories_public_idx
        ON categories(site_id, is_active, sort_order, name);
    `)
  }

  asD1Database(): D1Database {
    const owner = this
    const binding = {
      prepare(sql: string) {
        let bindings: unknown[] = []
        const execute = <T>() => {
          owner.statements.push({ bindings, sql })
          const statement = owner.database.prepare(sql)
          const values = bindings as SQLInputValue[]
          let results: T[] = []
          if (statement.columns().length > 0) results = statement.all(...values) as T[]
          else statement.run(...values)
          return {
            results,
            success: true as const,
            meta: {
              duration: 0,
              rows_read: results.length,
              rows_written: 0
            }
          }
        }
        return {
          bind(...values: unknown[]) {
            bindings = values
            return this
          },
          async all<T>() {
            return execute<T>()
          },
          async first<T>() {
            return execute<T>().results[0] ?? null
          },
          async run<T>() {
            return execute<T>()
          }
        } as unknown as D1PreparedStatement
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        owner.database.exec('BEGIN')
        try {
          const results: D1Result<T>[] = []
          for (const statement of statements) results.push(await statement.run<T>())
          owner.database.exec('COMMIT')
          return results
        } catch (error) {
          owner.database.exec('ROLLBACK')
          throw error
        }
      }
    }
    return binding as unknown as D1Database
  }
}

function insertSite(database: DatabaseSync, siteId: ActiveCheckedInSiteId): void {
  database.prepare('INSERT INTO sites(id) VALUES (?)').run(siteId)
  database.prepare('INSERT INTO publication_state(site_id, version) VALUES (?, 1)').run(siteId)
  for (const [index, slug] of ['primary', 'secondary', 'empty'].entries()) {
    database
      .prepare(
        'INSERT INTO categories(site_id, slug, name, description, sort_order) VALUES (?, ?, ?, ?, ?)'
      )
      .run(siteId, slug, `${slug} ${siteId}`, `${slug} description`, index)
  }
}

export function seedContractFixture(sqlite: SqliteD1): void {
  const { database } = sqlite
  for (const siteId of ['pornvideodownloaders.com', 'serp.software'] as const) {
    insertSite(database, siteId)
    const categoryRows = database
      .prepare('SELECT id, slug FROM categories WHERE site_id = ? ORDER BY sort_order')
      .all(siteId) as Array<{ id: number; slug: string }>
    const categoryIds = new Map(categoryRows.map(row => [row.slug, row.id]))
    const prefix = siteId === 'serp.software' ? 'serp' : 'pvd'
    const listings = [
      { slug: 'alpha', published: '2026-07-05T00:00:00.000Z', order: 0, featured: 1 },
      { slug: 'bravo', published: '2026-07-04T00:00:00.000Z', order: 0, featured: 1 },
      { slug: 'charlie', published: '2026-07-04T00:00:00.000Z', order: 1, featured: 0 },
      { slug: 'delta', published: '2026-07-04T00:00:00.000Z', order: 1, featured: 0 },
      { slug: 'echo', published: '2026-07-03T00:00:00.000Z', order: 0, featured: 0 },
      { slug: 'future', published: '2027-01-01T00:00:00.000Z', order: 0, featured: 1 }
    ]
    for (const [index, listing] of listings.entries()) {
      const id = `${prefix}-${listing.slug}`
      database
        .prepare(
          `INSERT INTO listings(
            id, site_id, slug, name, description, website, content, entity_type, priority,
            is_unofficial, is_featured, published_at, display_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'software', 'high', ?, ?, ?, ?)`
        )
        .run(
          id,
          siteId,
          listing.slug,
          `${listing.slug} ${siteId}`,
          `${listing.slug} description`,
          `https://${listing.slug}.${siteId}`,
          `${listing.slug} detail content`,
          index === 3 ? 1 : 0,
          listing.featured,
          listing.published,
          listing.order
        )
      const primaryId = categoryIds.get('primary')
      if (!primaryId) throw new Error('Missing primary category fixture.')
      database
        .prepare(
          'INSERT INTO listing_categories(listing_id, category_id, sort_order, is_primary) VALUES (?, ?, 0, 1)'
        )
        .run(id, primaryId)
      if (index % 2 === 0) {
        const secondaryId = categoryIds.get('secondary')
        if (!secondaryId) throw new Error('Missing secondary category fixture.')
        database
          .prepare(
            'INSERT INTO listing_categories(listing_id, category_id, sort_order, is_primary) VALUES (?, ?, 1, 0)'
          )
          .run(id, secondaryId)
      }
      database
        .prepare(
          "INSERT INTO listing_media(listing_id, kind, url, sort_order) VALUES (?, 'logo', ?, 0)"
        )
        .run(id, `https://assets.example/${id}-logo.png`)
      database
        .prepare(
          "INSERT INTO listing_media(listing_id, kind, url, sort_order) VALUES (?, 'image', ?, 1)"
        )
        .run(id, `https://assets.example/${id}-image.png`)
      database
        .prepare(
          'INSERT INTO listing_resource_links(listing_id, label, url, sort_order) VALUES (?, ?, ?, 0)'
        )
        .run(id, 'Documentation', `https://docs.example/${id}`)
      database
        .prepare(
          'INSERT INTO listing_faqs(listing_id, question, answer, sort_order) VALUES (?, ?, ?, 0)'
        )
        .run(id, `Question for ${id}`, `Answer for ${id}`)
    }
    database
      .prepare('INSERT INTO listing_slug_redirects(site_id, old_slug, listing_id) VALUES (?, ?, ?)')
      .run(siteId, 'old-bravo', `${prefix}-bravo`)
  }
}
