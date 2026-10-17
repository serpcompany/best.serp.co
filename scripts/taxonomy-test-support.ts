/**
 * Shared by the taxonomy (#349) and Other retirement (#351) generators' tests: publishing a
 * manifest on a SQLite database the way the publisher's batch does, the catalog as the generators
 * read it, the synthetic taxonomy migration of the fixture and scale catalogs, and the reviewed
 * catalog of the inventories. Test support only: it imports vitest.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect } from 'vitest'
import { parse, stringify } from 'yaml'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { d1CompatViolations } from './d1-compat'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import {
  BEST_PAGE_PINS,
  buildTaxonomyManifests,
  planTaxonomy,
  STATEMENT_CEILING,
  type TaxonomyCatalog,
  type TaxonomyMapping,
  type TaxonomyPlan,
  taxonomyDefaults,
  taxonomyPaths
} from './taxonomy-manifest.ts'

export const NOW = '2026-10-10T00:00:00.000Z'
export const options = {
  date: taxonomyDefaults.date,
  keywordsCheckedAt: '2026-10-10T13:10:00.000Z'
}
/**
 * Time limits for the tests that generate or replay whole catalogs: a few seconds locally, but CI
 * runners are slower and share the d1 project with the workerd suites, so each has headroom over
 * vitest's 5-second default (which stays as it is for the rest).
 */
export const GENERATE_TIMEOUT = 60_000
export const REPLAY_TIMEOUT = 120_000
export const intro = Array.from({ length: 70 }, (_, index) => `word${index}`).join(' ')

// ---------------------------------------------------------------------------------------------
// Replays: the generator's manifests on a database, then the invariants of #349.

/** Applies a manifest's plan in one transaction, as the publisher's batch does; throws on refusal. */
export function apply(db: DatabaseSync, id: string, source: string): number {
  const state = db.prepare('SELECT version,checksum FROM publication_state WHERE id=1').get() as {
    version: number
    checksum: string
  }
  const plan = buildPublicationPlan(parseManifest(source), source, NOW, state)
  db.exec('BEGIN')
  try {
    for (const statement of plan.statements) {
      assertD1StatementLimits(statement.query, statement.bindings)
      expect(d1CompatViolations(statement.query), id).toEqual([])
      expect(
        statement.bindings.filter(value => typeof value === 'boolean'),
        id
      ).toEqual([])
      db.prepare(statement.query).run(...(statement.bindings as SQLInputValue[]))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw new Error(`${id} does not apply: ${error}`)
  }
  return plan.statements.length
}

export const all = <T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params) as T[]
export const LIVE = "l.status='approved' AND l.is_active=1"

/** The catalog as the generator takes it, read from a database. */
export function catalogFrom(db: DatabaseSync): TaxonomyCatalog {
  const listings = all<{ id: string; slug: string; is_active: number; categories: string }>(
    db,
    `SELECT l.id,l.slug,l.is_active,(SELECT json_group_array(slug) FROM (SELECT c.slug FROM
       listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=l.id
       ORDER BY lc.sort_order, c.slug)) AS categories FROM listings l WHERE l.status='approved'`
  ).map(row => ({
    id: row.id,
    slug: row.slug,
    live: row.is_active === 1,
    categories: JSON.parse(row.categories) as string[]
  }))
  const categories = all<{ slug: string; name: string; description: string; is_active: number }>(
    db,
    'SELECT slug,name,description,is_active FROM categories'
  ).map(row => ({ ...row, active: row.is_active === 1 }))
  const inReview = new Set(
    all<{ listing_id: string }>(
      db,
      "SELECT listing_id FROM listing_submissions WHERE status IN ('paid_pending_review','changes_requested') AND listing_id IS NOT NULL"
    ).map(row => row.listing_id)
  )
  const slugRedirectSources = new Set(
    all<{ id: string }>(
      db,
      'SELECT l.id FROM listings l JOIN listing_slug_redirects r ON r.old_slug=l.slug'
    ).map(row => row.id)
  )
  return { listings, categories, inReview, slugRedirectSources }
}

/**
 * A mapping for a synthetic catalog, as the reviewed one is built: kept hubs, new hubs in turn,
 * one tag per narrow category with every seventh merged into the one before, a cluster, tag-only,
 * hub-only and intersecting best pages pinned by slug, and every redirect aimed where the reviewed
 * mapping's rules aim it (a best page, else its tag, else its hub when the tag is empty).
 */
export function synthesizeMapping(
  catalog: TaxonomyCatalog,
  shape: { catchAll?: string; kept: string[]; hubs: number; clustered: number }
): { mapping: TaxonomyMapping; clusters: Map<string, string[]> } {
  const kept = new Set([...shape.kept, ...(shape.catchAll ? [shape.catchAll] : [])])
  const retiring = catalog.categories
    .filter(category => category.active && !kept.has(category.slug))
    .map(category => category.slug)
    .sort()
  const hubs = Array.from({ length: shape.hubs }, (_, index) => ({
    slug: `hub-${String(index + 1).padStart(2, '0')}`,
    name: `Hub ${index + 1}`,
    order: index + 1
  }))
  const tags: TaxonomyMapping['tags'] = []
  retiring.forEach((slug, index) => {
    const previous = tags.at(-1)
    if (index % 7 === 6 && previous) previous.merges = [...(previous.merges ?? []), slug]
    else tags.push({ slug, hub: hubs[index % hubs.length]?.slug ?? '', name: slug })
  })
  tags.push({
    slug: 'cluster-alpha',
    hub: hubs[0]?.slug ?? '',
    name: 'Cluster Alpha',
    cluster: true
  })
  const clusters = new Map<string, string[]>()
  if (shape.catchAll)
    for (const entry of catalog.listings
      .filter(item => item.live && item.categories.join() === shape.catchAll)
      .slice(0, shape.clustered))
      clusters.set(
        entry.id,
        clusters.size % 5 === 0 ? ['cluster-alpha', tags[0]?.slug ?? ''] : ['cluster-alpha']
      )
  const base: TaxonomyMapping = {
    decidedAt: '2026-10-10',
    catchAll: shape.catchAll,
    keywordsCheckedAt: options.keywordsCheckedAt,
    hubs: [...hubs, ...shape.kept.map(slug => ({ slug, existing: true }))],
    tags,
    bestPages: [],
    redirects: retiring.map(slug => ({
      from: { kind: 'category' as const, slug },
      to: { kind: 'category' as const, slug: hubs[0]?.slug ?? '' }
    }))
  }
  // First pass: where every listing ends up, to pick pages, pins and redirect targets from.
  const first = planTaxonomy({ mapping: base, catalog, clusters })
  const pool = (tag: string | null, hub: string | null) =>
    first.moves
      .filter(
        move =>
          move.live &&
          (tag === null || move.tags.includes(tag)) &&
          (hub === null || move.hub === hub)
      )
      .map(move => ({ id: move.id, slug: move.slug }))
  const sized = [...first.tagCounts]
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
  const page = (
    slug: string,
    tag: string | null,
    hub: string | null
  ): TaxonomyMapping['bestPages'][0] => {
    const pins = pool(tag, hub).slice(0, BEST_PAGE_PINS)
    if (hub !== null && tag === null && pins.length < BEST_PAGE_PINS)
      for (const entry of catalog.listings)
        if (
          pins.length < BEST_PAGE_PINS &&
          entry.live &&
          entry.categories[0] === hub &&
          !pins.some(pin => pin.id === entry.id)
        )
          pins.push({ id: entry.id, slug: entry.slug })
    return {
      slug,
      keyword: slug.replaceAll('-', ' '),
      volume: null,
      ...(tag === null ? {} : { tag }),
      ...(hub === null ? {} : { category: hub }),
      intro,
      pins: pins.map(pin => ({ ...pin, evidence: 'slug order' }))
    }
  }
  const [largest, second] = sized
  const intersectHub = largest ? (tags.find(tag => tag.slug === largest[0])?.hub ?? null) : null
  const bestPages = [
    ...(largest ? [page('best-largest', largest[0], null)] : []),
    ...(second ? [page('best-second', second[0], null)] : []),
    page('best-hub', null, shape.kept[0] ?? hubs[0]?.slug ?? null),
    ...(largest && intersectHub ? [page('best-both', largest[0], intersectHub)] : [])
  ].filter(entry => entry.pins.length > 0)
  const tagOnly = new Map(
    bestPages
      .filter(entry => entry.tag && !entry.category)
      .map(entry => [entry.tag ?? '', entry.slug])
  )
  const tagOf = (slug: string) =>
    tags.find(tag => tag.slug === slug || tag.merges?.includes(slug))?.slug ?? ''
  const redirects: TaxonomyMapping['redirects'] = retiring.map(slug => {
    const tag = tagOf(slug)
    const hub = tags.find(entry => entry.slug === tag)?.hub ?? ''
    const to = tagOnly.has(tag)
      ? { kind: 'best' as const, slug: tagOnly.get(tag) ?? '' }
      : (first.tagCounts.get(tag) ?? 0) > 0
        ? { kind: 'tag' as const, slug: tag }
        : { kind: 'category' as const, slug: hub }
    return { from: { kind: 'category' as const, slug }, to }
  })
  for (const [tag, best] of tagOnly)
    redirects.push({ from: { kind: 'tag', slug: tag }, to: { kind: 'best', slug: best } })
  return {
    mapping: {
      ...base,
      hubs: base.hubs.map(hub => ({ ...hub, listings: first.hubCounts.get(hub.slug) ?? 0 })),
      other: shape.catchAll ? { listings: first.hubCounts.get(shape.catchAll) ?? 0 } : undefined,
      tags: tags.map(tag => ({ ...tag, listings: first.tagCounts.get(tag.slug) ?? 0 })),
      bestPages,
      redirects
    },
    clusters
  }
}

/** #349's invariants once every phase is published. */
export function expectMigrated(
  db: DatabaseSync,
  mapping: TaxonomyMapping,
  plan: TaxonomyPlan
): void {
  const retiring = new Set(plan.retiring)
  const categories = new Map(
    all<{ slug: string; is_active: number }>(db, 'SELECT slug,is_active FROM categories').map(
      row => [row.slug, row.is_active]
    )
  )
  // Every narrow category is retired and empty of approved listings, but those already filed under
  // a category retired before (Adult), which stay as they were.
  for (const slug of retiring) expect(categories.get(slug), slug).toBe(0)
  const left = all<{ slug: string; category: string }>(
    db,
    `SELECT l.slug, c.slug AS category FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
     JOIN listings l ON l.id=lc.listing_id WHERE l.status='approved' AND c.is_active=0 AND NOT EXISTS
     (SELECT 1 FROM listing_categories o JOIN categories oc ON oc.id=o.category_id
      WHERE o.listing_id=l.id AND oc.is_active=0 AND oc.slug NOT IN (${[...retiring].map(() => '?').join(',')}))`,
    ...[...retiring]
  )
  expect(left.filter(row => retiring.has(row.category))).toEqual([])
  // Every published listing has exactly one category, its primary, and it is active.
  expect(
    all(
      db,
      `SELECT l.slug FROM listings l WHERE ${LIVE} AND l.published_at IS NOT NULL AND (
       (SELECT COUNT(*) FROM listing_categories lc WHERE lc.listing_id=l.id) != 1 OR
       (SELECT COUNT(*) FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
        WHERE lc.listing_id=l.id AND lc.is_primary=1 AND c.is_active=1) != 1)`
    )
  ).toEqual([])
  // Every old slug has a redirect; every redirect, and every active best page's tag and category,
  // is active, so no old narrow URL ends at a retired category.
  const redirects = all<{
    source_kind: string
    source_slug: string
    target_kind: string
    active: number
  }>(
    db,
    `SELECT r.source_kind, r.source_slug, r.target_kind, CASE r.target_kind WHEN 'directory' THEN 1
       WHEN 'category' THEN c.is_active WHEN 'tag' THEN t.is_active ELSE b.is_active END AS active
     FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id
     LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id`
  )
  expect(redirects.filter(row => row.active !== 1)).toEqual([])
  const sources = new Set(redirects.map(row => `${row.source_kind}:${row.source_slug}`))
  for (const slug of retiring) expect(sources.has(`category:${slug}`), slug).toBe(true)
  expect(redirects).toHaveLength(mapping.redirects.length)
  expect(
    all(
      db,
      `SELECT b.slug FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c
       ON c.id=b.category_id WHERE b.is_active=1 AND ((b.tag_id IS NOT NULL AND t.is_active != 1)
       OR (b.category_id IS NOT NULL AND c.is_active != 1))`
    )
  ).toEqual([])
  // Every tag-only best page's tag redirects to it.
  for (const page of mapping.bestPages.filter(entry => entry.tag && !entry.category))
    expect(
      db
        .prepare(
          `SELECT b.slug FROM taxonomy_redirects r JOIN best_pages b ON b.id=r.target_best_page_id
           WHERE r.source_kind='tag' AND r.source_slug=?`
        )
        .get(page.tag ?? ''),
      page.slug
    ).toEqual({ slug: page.slug })
  // Hub and tag counts are the mapping's.
  const hubCounts = new Map(
    all<{ slug: string; count: number }>(
      db,
      `SELECT c.slug, COUNT(*) AS count FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
       JOIN listings l ON l.id=lc.listing_id WHERE ${LIVE} AND lc.is_primary=1 GROUP BY c.slug`
    ).map(row => [row.slug, row.count])
  )
  for (const hub of mapping.hubs) expect(hubCounts.get(hub.slug) ?? 0, hub.slug).toBe(hub.listings)
  if (mapping.catchAll)
    expect(hubCounts.get(mapping.catchAll) ?? 0).toBe(mapping.other?.listings ?? 0)
  const tagCounts = new Map(
    all<{ slug: string; count: number }>(
      db,
      `SELECT t.slug, COUNT(*) AS count FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id
       JOIN listings l ON l.id=lt.listing_id WHERE ${LIVE} GROUP BY t.slug`
    ).map(row => [row.slug, row.count])
  )
  for (const tag of mapping.tags) expect(tagCounts.get(tag.slug) ?? 0, tag.slug).toBe(tag.listings)
  // Each best page pins its listings at positions 1, 2, … and excludes its exclusions.
  for (const page of mapping.bestPages) {
    const rows = all<{ slug: string; position: number | null; excluded: number }>(
      db,
      `SELECT l.slug, bpl.position, bpl.excluded FROM best_page_listings bpl JOIN best_pages b
       ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id WHERE b.slug=?
       ORDER BY bpl.excluded, bpl.position, l.slug`,
      page.slug
    )
    expect(rows, page.slug).toEqual([
      ...page.pins.map((pin, index) => ({ slug: pin.slug, position: index + 1, excluded: 0 })),
      ...(page.exclude ?? [])
        .map(entry => ({ slug: entry.slug, position: null, excluded: 1 }))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1))
    ])
  }
}

/** Generates the manifests for a database's catalog and publishes every phase in order. */
export function migrate(
  db: DatabaseSync,
  shape: Parameters<typeof synthesizeMapping>[1]
): { mapping: TaxonomyMapping; plan: TaxonomyPlan; queueCleared: boolean } {
  // The design's precondition is an empty review queue (4.2): with one, the generator names the
  // listings it can't move, and the owner clears the queue first.
  const queued = catalogFrom(db)
  const { mapping, clusters } = synthesizeMapping({ ...queued, inReview: new Set() }, shape)
  let queueCleared = false
  try {
    planTaxonomy({ mapping, catalog: queued, clusters })
  } catch (error) {
    expect(String(error)).toMatch(/clear the review queue first/u)
    db.exec(
      "UPDATE listing_submissions SET status='approved' WHERE status IN ('paid_pending_review','changes_requested') AND listing_id IS NOT NULL"
    )
    queueCleared = true
  }
  const plan = planTaxonomy({ mapping, catalog: catalogFrom(db), clusters })
  const manifests = buildTaxonomyManifests(plan, options)
  for (const { id: manifestId, source } of manifests)
    expect(apply(db, manifestId, source), manifestId).toBeLessThanOrEqual(STATEMENT_CEILING)
  return { mapping, plan, queueCleared }
}

/**
 * The fixture seed names its listings `fixture-listing-<slug>`; manifests name them `lst_…`
 * (`d1-publisher.ts`), as the catalog does. Renames them in every table that refers to one.
 */
export function withCatalogIds(db: DatabaseSync): void {
  const prefix = 'fixture-listing-'
  const rename = `'lst_' || substr(%, ${prefix.length + 1})`
  // Every reference moves with its row, so the keys hold again once all are renamed.
  db.exec('PRAGMA foreign_keys = OFF')
  const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table'")
  for (const { name } of tables) {
    const columns = all<{ name: string }>(db, `PRAGMA table_info(${name})`).map(
      column => column.name
    )
    // `alternative_id` names a listing too (#519: `listing_alternatives`).
    for (const column of ['listing_id', 'alternative_id'].filter(item => columns.includes(item)))
      db.exec(
        `UPDATE ${name} SET ${column}=${rename.replace('%', column)} WHERE ${column} LIKE '${prefix}%'`
      )
  }
  db.exec(`UPDATE listings SET id=${rename.replace('%', 'id')} WHERE id LIKE '${prefix}%'`)
  expect(all(db, 'PRAGMA foreign_key_check')).toEqual([])
  db.exec('PRAGMA foreign_keys = ON')
}

/** Removes the taxonomy a catalog already has: #341's starting point is none. */
export function withoutTaxonomy(db: DatabaseSync): void {
  for (const table of [
    'best_page_listings',
    'taxonomy_redirects',
    'best_pages',
    'listing_tags',
    'tags'
  ])
    db.exec(`DELETE FROM ${table}`)
}

// ---------------------------------------------------------------------------------------------
// The reviewed catalog: the committed mapping and manifests.

export interface InventoryRow {
  id: string
  slug: string
  name: string
  description: string
  website: string
  live?: boolean
  categories: string[]
}

/** The reviewed catalog at the inventories' snapshot, in a fresh database. */
export function reviewedCatalogDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames())
    db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  const read = <T>(path: string) => JSON.parse(readFileSync(resolve(path), 'utf8')) as T
  const other = read<{ listings: InventoryRow[] }>(taxonomyPaths.otherInventory).listings
  const rest = read<{ listings: InventoryRow[]; retiredCategories: string[] }>(
    taxonomyPaths.inventory
  )
  const narrow = read<{ categories: Array<{ slug: string; name: string; description: string }> }>(
    taxonomyPaths.categories
  ).categories
  const insertCategory = db.prepare('INSERT INTO categories (slug,name,description) VALUES (?,?,?)')
  for (const category of narrow)
    insertCategory.run(category.slug, category.name, category.description)
  for (const slug of ['other', ...rest.retiredCategories]) insertCategory.run(slug, slug, '')
  const insertListing = db.prepare(
    "INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum) VALUES (?,?,?,?,?,'draft','2026-01-01T00:00:00.000Z','test','fixture',?)"
  )
  const file = db.prepare(
    'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,?,? FROM categories WHERE slug=?'
  )
  const unpublish = db.prepare('UPDATE listings SET is_active=0 WHERE id=?')
  db.exec('BEGIN')
  for (const row of [...other.map(entry => ({ ...entry, live: true })), ...rest.listings]) {
    insertListing.run(row.id, row.slug, row.name, row.description, row.website, 'c'.repeat(64))
    for (const [order, slug] of row.categories.entries())
      file.run(row.id, order, order === 0 ? 1 : 0, slug)
    if (!row.live) unpublish.run(row.id)
  }
  db.exec("UPDATE listings SET status='approved'")
  // Retired after their listings came down, as #260's manifests did.
  db.prepare(
    `UPDATE categories SET is_active=0 WHERE slug IN (${rest.retiredCategories.map(() => '?').join(',')})`
  ).run(...rest.retiredCategories)
  db.exec(
    `INSERT INTO publication_state (id,version,checksum,published_at) VALUES (1,1,'${'a'.repeat(64)}','${NOW}')`
  )
  db.exec('COMMIT')
  return db
}

/** A committed manifest, or only its operations of the given kinds (as a manifest of its own). */
export function committed(name: string, actions?: ReadonlySet<string>): string {
  const source = readFileSync(resolve(taxonomyPaths.publications, name), 'utf8')
  if (!actions) return source
  const manifest = parse(source) as { operations: Array<{ action: string }> }
  return stringify({
    ...manifest,
    operations: manifest.operations.filter(op => actions.has(op.action))
  })
}

/**
 * The committed manifests published after the inventories' snapshot and before the taxonomy, as a
 * replay on the reviewed catalog applies them, in the owner's dispatch order (#321): #337 (its
 * media updates touch no category or live state, and need its uploads), #333's removals and
 * batches, #352, then #358 (its claim hold clears touch nothing here either).
 */
export function manifestsBeforeTaxonomy(): Array<[string, string]> {
  const unpublishOnly = new Set(['listing-unpublish'])
  return [
    [
      '2026-10-10-duplicate-listings',
      committed('2026-10-10-duplicate-listings.yaml', unpublishOnly)
    ],
    ['2026-10-10-other-removals', committed('2026-10-10-other-removals.yaml')],
    ...Array.from({ length: 9 }, (_, index): [string, string] => {
      const name = `2026-10-10-other-categories-${String(index + 1).padStart(2, '0')}`
      return [name, committed(`${name}.yaml`)]
    }),
    [
      '2026-10-10-duplicate-listings-redirects',
      committed('2026-10-10-duplicate-listings-redirects.yaml')
    ],
    ['2026-10-10-mismatch-removals', committed('2026-10-10-mismatch-removals.yaml')],
    ['2026-10-10-mismatch-renames', committed('2026-10-10-mismatch-renames.yaml')],
    ['2026-10-10-mismatch-categories', committed('2026-10-10-mismatch-categories.yaml')]
  ]
}
