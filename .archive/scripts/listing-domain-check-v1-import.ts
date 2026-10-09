/**
 * ARCHIVED (serpcompany/best.serp.co#315): the v1-import listing source of
 * `scripts/listing-domain-check.ts` (`pnpm catalog:domains`), cut from it as it was before #315:
 * the reviewed import in memory, with the committed manifests that shape the catalog replayed on
 * it. The live check reads an environment's D1 instead (`environmentListings`). History only: not
 * built, linted, or run; its imports name the files as they were then.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, type PublicationBase, parseManifest } from './d1-publisher'
import type { CatalogListing } from './listing-domain-check'

/** The reviewed import in an in-memory database: the fresh migrations, then the committed SQL. */
export function reviewedImportDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  database.exec(readReviewedImportSql(readParityReport()))
  return database
}

/** A database's live listings, with their active categories in order. */
export function liveListings(database: DatabaseSync): CatalogListing[] {
  const rows = database
    .prepare(
      `SELECT l.id,l.slug,l.name,l.description,l.website,
        (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc
          JOIN categories c ON c.id=lc.category_id
          WHERE lc.listing_id=l.id AND c.is_active=1 ORDER BY lc.sort_order)) AS categories
      FROM listings l WHERE l.status='approved' AND l.is_active=1 ORDER BY l.slug`
    )
    .all() as Array<Record<string, string>>
  return rows.map(row => ({
    categories: JSON.parse(row.categories ?? '[]') as string[],
    description: row.description ?? '',
    id: row.id ?? '',
    name: row.name ?? '',
    slug: row.slug ?? '',
    website: row.website ?? ''
  }))
}

/** Live listings of the reviewed import, with their active categories in order. */
export function reviewedImportListings(): CatalogListing[] {
  const database = reviewedImportDatabase()
  try {
    return liveListings(database)
  } finally {
    database.close()
  }
}

/** Committed publication manifests in file (date) order; other tests write temporary ones there. */
export function committedPublications(): string[] {
  return execFileSync('git', ['ls-files', 'd1/publications'], { encoding: 'utf8' })
    .split('\n')
    .filter(path => path.endsWith('.yaml'))
    .sort()
}

/**
 * Applies a manifest to `database` as the publisher's batch would, at the database's publication
 * state, in one transaction: it applies whole or throws and writes nothing.
 */
export function applyManifest(database: DatabaseSync, source: string, now: string): void {
  const live = database
    .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
    .get() as unknown as PublicationBase
  const plan = buildPublicationPlan(parseManifest(source), source, now, live)
  database.exec('BEGIN')
  try {
    for (const item of plan.statements)
      database
        .prepare(item.query)
        .run(
          ...(item.bindings.map(value =>
            typeof value === 'boolean' ? Number(value) : value
          ) as SQLInputValue[])
        )
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** What decides which listings are live and which categories they are filed under. */
const catalogShapingActions = new Set([
  'listing-categories-add',
  'listing-categories-remove',
  'listing-unpublish',
  'category-unpublish'
])

/**
 * The reviewed import with every committed manifest that changes which listings are live or what
 * categories they are filed under applied in file order, as staging and production publish them
 * (#260): #98's manifest gave 14 adult downloaders the Adult category, which their unpublish must
 * expect, and a listing another manifest unpublishes is no longer live. With `before` (a manifest
 * id), only the manifests whose file sorts before it: the catalog a manifest being generated, and
 * every later one, is published on.
 */
export function reviewedCatalogDatabase(before?: string): DatabaseSync {
  const database = reviewedImportDatabase()
  try {
    for (const path of committedPublications()) {
      if (before !== undefined && path >= `d1/publications/${before}.yaml`) break
      const source = readFileSync(resolve(path), 'utf8')
      const manifest = parseManifest(source)
      if (!manifest.operations.some(op => catalogShapingActions.has(op.action))) continue
      try {
        applyManifest(database, source, '2026-10-09T00:00:00.000Z')
      } catch (error) {
        throw new Error(`${path} does not apply after the manifests before it: ${error}`)
      }
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/** Live listings of the reviewed catalog (`reviewedCatalogDatabase`). */
export function reviewedCatalogListings(before?: string): CatalogListing[] {
  const database = reviewedCatalogDatabase(before)
  try {
    return liveListings(database)
  } finally {
    database.close()
  }
}
