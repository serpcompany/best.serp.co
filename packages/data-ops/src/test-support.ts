import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { CatalogDataCache } from './contracts'
import { assertD1StatementLimits } from './sql-limits'

const MIGRATIONS_DIRECTORY = resolve(import.meta.dirname, '../../../d1/drizzle')

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

/**
 * Apply the checked-in D1 migrations in order, statement by statement, exactly as
 * Drizzle/Wrangler do, so tests exercise the real STRICT tables, indexes, seeds, and
 * primary-category triggers instead of a hand-maintained copy.
 */
export function applyMigrations(database: DatabaseSync): void {
  const names = readdirSync(MIGRATIONS_DIRECTORY)
    .filter(name => name.endsWith('.sql'))
    .sort()
  for (const name of names) {
    const statements = readFileSync(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')
      .split('--> statement-breakpoint')
      .map(statement => statement.trim())
      .filter(Boolean)
    for (const statement of statements) database.exec(statement)
  }
}

export interface RecordedStatement {
  bindings: unknown[]
  sql: string
}

export { findSelfComparison } from './sql-limits'

export class SqliteD1 {
  readonly database: DatabaseSync
  readonly statements: RecordedStatement[] = []

  constructor(path = ':memory:') {
    this.database = new DatabaseSync(path)
    applyMigrations(this.database)
  }

  asD1Database(): D1Database {
    const owner = this
    const binding = {
      prepare(sql: string) {
        // Every data-ops and app test that runs SQL through this binding gets the D1 limit
        // and self-comparison checks (`sql-limits.ts`, #77 and #78).
        assertD1StatementLimits(sql)
        let bindings: unknown[] = []
        const execute = <T>() => {
          owner.statements.push({ bindings, sql })
          const statement = owner.database.prepare(sql)
          const values = bindings as SQLInputValue[]
          let results: T[] = []
          let changes = 0
          if (statement.columns().length > 0) {
            results = statement.all(...values) as T[]
            changes = Number(owner.database.prepare('SELECT changes() AS changes').get()?.changes)
          } else {
            changes = Number(statement.run(...values).changes)
          }
          return {
            results,
            success: true as const,
            meta: {
              changes,
              duration: 0,
              rows_read: results.length,
              rows_written: 0
            }
          }
        }
        return {
          bind(...values: unknown[]) {
            assertD1StatementLimits(sql, values)
            bindings = values
            return this
          },
          async all<T>() {
            return execute<T>()
          },
          async first<T>() {
            return execute<T>().results[0] ?? null
          },
          /** Rows as value arrays in column order, as D1's `raw()` returns them to Drizzle. */
          async raw<T>() {
            owner.statements.push({ bindings, sql })
            const statement = owner.database.prepare(sql)
            statement.setReturnArrays(true)
            return statement.all(...(bindings as SQLInputValue[])) as T[]
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

export interface FixtureListing {
  /** Category ids in listing order; the first entry becomes the primary category. */
  categoryIds: number[]
  content: string | null
  description: string
  displayOrder: number
  entityType?: string
  id: string
  isFeatured: boolean
  isUnofficial?: boolean
  name: string
  priority?: 'high' | 'low' | 'medium'
  publishedAt: string
  slug: string
  website: string
}

/**
 * Insert a listing as a draft, attach its categories, then publish it. The
 * baseline triggers reject a published listing without exactly one primary
 * category, so fixtures follow the same draft-then-publish order as approval.
 */
export function insertPublishedListing(database: DatabaseSync, listing: FixtureListing): void {
  const [primaryId, ...secondaryIds] = listing.categoryIds
  if (primaryId === undefined) throw new Error(`Listing ${listing.id} needs a primary category.`)
  database
    .prepare(
      `INSERT INTO listings(
        id, slug, name, description, website, content, entity_type, priority,
        is_unofficial, is_featured, status, source_kind, source_identity, checksum, display_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'fixture', ?, ?, ?)`
    )
    .run(
      listing.id,
      listing.slug,
      listing.name,
      listing.description,
      listing.website,
      listing.content,
      listing.entityType ?? null,
      listing.priority ?? null,
      listing.isUnofficial ? 1 : 0,
      listing.isFeatured ? 1 : 0,
      listing.id,
      `checksum-${listing.id}`,
      listing.displayOrder
    )
  const insertCategory = database.prepare(
    'INSERT INTO listing_categories(listing_id, category_id, sort_order, is_primary) VALUES (?, ?, ?, ?)'
  )
  insertCategory.run(listing.id, primaryId, 0, 1)
  for (const [index, categoryId] of secondaryIds.entries()) {
    insertCategory.run(listing.id, categoryId, index + 1, 0)
  }
  database
    .prepare("UPDATE listings SET status = 'approved', published_at = ? WHERE id = ?")
    .run(listing.publishedAt, listing.id)
}

export function fixtureCategoryIds(database: DatabaseSync): Map<string, number> {
  const rows = database
    .prepare('SELECT id, slug FROM categories ORDER BY sort_order')
    .all() as Array<{ id: number; slug: string }>
  return new Map(rows.map(row => [row.slug, row.id]))
}

export function seedContractFixture(sqlite: SqliteD1): void {
  const { database } = sqlite
  database
    .prepare(
      "INSERT INTO publication_state(id, version, checksum, published_at) VALUES (1, 1, 'fixture', '2026-07-01T00:00:00.000Z')"
    )
    .run()
  for (const [index, slug] of ['primary', 'secondary', 'empty'].entries()) {
    database
      .prepare('INSERT INTO categories(slug, name, description, sort_order) VALUES (?, ?, ?, ?)')
      .run(slug, `${slug} category`, `${slug} description`, index)
  }
  const categoryIds = fixtureCategoryIds(database)
  const primaryId = categoryIds.get('primary')
  const secondaryId = categoryIds.get('secondary')
  if (!primaryId || !secondaryId) throw new Error('Missing category fixtures.')

  const listings = [
    { slug: 'alpha', published: '2026-07-05T00:00:00.000Z', order: 0, featured: true },
    { slug: 'bravo', published: '2026-07-04T00:00:00.000Z', order: 0, featured: true },
    { slug: 'charlie', published: '2026-07-04T00:00:00.000Z', order: 1, featured: false },
    { slug: 'delta', published: '2026-07-04T00:00:00.000Z', order: 1, featured: false },
    { slug: 'echo', published: '2026-07-03T00:00:00.000Z', order: 0, featured: false },
    { slug: 'future', published: '2027-01-01T00:00:00.000Z', order: 0, featured: true }
  ]
  for (const [index, listing] of listings.entries()) {
    const id = `serp-${listing.slug}`
    insertPublishedListing(database, {
      categoryIds: index % 2 === 0 ? [primaryId, secondaryId] : [primaryId],
      content: `${listing.slug} detail content`,
      description: `${listing.slug} description`,
      displayOrder: listing.order,
      entityType: 'software',
      id,
      isFeatured: listing.featured,
      isUnofficial: index === 3,
      name: `${listing.slug} listing`,
      priority: 'high',
      publishedAt: listing.published,
      slug: listing.slug,
      website: `https://${listing.slug}.example.com`
    })
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
    .prepare(
      `INSERT INTO listing_slug_redirects(listing_id, old_slug, new_slug, manifest_id, reason)
      VALUES (?, ?, ?, 'fixture', 'rename')`
    )
    .run('serp-bravo', 'old-bravo', 'bravo')
}
