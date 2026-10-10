import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { CatalogPublication, StatementPlan } from './plan-support'
import { assertD1StatementLimits } from './sql-limits'
import { applyMigrations, insertPublishedListing } from './test-support'

/** Fixture database for statement-plan tests: two categories, two users, version 1. */
export function planDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db)
  db.exec(`
    INSERT INTO categories (slug, name, description, sort_order, is_active)
      VALUES ('tools', 'Tools', 'Tools', 0, 1), ('apps', 'Apps', 'Apps', 1, 1);
    INSERT INTO publication_state (id, version, checksum, published_at)
      VALUES (1, 1, 'before', '2026-01-01T00:00:00.000Z');
    INSERT INTO users (id, name, email, email_verified)
      VALUES ('user_owner', 'Owner', 'owner@example.com', 1),
        ('user_other', 'Other', 'other@example.com', 1);
  `)
  return db
}

/**
 * The taxonomy fixture (#341): active tags under the two hubs, a retired tag, and retired narrow
 * categories for each of the stale-slug resolver's cases (design 4.4):
 * - `chatbots`: an active tag under Apps took over its slug;
 * - `merged-narrow`: merged into the tag `note-taking` (Tools), as `ai-copywriting-free` into
 *   `ai-copywriting`; its `taxonomy_redirects` row points at the tag;
 * - `best-narrow`: its redirect points at the best page `best-boards`, whose tag is
 *   `whiteboards` (Apps);
 * - `hub-narrow`: its redirect points at the category Apps.
 */
export function seedTags(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO categories (slug, name, description, sort_order, is_active) VALUES
      ('chatbots', 'Chatbots', 'Chatbots', 2, 1),
      ('merged-narrow', 'Merged', 'Merged', 3, 1),
      ('best-narrow', 'Best', 'Best', 4, 1),
      ('hub-narrow', 'Hub', 'Hub', 5, 1);
    INSERT INTO tags (slug, name, category_id, sort_order, is_active) VALUES
      ('note-taking', 'Note Taking', (SELECT id FROM categories WHERE slug = 'tools'), 0, 1),
      ('whiteboards', 'Whiteboards', (SELECT id FROM categories WHERE slug = 'apps'), 0, 1),
      ('chatbots', 'Chatbots', (SELECT id FROM categories WHERE slug = 'apps'), 1, 1),
      ('retired-tag', 'Retired', (SELECT id FROM categories WHERE slug = 'tools'), 2, 0);
    INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id)
      SELECT 'best-boards', 'best boards', 'Best Boards', 'Best Boards', 'Boards.', id
      FROM tags WHERE slug = 'whiteboards';
    INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_tag_id,
      manifest_id) SELECT 'category', 'merged-narrow', 'tag', id, 'fixture' FROM tags
      WHERE slug = 'note-taking';
    INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_best_page_id,
      manifest_id) SELECT 'category', 'best-narrow', 'best', id, 'fixture' FROM best_pages
      WHERE slug = 'best-boards';
    INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_category_id,
      manifest_id) SELECT 'category', 'hub-narrow', 'category', id, 'fixture' FROM categories
      WHERE slug = 'apps';
    UPDATE categories SET is_active = 0
      WHERE slug IN ('chatbots', 'merged-narrow', 'best-narrow', 'hub-narrow');
  `)
}

/** A listing's tags with their stored `sort_order`, in order (`sort_order`, then slug). */
export function listingTagOrder(
  db: DatabaseSync,
  listingId: string
): Array<{ slug: string; sort_order: number }> {
  return db
    .prepare(
      `SELECT t.slug, lt.sort_order FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE lt.listing_id = ? ORDER BY lt.sort_order, t.slug`
    )
    .all(listingId) as Array<{ slug: string; sort_order: number }>
}

/** A listing's tags in order (`sort_order`, then slug). */
export function listingTags(db: DatabaseSync, listingId: string): string[] {
  return (
    db
      .prepare(
        `SELECT t.slug FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
        WHERE lt.listing_id = ? ORDER BY lt.sort_order, t.slug`
      )
      .all(listingId) as Array<{ slug: string }>
  ).map(row => row.slug)
}

/** A listing's primary category slug. */
export function primaryCategory(db: DatabaseSync, listingId: string): string | undefined {
  return (
    db
      .prepare(
        `SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
        WHERE lc.listing_id = ? AND lc.is_primary = 1`
      )
      .get(listingId) as { slug: string } | undefined
  )?.slug
}

export function categoryId(db: DatabaseSync, slug: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug) as { id: number }
  return row.id
}

/** A published listing with a logo, an image, a resource link, and an FAQ. */
export function seedLiveListing(
  db: DatabaseSync,
  id: string,
  options: { categories?: string[]; checksum?: string; slug?: string } = {}
): void {
  const slug = options.slug ?? `${id}.example`
  insertPublishedListing(db, {
    categoryIds: (options.categories ?? ['tools']).map(category => categoryId(db, category)),
    content: 'Live content',
    description: 'Live description',
    displayOrder: 0,
    id,
    isFeatured: false,
    name: `Live ${id}`,
    publishedAt: '2026-05-16',
    slug,
    website: `https://${slug}/`
  })
  db.prepare('UPDATE listings SET checksum = ? WHERE id = ?').run(
    options.checksum ?? `checksum-${id}`,
    id
  )
  db.prepare(
    `INSERT INTO listing_media (listing_id, kind, url, sort_order)
    VALUES (?, 'logo', 'https://assets.example/old-logo.png', 0),
      (?, 'image', 'https://assets.example/image.png', 1)`
  ).run(id, id)
  db.prepare(
    `INSERT INTO listing_resource_links (listing_id, label, url, sort_order)
    VALUES (?, 'Old docs', 'https://old.example/docs', 0)`
  ).run(id)
  db.prepare(
    `INSERT INTO listing_faqs (listing_id, question, answer, sort_order)
    VALUES (?, 'Old question', 'Old answer', 0)`
  ).run(id)
}

/** Sends a plan as one transaction, as a D1 batch does. */
export function execute(db: DatabaseSync, plans: StatementPlan[]): void {
  db.exec('BEGIN')
  try {
    for (const plan of plans) {
      assertD1StatementLimits(plan.sql, plan.params)
      const statement = db.prepare(plan.sql)
      const params = plan.params as SQLInputValue[]
      if (statement.columns().length > 0) statement.all(...params)
      else statement.run(...params)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function query(db: DatabaseSync, plan: StatementPlan): unknown[] {
  assertD1StatementLimits(plan.sql, plan.params)
  return db.prepare(plan.sql).all(...(plan.params as SQLInputValue[]))
}

export function count(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count)
}

export const NOW = '2026-10-06T12:00:00.000Z'

/** Publication inputs for the fixture's version 1 (or the given version and checksum). */
export function publication(
  action: string,
  options: { checksum?: string; version?: number } = {}
): CatalogPublication {
  const version = options.version ?? 1
  const checksum = options.checksum ?? 'before'
  const manifestId = `${action}-v${version + 1}`
  return {
    actor: 'reviewer',
    affectedRoutes: '/products/example/',
    afterChecksum: createHash('sha256')
      .update(`${checksum}\n${manifestId}\n${version + 1}`)
      .digest('hex'),
    beforeChecksum: checksum,
    manifestId,
    now: NOW,
    runId: `${action}_v${version + 1}`,
    version,
    workflow: 'test/plans'
  }
}

export function publicationState(db: DatabaseSync): { checksum: string; version: number } {
  return db.prepare('SELECT version, checksum FROM publication_state WHERE id = 1').get() as {
    checksum: string
    version: number
  }
}
