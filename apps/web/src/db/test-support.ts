import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { CatalogDataCache } from './contracts'
import { assertD1StatementLimits } from './sql-limits'

const MIGRATIONS_DIRECTORY = resolve(import.meta.dirname, '../../drizzle')

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

/** One call that reached the database: a statement on its own, or a batch of `size` (#378). */
export type RecordedRoundTrip = { kind: 'batch'; size: number } | { kind: 'statement'; sql: string }

/** Runs a prepared statement inside a batch, which is one round trip, not one per statement. */
const runInBatch = new WeakMap<object, () => unknown>()

export { findSelfComparison } from './sql-limits'

export class SqliteD1 {
  readonly database: DatabaseSync
  readonly statements: RecordedStatement[] = []
  /** Every round trip, in order: how many sequential waits on D1 a read makes (#378). */
  readonly roundTrips: RecordedRoundTrip[] = []
  private batches: Promise<unknown> = Promise.resolve()

  constructor(path = ':memory:') {
    this.database = new DatabaseSync(path)
    applyMigrations(this.database)
  }

  asD1Database(): D1Database {
    const owner = this
    const binding = {
      prepare(sql: string) {
        // Every db and app test that runs SQL through this binding gets the D1 limit
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
        const roundTrip = () => owner.roundTrips.push({ kind: 'statement', sql })
        const prepared = {
          bind(...values: unknown[]) {
            assertD1StatementLimits(sql, values)
            bindings = values
            return this
          },
          async all<T>() {
            roundTrip()
            return execute<T>()
          },
          async first<T>() {
            roundTrip()
            return execute<T>().results[0] ?? null
          },
          /** Rows as value arrays in column order, as D1's `raw()` returns them to Drizzle. */
          async raw<T>() {
            roundTrip()
            owner.statements.push({ bindings, sql })
            const statement = owner.database.prepare(sql)
            statement.setReturnArrays(true)
            return statement.all(...(bindings as SQLInputValue[])) as T[]
          },
          async run<T>() {
            roundTrip()
            return execute<T>()
          }
        }
        runInBatch.set(prepared, () => execute())
        return prepared as unknown as D1PreparedStatement
      },
      // D1 runs one batch at a time, so overlapping callers (the badge program checks several
      // sites at once) queue here instead of opening a transaction inside another.
      batch<T>(statements: D1PreparedStatement[]) {
        owner.roundTrips.push({ kind: 'batch', size: statements.length })
        const run = async () => {
          owner.database.exec('BEGIN')
          try {
            const results: D1Result<T>[] = []
            for (const statement of statements) {
              const inBatch = runInBatch.get(statement)
              // The app's generated Worker types make run() non-generic; the rows are T here.
              results.push((inBatch ? inBatch() : await statement.run()) as D1Result<T>)
            }
            owner.database.exec('COMMIT')
            return results
          } catch (error) {
            owner.database.exec('ROLLBACK')
            throw error
          }
        }
        const result = owner.batches.then(run, run)
        owner.batches = result.catch(() => undefined)
        return result
      }
    }
    return binding as unknown as D1Database
  }
}

/** A copy of a replicated database: its primary or its replica. */
export type D1Copy = 'primary' | 'replica'

/**
 * D1 with read replication on (#382), for tests of what a lagging replica can do: a primary and
 * one replica, each a SQLite database (`SqliteD1`) with its own version. `write` applies SQL to
 * the primary as a new version and to the replica only when it catches up (`catchUp`).
 *
 * As on D1, the binding itself (`prepare`, `batch`) always reads the primary. A session
 * (`withSession`) sends each statement to the binding's nearest copy when that copy is at least as
 * new as the session's floor, otherwise to the primary; the floor starts at the bookmark it was
 * given (0 for `first-unconstrained`; `first-primary` sends its first statement to the primary)
 * and rises to each version a statement read, so the session reads sequentially. Bookmarks are
 * versions, zero-padded so they order as strings, as D1's do. A batch runs on the copy its
 * statements were prepared on.
 */
export class ReplicatedD1 {
  readonly primary = new SqliteD1()
  readonly replica = new SqliteD1()
  readonly versions: Record<D1Copy, number> = { primary: 1, replica: 1 }
  /** The copy each statement was sent to, in order. */
  readonly served: D1Copy[] = []
  /** Every `withSession` argument, in order. */
  readonly sessions: string[] = []
  private readonly lagging: string[] = []

  /** Seeds both copies alike, at version 1. */
  seed(apply: (copy: SqliteD1) => void): void {
    apply(this.primary)
    apply(this.replica)
  }

  /** Applies `sql` to the primary as a new version; the replica gets it on `catchUp`. */
  write(sql: string): void {
    this.primary.database.exec(sql)
    this.versions.primary += 1
    this.lagging.push(sql)
  }

  /** The replica applies every write it lacks. */
  catchUp(): void {
    for (const sql of this.lagging.splice(0)) this.replica.database.exec(sql)
    this.versions.replica = this.versions.primary
  }

  /** The `DB` binding of a Worker whose nearest copy is `nearest`. */
  binding(nearest: D1Copy): D1Database {
    const owner = this
    const primary = this.primary.asD1Database()
    return {
      batch: (statements: D1PreparedStatement[]) => primary.batch(statements),
      prepare(sql: string) {
        owner.served.push('primary')
        return primary.prepare(sql)
      },
      withSession(constraint = 'first-unconstrained') {
        owner.sessions.push(constraint)
        return owner.session(constraint, nearest)
      }
    } as unknown as D1Database
  }

  private session(constraint: string, nearest: D1Copy): D1DatabaseSession {
    const owner = this
    const copies = { primary: this.primary.asD1Database(), replica: this.replica.asD1Database() }
    let floor =
      constraint === 'first-primary'
        ? Number.POSITIVE_INFINITY
        : constraint === 'first-unconstrained'
          ? 0
          : Number(constraint)
    let seen: number | null = null
    let last: D1Copy = 'primary'
    return {
      batch: (statements: D1PreparedStatement[]) => copies[last].batch(statements),
      getBookmark: () => (seen === null ? null : String(seen).padStart(8, '0')),
      prepare(sql: string) {
        last = nearest === 'replica' && owner.versions.replica >= floor ? 'replica' : 'primary'
        seen = owner.versions[last]
        floor = seen
        owner.served.push(last)
        return copies[last].prepare(sql)
      }
    } as unknown as D1DatabaseSession
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

/**
 * The taxonomy (#341) on top of `seedContractFixture`, for the catalog's taxonomy reads:
 *
 * - tags `writers` (hub `primary`: alpha, bravo and charlie at centrality 0, delta at 2, and the
 *   scheduled `future`), `editors` (hub `secondary`: alpha, bravo and echo at 0, charlie at 1),
 *   `idle` (hub `empty`, no listing) and `retired-tag` (retired after bravo and delta took it);
 * - best pages `best-writers` (the tag; delta and echo pinned, echo from outside the tag; charlie
 *   excluded), `best-primary` (the category; bravo excluded), `best-editors-in-secondary` (the tag
 *   within the category; bravo, outside the category, pinned), `best-idle` (the empty category),
 *   and `best-retired-tag` and `best-inactive`, which are not public;
 * - redirects from old URLs to each kind of target, a retired one, one to a best page whose tag
 *   is retired, and one from an active category.
 *
 * Only bravo has a hosted logo, and every `updated_at` is fixed (bravo's last, in D1's
 * `CURRENT_TIMESTAMP` format), so the order and the dates are deterministic.
 */
export function seedTaxonomyFixture(sqlite: SqliteD1): void {
  const { database } = sqlite
  database.exec(`
    UPDATE listings SET updated_at = '2026-07-01 00:00:00';
    UPDATE listings SET updated_at = '2026-07-20 10:30:00' WHERE slug = 'bravo';
    UPDATE listing_media
      SET media_key = 'best.serp.co/listings/bravo/logo/0123456789abcdef.png',
        sha256 = '${'a'.repeat(64)}', content_type = 'image/png', bytes = 100, width = 10,
        height = 10
      WHERE listing_id = 'serp-bravo' AND kind = 'logo';
    INSERT INTO tags (slug, name, description, category_id, sort_order)
      SELECT 'writers', 'Writers', 'Writing tools', id, 0 FROM categories WHERE slug = 'primary';
    INSERT INTO tags (slug, name, description, category_id, sort_order)
      SELECT 'editors', 'Editors', '', id, 1 FROM categories WHERE slug = 'secondary';
    INSERT INTO tags (slug, name, description, category_id, sort_order)
      SELECT 'idle', 'Idle', '', id, 2 FROM categories WHERE slug = 'empty';
    INSERT INTO tags (slug, name, description, category_id, sort_order)
      SELECT 'retired-tag', 'Retired Tag', '', id, 3 FROM categories WHERE slug = 'primary';
    INSERT INTO listing_tags (listing_id, tag_id, sort_order)
      SELECT m.listing_id, t.id, m.sort_order FROM (
        SELECT 'serp-alpha' AS listing_id, 'writers' AS tag, 0 AS sort_order
        UNION ALL SELECT 'serp-bravo', 'writers', 0
        UNION ALL SELECT 'serp-charlie', 'writers', 0
        UNION ALL SELECT 'serp-delta', 'writers', 2
        UNION ALL SELECT 'serp-future', 'writers', 0
        UNION ALL SELECT 'serp-alpha', 'editors', 0
        UNION ALL SELECT 'serp-bravo', 'editors', 0
        UNION ALL SELECT 'serp-charlie', 'editors', 1
        UNION ALL SELECT 'serp-echo', 'editors', 0
        UNION ALL SELECT 'serp-bravo', 'retired-tag', 2
        UNION ALL SELECT 'serp-delta', 'retired-tag', 2
      ) m JOIN tags t ON t.slug = m.tag;
    UPDATE tags SET is_active = 0 WHERE slug = 'retired-tag';
    INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id, category_id, list_size,
      sort_order, is_active, updated_at)
      SELECT p.slug, p.keyword, p.title, p.heading, p.intro, t.id, c.id, p.list_size, p.sort_order,
        p.is_active, '2026-07-02T00:00:00.000Z'
      FROM (
        SELECT 'best-writers' AS slug, 'writers' AS keyword, 'Best Writers' AS title,
          'The best writers' AS heading, 'Writers, ranked.' AS intro, 'writers' AS tag,
          NULL AS category, 5 AS list_size, 0 AS sort_order, 1 AS is_active
        UNION ALL SELECT 'best-primary', 'primary', 'Best Primary', 'The best primary', '',
          NULL, 'primary', 5, 1, 1
        UNION ALL SELECT 'best-editors-in-secondary', 'editors in secondary',
          'Best Editors in Secondary', 'The best editors in secondary', '', 'editors',
          'secondary', 5, 2, 1
        UNION ALL SELECT 'best-idle', 'idle', 'Best Idle', 'The best idle', '', NULL, 'empty',
          5, 3, 1
        UNION ALL SELECT 'best-retired-tag', 'retired', 'Best Retired', 'The best retired', '',
          'retired-tag', NULL, 5, 4, 1
      ) p
      LEFT JOIN tags t ON t.slug = p.tag
      LEFT JOIN categories c ON c.slug = p.category;
    INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id, list_size, is_active)
      SELECT 'best-inactive', 'inactive', 'Best Inactive', 'The best inactive', '', id, 5, 0
      FROM tags WHERE slug = 'writers';
    INSERT INTO best_page_listings (best_page_id, listing_id, position, excluded, blurb)
      SELECT b.id, e.listing_id, e.position, e.excluded, e.blurb FROM (
        SELECT 'best-writers' AS page, 'serp-delta' AS listing_id, 1 AS position, 0 AS excluded,
          'Delta leads.' AS blurb
        UNION ALL SELECT 'best-writers', 'serp-echo', 2, 0, NULL
        UNION ALL SELECT 'best-writers', 'serp-charlie', NULL, 1, NULL
        UNION ALL SELECT 'best-primary', 'serp-bravo', NULL, 1, NULL
        UNION ALL SELECT 'best-editors-in-secondary', 'serp-bravo', 1, 0, NULL
      ) e JOIN best_pages b ON b.slug = e.page;
    INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_category_id,
      target_tag_id, target_best_page_id, manifest_id)
      SELECT r.source_kind, r.source_slug, r.target_kind, c.id, t.id, b.id, 'fixture' FROM (
        SELECT 'category' AS source_kind, 'old-hub' AS source_slug, 'category' AS target_kind,
          'secondary' AS target
        UNION ALL SELECT 'category', 'old-tag', 'tag', 'writers'
        UNION ALL SELECT 'category', 'old-best', 'best', 'best-writers'
        UNION ALL SELECT 'category', 'old-other', 'directory', NULL
        UNION ALL SELECT 'category', 'old-retired-tag', 'tag', 'retired-tag'
        UNION ALL SELECT 'category', 'old-best-retired-tag', 'best', 'best-retired-tag'
        UNION ALL SELECT 'category', 'primary', 'category', 'secondary'
        UNION ALL SELECT 'category', 'old-empty-hub', 'category', 'empty'
        UNION ALL SELECT 'category', 'old-idle-tag', 'tag', 'idle'
        UNION ALL SELECT 'category', 'old-idle-best', 'best', 'best-idle'
        UNION ALL SELECT 'category', 'empty', 'tag', 'writers'
        UNION ALL SELECT 'tag', 'old-writers', 'tag', 'writers'
        UNION ALL SELECT 'best', 'old-best-writers', 'best', 'best-writers'
      ) r
      LEFT JOIN categories c ON r.target_kind = 'category' AND c.slug = r.target
      LEFT JOIN tags t ON r.target_kind = 'tag' AND t.slug = r.target
      LEFT JOIN best_pages b ON r.target_kind = 'best' AND b.slug = r.target;
  `)
}
