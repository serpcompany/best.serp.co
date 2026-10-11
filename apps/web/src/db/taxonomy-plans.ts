// Relative, not `@/`: the D1 publisher loads this module under plain tsx, which has no alias
// (`scripts/tsx-import-graph.test.ts`).
import {
  beginCatalogPublicationPlans,
  type CatalogPublication,
  finishCatalogPublicationPlans,
  type StatementPlan
} from './plan-support'
import type { TaxonomyRedirectSourceKind } from './schema'

/**
 * The taxonomy's statements (serpcompany/best.serp.co#341): categories (hubs), tags, best pages,
 * and the redirects of their old URLs. The protected publisher (`scripts/d1-publisher.ts`, #344)
 * and the admin panel (#405) build the same operations here, so a manifest and an admin's
 * decision guard, write, and record them alike: every guard runs before the write it protects
 * and refuses the whole batch with its reason, and every value is bound, the reasons too.
 *
 * Tags and listing tags are written with `UPDATE`, or `INSERT … SELECT … WHERE is_active=1`,
 * never an upsert: SQLite fires a `BEFORE INSERT` trigger on an upsert's attempted insert even
 * when it becomes an update, so an upsert touching a retired tag would be refused
 * (`0013_taxonomy_triggers.sql`).
 */

/**
 * A guard failure that says why (#338 review): it rolls the batch back like `json_extract('',
 * '$')`, and D1 names the reason in its error (`bad JSON path: '<reason>'`), so the workflow's log,
 * or the admin decision, says what to fix. The reason names slugs, so it is bound like every
 * runtime value: the statement binds it as the parameter for this `?`, its last.
 */
export const REASONED_GUARD_FAILURE = "json_extract('{}', ?)"

/** The kinds of taxonomy page: a category (hub), a tag, or a best page. */
export type TaxonomyKind = TaxonomyRedirectSourceKind
/** Where a taxonomy redirect points: an active category, tag, or best page, or `/products/`. */
export type TaxonomyTarget = { kind: TaxonomyKind; slug: string } | { kind: 'directory' }
/** A tag's fields as `tag-update` compares them. */
export interface TagState {
  category: string
  description: string
  name: string
}
/** A category's fields as the admin's `category-edit` compares and writes them. */
export interface CategoryState {
  description: string
  name: string
  order: number
}
/** A best page's fields as `best-page-update` compares and writes them, every one stated. */
export interface BestPageState {
  category: string | null
  heading: string
  intro: string
  keyword: string
  keywordCheckedAt: string | null
  keywordVolume: number | null
  listSize: number
  order: number
  tag: string | null
  title: string
}
/** A listing a best page pins or excludes: its id and slug, as the row-level guards compare. */
export interface ListingRef {
  id: string
  slug: string
}
export interface BestPagePin extends ListingRef {
  blurb?: string | undefined
}
export interface BestPageListings {
  exclude: ListingRef[]
  pins: BestPagePin[]
}

/** The publisher's taxonomy operations (#344, design 4.1), as its manifest schema parses them. */
export type PublisherTaxonomyOperation =
  | {
      action: 'tag-create'
      tag: { category: string; description: string; name: string; order: number; slug: string }
    }
  | { action: 'tag-update'; expected: TagState; slug: string; tag: TagState & { order: number } }
  | { action: 'tag-unpublish'; redirect: TaxonomyTarget; slug: string }
  | { action: 'listing-tags-set'; expected: string[]; id: string; slug: string; tags: string[] }
  | { action: 'best-page-create'; page: BestPageState & { slug: string } }
  | { action: 'best-page-update'; expected: BestPageState; page: BestPageState; slug: string }
  | {
      action: 'best-page-listings-set'
      exclude: ListingRef[]
      expected: BestPageListings
      pins: BestPagePin[]
      slug: string
    }
  | { action: 'best-page-unpublish'; redirect: TaxonomyTarget; slug: string }
  | {
      action: 'taxonomy-redirect-set'
      expected: TaxonomyTarget | null
      from: { kind: TaxonomyKind; slug: string }
      to: TaxonomyTarget
    }

/**
 * The operations only the admin panel sends (#405), on the same guards and helpers:
 * - `category-create`: the publisher's own insert, guarded first so a taken slug says so;
 * - `category-edit`: a category's name, description, and order, compared and swapped;
 * - `category-retire`: `category-unpublish`'s refusals (a live listing, a slug redirect's source),
 *   plus an active tag or best page that draws on it, and an unpublished listing filed under it,
 *   whose 410 would turn into a 404 that Republish can't undo (#260); then the redirect a tag or
 *   best page retirement writes, re-pointing every redirect aimed at it;
 * - `taxonomy-rename`: a category, tag, or best page keeps its row (its listings, pins, and the
 *   redirects aimed at it follow its id) under a new slug, and its old URL redirects to it;
 * - `best-page-pins-check`: every pin of the best page is a live listing of its pool (its tag's
 *   listings, in its category when it names one), as the admin's pins and tag changes require.
 *
 * A batch that renames a page and edits it renames it first, so the edit and the end-of-batch
 * checks find it by its new slug.
 */
export type AdminTaxonomyOperation =
  | {
      action: 'category-create'
      category: { description: string; name: string; order: number; slug: string }
    }
  | { action: 'category-edit'; category: CategoryState; expected: CategoryState; slug: string }
  | { action: 'category-retire'; redirect: TaxonomyTarget; slug: string }
  | { action: 'taxonomy-rename'; kind: TaxonomyKind; slug: string; to: string }
  | { action: 'best-page-pins-check'; slug: string }

export type TaxonomyOperation = PublisherTaxonomyOperation | AdminTaxonomyOperation

/** Who writes the batch: the manifest's id and actor, or the admin's publication and email. */
export interface TaxonomyWriteContext {
  actor: string
  manifestId: string
  now: string
}

const statement = (sql: string, ...params: unknown[]): StatementPlan => ({ sql, params })
/** Refuses the batch, with `reason`, unless `condition` holds. */
function guard(condition: string, reason: string, ...bindings: unknown[]): StatementPlan {
  return statement(
    `SELECT CASE WHEN ${condition} THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`,
    ...bindings,
    reason
  )
}
/** Refuses the batch, with `reason`, unless the statement right before it changed one row. */
const changedOne = (reason: string): StatementPlan =>
  statement(`SELECT CASE WHEN changes()=1 THEN 1 ELSE ${REASONED_GUARD_FAILURE} END`, reason)

export const TAXONOMY_TABLES = { best: 'best_pages', category: 'categories', tag: 'tags' } as const
const TARGET_ID_COLUMNS = {
  best: 'target_best_page_id',
  category: 'target_category_id',
  tag: 'target_tag_id'
} as const
/** A listing's tags as `listing-tags-set` compares them: slugs by sort order, then slug. */
const CURRENT_TAGS_JSON =
  '(SELECT json_group_array(slug) FROM (SELECT t.slug FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id WHERE lt.listing_id=? ORDER BY lt.sort_order, t.slug))'
/** A redirect source's current target as `[kind, slug]` (`slug` null for `/products/`), or null. */
const CURRENT_REDIRECT_TARGET =
  '(SELECT json_array(r.target_kind, COALESCE(c.slug, t.slug, b.slug)) FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id WHERE r.source_kind=? AND r.source_slug=?)'
/** A best page's pins (`?` its slug), compared with `pinsJson`. */
const CURRENT_PINS_JSON =
  '(SELECT json_group_array(json_array(id, slug, blurb)) FROM (SELECT l.id, l.slug, bpl.blurb FROM best_page_listings bpl JOIN best_pages b ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id WHERE b.slug=? AND bpl.excluded=0 ORDER BY bpl.position))'
/** A best page's exclusions (`?` its slug), compared with `exclusionsJson`. */
const CURRENT_EXCLUSIONS_JSON =
  '(SELECT json_group_array(json_array(id, slug)) FROM (SELECT l.id, l.slug FROM best_page_listings bpl JOIN best_pages b ON b.id=bpl.best_page_id JOIN listings l ON l.id=bpl.listing_id WHERE b.slug=? AND bpl.excluded=1 ORDER BY l.id))'

/** A best page's pins as its guard compares them: `[id, slug, blurb]` in position order. */
export const pinsJson = (pins: BestPageListings['pins']): string =>
  JSON.stringify(pins.map(pin => [pin.id, pin.slug, pin.blurb ?? null]))
/** A best page's exclusions as its guard compares them: `[id, slug]` ordered by id. */
export const exclusionsJson = (exclude: BestPageListings['exclude']): string =>
  JSON.stringify(
    exclude
      .map(entry => [entry.id, entry.slug])
      .sort(([a = ''], [b = '']) => (a < b ? -1 : a > b ? 1 : 0))
  )
/**
 * The `best_pages` columns a best page's state writes, each with its value's SQL, bound from
 * `bestPageColumns` in this order. A null tag or category binds null, so its id is null.
 */
const BEST_PAGE_WRITES = {
  keyword: '?',
  title: '?',
  heading: '?',
  intro: '?',
  tag_id: '(SELECT id FROM tags WHERE slug=?)',
  category_id: '(SELECT id FROM categories WHERE slug=?)',
  list_size: '?',
  keyword_volume: '?',
  keyword_checked_at: '?',
  sort_order: '?'
} as const
/** A best page's state in `BEST_PAGE_WRITES` order, as `best-page-update` compares and writes it. */
export const bestPageColumns = (page: BestPageState) => [
  page.keyword,
  page.title,
  page.heading,
  page.intro,
  page.tag,
  page.category,
  page.listSize,
  page.keywordVolume,
  page.keywordCheckedAt,
  page.order
]
/** A redirect target as `[kind, slug]`, the shape its guard compares (`slug` null for `/products/`). */
export function targetPair(target: TaxonomyTarget): [string, string | null] {
  return [target.kind, target.kind === 'directory' ? null : target.slug]
}
export const sameTarget = (a: TaxonomyTarget | null, b: TaxonomyTarget | null): boolean =>
  JSON.stringify(a && targetPair(a)) === JSON.stringify(b && targetPair(b))

/** The id of slug `?` in `table`, or NULL for a column the target doesn't set. */
const idOf = (table: string, set: boolean) =>
  set ? `(SELECT id FROM ${table} WHERE slug=?)` : 'NULL'
/**
 * A redirect target's columns, `target_kind` then the category, tag, and best page ids, as SQL
 * expressions and their bindings. Exactly the target's own id is set, as the table's CHECK
 * requires; the guards have already found it active.
 */
function targetColumns(target: TaxonomyTarget): { bindings: unknown[]; sql: string[] } {
  return {
    bindings: [target.kind, ...(target.kind === 'directory' ? [] : [target.slug])],
    sql: [
      '?',
      idOf('categories', target.kind === 'category'),
      idOf('tags', target.kind === 'tag'),
      idOf('best_pages', target.kind === 'best')
    ]
  }
}
const KIND_NOUNS = { best: 'best page', category: 'category', tag: 'tag' } as const
/**
 * Refuses the batch unless `target` is an active category, tag, or best page (`/products/`
 * always is). `role` names it in the reason: a redirect's target, a best page's pool, a tag's hub.
 */
function targetActiveGuard(
  target: TaxonomyTarget,
  label: string,
  role = 'the redirect target'
): StatementPlan[] {
  if (target.kind === 'directory') return []
  return [
    guard(
      `EXISTS (SELECT 1 FROM ${TAXONOMY_TABLES[target.kind]} WHERE slug=? AND is_active=1)`,
      `${label}: ${role} ${KIND_NOUNS[target.kind]} ${target.slug} is missing or retired`,
      target.slug
    )
  ]
}
/**
 * Refuses a redirect that would make a chain or a loop (design 2.2: no chains), as
 * `listing-slug-redirect` does for listings: `to`'s own URL already redirects, or a redirect
 * already ends at `from`. A page wins over its redirect, so either would become a second hop once
 * that page empties or retires. Retiring a tag or best page is how a URL that others point at
 * moves: it re-points them (`retireWithRedirect`).
 */
function redirectChainGuard(
  from: { kind: TaxonomyKind; slug: string },
  to: TaxonomyTarget,
  label: string
): StatementPlan {
  const endsAtSource = `EXISTS (SELECT 1 FROM taxonomy_redirects WHERE ${TARGET_ID_COLUMNS[from.kind]}=(SELECT id FROM ${TAXONOMY_TABLES[from.kind]} WHERE slug=?))`
  const reason = `${label}: this would make a chain: the target redirects too, or a redirect already ends at this URL`
  if (to.kind === 'directory') return guard(`NOT ${endsAtSource}`, reason, from.slug)
  return guard(
    `NOT EXISTS (SELECT 1 FROM taxonomy_redirects WHERE source_kind=? AND source_slug=?) AND NOT ${endsAtSource}`,
    reason,
    to.kind,
    to.slug,
    from.slug
  )
}
/** Inserts the redirect of `kind` `slug` to `target`; the caller has removed any earlier one. */
function insertRedirect(
  kind: string,
  slug: string,
  target: TaxonomyTarget,
  manifestId: string,
  now: string
): StatementPlan {
  const columns = targetColumns(target)
  return statement(
    `INSERT INTO taxonomy_redirects (source_kind,source_slug,target_kind,target_category_id,target_tag_id,target_best_page_id,manifest_id,created_at) VALUES (?,?,${columns.sql.join(',')},?,?)`,
    kind,
    slug,
    ...columns.bindings,
    manifestId,
    now
  )
}
/**
 * Sends the URL of the category, tag, or best page `slug`, just retired, to `target`, which must
 * be active. Every redirect aimed at it is re-pointed to the same target, so a redirect never
 * leads to a retired page or through a second hop (design 2.2). A redirect from the target's own
 * URL would then point at itself, so it is removed instead: while the target is active its page
 * renders, and if it retires later, its own retirement writes the redirect for that URL. A
 * redirect from the target's own URL to anywhere else refuses the batch: it would be a second hop.
 */
function redirectRetired(
  kind: TaxonomyKind,
  slug: string,
  target: TaxonomyTarget,
  label: string,
  manifestId: string,
  now: string
): StatementPlan[] {
  const table = TAXONOMY_TABLES[kind]
  const column = TARGET_ID_COLUMNS[kind]
  const columns = targetColumns(target)
  return [
    ...(target.kind === 'directory'
      ? []
      : [
          // A redirect from the target's own URL to anywhere else would be a second hop.
          guard(
            `NOT EXISTS (SELECT 1 FROM taxonomy_redirects WHERE source_kind=? AND source_slug=? AND ${column} IS NOT (SELECT id FROM ${table} WHERE slug=?))`,
            `${label}: the redirect target itself redirects elsewhere; this would make a chain`,
            target.kind,
            target.slug,
            slug
          ),
          statement(
            `DELETE FROM taxonomy_redirects WHERE source_kind=? AND source_slug=? AND ${column}=(SELECT id FROM ${table} WHERE slug=?)`,
            target.kind,
            target.slug,
            slug
          )
        ]),
    statement(
      `UPDATE taxonomy_redirects SET target_kind=${columns.sql[0]},target_category_id=${columns.sql[1]},target_tag_id=${columns.sql[2]},target_best_page_id=${columns.sql[3]},manifest_id=? WHERE ${column}=(SELECT id FROM ${table} WHERE slug=?)`,
      ...columns.bindings,
      manifestId,
      slug
    ),
    statement('DELETE FROM taxonomy_redirects WHERE source_kind=? AND source_slug=?', kind, slug),
    insertRedirect(kind, slug, target, manifestId, now)
  ]
}
/**
 * Retires the active tag or best page `slug` (`tag-unpublish`, `best-page-unpublish`) and sends
 * its URL to `target` (`redirectRetired`).
 */
function retireWithRedirect(
  kind: 'best' | 'tag',
  slug: string,
  target: TaxonomyTarget,
  label: string,
  manifestId: string,
  now: string
): StatementPlan[] {
  return [
    ...targetActiveGuard(target, label),
    statement(
      `UPDATE ${TAXONOMY_TABLES[kind]} SET is_active=0,updated_at=? WHERE slug=? AND is_active=1`,
      now,
      slug
    ),
    changedOne(`${label}: no active ${KIND_NOUNS[kind]} has this slug`),
    ...redirectRetired(kind, slug, target, label, manifestId, now)
  ]
}
/** Refuses the batch unless the named tag and category of a best page's pool are active. */
function poolGuards(
  page: { category: string | null; tag: string | null },
  label: string
): StatementPlan[] {
  return [
    ...(page.tag === null ? [] : targetActiveGuard({ kind: 'tag', slug: page.tag }, label, 'the')),
    ...(page.category === null
      ? []
      : targetActiveGuard({ kind: 'category', slug: page.category }, label, 'the'))
  ]
}

/** The publisher's `category-create`: an active category. A taken slug fails its UNIQUE key. */
export function categoryCreateStatement(category: {
  description: string
  name: string
  order: number
  slug: string
}): StatementPlan {
  return statement(
    'INSERT INTO categories (slug,name,description,sort_order,is_active) VALUES (?,?,?,?,1)',
    category.slug,
    category.name,
    category.description,
    category.order
  )
}
/**
 * The publisher's `category-unpublish` (#260, #338): retires a category, refused while a live
 * listing is filed under it, or a listing filed under it is a slug redirect's source.
 */
export function categoryUnpublishStatements(slug: string, now: string): StatementPlan[] {
  return [
    statement(
      "UPDATE categories SET is_active=0,updated_at=? WHERE slug=? AND NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN listings l ON l.id=lc.listing_id WHERE lc.category_id=categories.id AND l.status='approved' AND l.is_active=1)",
      now,
      slug
    ),
    statement("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('', '$') END"),
    // #338: never while a listing filed under it is a slug redirect's source. Retired, that
    // listing would answer 404 (#260), but the product page reads the redirect first.
    statement(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id JOIN listing_slug_redirects r ON r.old_slug=l.slug WHERE c.slug=?) THEN ${REASONED_GUARD_FAILURE} ELSE 1 END`,
      slug,
      `category-unpublish ${slug}: a listing filed under it is the source of a slug redirect; re-file that listing first`
    )
  ]
}

/**
 * Listing `l` is approved and unpublished, and filed under no retired category: its URL answers
 * 410 with "Relist it" (#64). Retiring a category it is filed under would make that a 404 and keep
 * it from being republished (#260), so `category-retire` refuses while one is.
 */
const UNPUBLISHED_ELSEWHERE_LIVE = `l.status='approved' AND l.is_active=0 AND NOT EXISTS (SELECT 1 FROM listing_categories x JOIN categories xc ON xc.id=x.category_id WHERE x.listing_id=l.id AND xc.is_active=0)`
/**
 * Listing `l` is live and in best page `b`'s pool: it carries the page's tag (when it has one) and
 * is filed under its category (when it names one).
 */
const LIVE_IN_POOL = `l.status='approved' AND l.is_active=1 AND l.published_at IS NOT NULL AND (b.tag_id IS NULL OR EXISTS (SELECT 1 FROM listing_tags lt WHERE lt.listing_id=l.id AND lt.tag_id=b.tag_id)) AND (b.category_id IS NULL OR EXISTS (SELECT 1 FROM listing_categories lc WHERE lc.listing_id=l.id AND lc.category_id=b.category_id))`

/** The statements of the admin-only operations (`AdminTaxonomyOperation`). */
function adminStatements(
  op: AdminTaxonomyOperation,
  context: TaxonomyWriteContext
): StatementPlan[] {
  const { manifestId, now } = context
  switch (op.action) {
    case 'category-create': {
      const label = `category-create ${op.category.slug}`
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM categories WHERE slug=?)',
          `${label}: a category has this slug, active or retired`,
          op.category.slug
        ),
        categoryCreateStatement(op.category)
      ]
    }
    case 'category-edit': {
      const label = `category-edit ${op.slug}`
      return [
        statement(
          'UPDATE categories SET name=?,description=?,sort_order=?,updated_at=? WHERE slug=? AND is_active=1 AND name=? AND description=? AND sort_order=?',
          op.category.name,
          op.category.description,
          op.category.order,
          now,
          op.slug,
          op.expected.name,
          op.expected.description,
          op.expected.order
        ),
        changedOne(`${label}: the category is missing, retired, or not as expected`)
      ]
    }
    case 'category-retire': {
      const label = `category-retire ${op.slug}`
      if (op.redirect.kind === 'category' && op.redirect.slug === op.slug) {
        throw new Error('A category cannot redirect to itself.')
      }
      return [
        guard(
          'EXISTS (SELECT 1 FROM categories WHERE slug=? AND is_active=1)',
          `${label}: no active category has this slug`,
          op.slug
        ),
        // `categories_refuse_retiring_with_active_tags` refuses it too; this names the reason.
        guard(
          'NOT EXISTS (SELECT 1 FROM tags t JOIN categories c ON c.id=t.category_id WHERE c.slug=? AND t.is_active=1)',
          `${label}: an active tag is filed under it`,
          op.slug
        ),
        guard(
          'NOT EXISTS (SELECT 1 FROM best_pages b JOIN categories c ON c.id=b.category_id WHERE c.slug=? AND b.is_active=1)',
          `${label}: an active best page draws on it`,
          op.slug
        ),
        guard(
          "NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id WHERE c.slug=? AND l.status='approved' AND l.is_active=1)",
          `${label}: a live listing is filed under it`,
          op.slug
        ),
        guard(
          `NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id JOIN listings l ON l.id=lc.listing_id WHERE c.slug=? AND ${UNPUBLISHED_ELSEWHERE_LIVE})`,
          `${label}: an unpublished listing is filed under it`,
          op.slug
        ),
        ...targetActiveGuard(op.redirect, label),
        ...categoryUnpublishStatements(op.slug, now),
        ...redirectRetired('category', op.slug, op.redirect, label, manifestId, now)
      ]
    }
    case 'best-page-pins-check':
      return [
        guard(
          `NOT EXISTS (SELECT 1 FROM best_pages b JOIN best_page_listings p ON p.best_page_id=b.id AND p.excluded=0 JOIN listings l ON l.id=p.listing_id WHERE b.slug=? AND NOT (${LIVE_IN_POOL}))`,
          `best-page-pins-check ${op.slug}: a pin is not a live listing of its pool`,
          op.slug
        )
      ]
    case 'taxonomy-rename': {
      const table = TAXONOMY_TABLES[op.kind]
      const noun = KIND_NOUNS[op.kind]
      const label = `${op.kind === 'best' ? 'best-page' : op.kind}-rename ${op.slug}`
      if (op.to === op.slug) throw new Error('A rename needs a new slug.')
      const self = targetColumns({ kind: op.kind, slug: op.to })
      return [
        guard(
          `EXISTS (SELECT 1 FROM ${table} WHERE slug=? AND is_active=1)`,
          `${label}: no active ${noun} has this slug`,
          op.slug
        ),
        guard(
          `NOT EXISTS (SELECT 1 FROM ${table} WHERE slug=?)`,
          `${label}: a ${noun} has the new slug, active or retired`,
          op.to
        ),
        // An earlier rename away from the new slug left a redirect from it to this same page,
        // which would now point at itself: the page renders there again.
        statement(
          `DELETE FROM taxonomy_redirects WHERE source_kind=? AND source_slug=? AND ${TARGET_ID_COLUMNS[op.kind]}=(SELECT id FROM ${table} WHERE slug=?)`,
          op.kind,
          op.to,
          op.slug
        ),
        // Any other redirect from the new URL would send it elsewhere once this page empties.
        guard(
          'NOT EXISTS (SELECT 1 FROM taxonomy_redirects WHERE source_kind=? AND source_slug=?)',
          `${label}: the new URL already redirects elsewhere`,
          op.kind,
          op.to
        ),
        statement(
          `UPDATE ${table} SET slug=?,updated_at=? WHERE slug=? AND is_active=1`,
          op.to,
          now,
          op.slug
        ),
        changedOne(`${label}: no active ${noun} has this slug`),
        // The old URL now redirects here, unless it already had a redirect of its own: one
        // published while the page rendered (a tag a tag-only best page took over, design 2.2)
        // takes effect now instead, as it would once the page emptied.
        statement(
          `INSERT INTO taxonomy_redirects (source_kind,source_slug,target_kind,target_category_id,target_tag_id,target_best_page_id,manifest_id,created_at) SELECT ?,?,${self.sql.join(',')},?,? WHERE NOT EXISTS (SELECT 1 FROM taxonomy_redirects WHERE source_kind=? AND source_slug=?)`,
          op.kind,
          op.slug,
          ...self.bindings,
          manifestId,
          now,
          op.kind,
          op.slug
        )
      ]
    }
  }
}

/** The statements of the publisher's taxonomy operations (#341 design 4.1, #344). */
function publisherStatements(
  op: PublisherTaxonomyOperation,
  context: TaxonomyWriteContext
): StatementPlan[] {
  const { actor, manifestId, now } = context
  switch (op.action) {
    case 'tag-create': {
      const label = `tag-create ${op.tag.slug}`
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM tags WHERE slug=?)',
          `${label}: a tag has this slug, active or retired`,
          op.tag.slug
        ),
        statement(
          'INSERT INTO tags (slug,name,description,category_id,sort_order,is_active,created_at,updated_at) SELECT ?,?,?,id,?,1,?,? FROM categories WHERE slug=? AND is_active=1',
          op.tag.slug,
          op.tag.name,
          op.tag.description,
          op.tag.order,
          now,
          now,
          op.tag.category
        ),
        changedOne(`${label}: the category ${op.tag.category} is missing or retired`)
      ]
    }
    case 'tag-update': {
      const label = `tag-update ${op.slug}`
      return [
        guard(
          'EXISTS (SELECT 1 FROM tags t JOIN categories c ON c.id=t.category_id WHERE t.slug=? AND t.name=? AND t.description=? AND c.slug=?)',
          `${label}: the tag is missing or not as expected`,
          op.slug,
          op.expected.name,
          op.expected.description,
          op.expected.category
        ),
        ...targetActiveGuard({ kind: 'category', slug: op.tag.category }, label, 'the'),
        // A retired tag stays retired: `is_active` is not written.
        statement(
          'UPDATE tags SET name=?,description=?,category_id=(SELECT id FROM categories WHERE slug=?),sort_order=?,updated_at=? WHERE slug=?',
          op.tag.name,
          op.tag.description,
          op.tag.category,
          op.tag.order,
          now,
          op.slug
        )
      ]
    }
    case 'tag-unpublish': {
      const label = `tag-unpublish ${op.slug}`
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM best_pages b JOIN tags t ON t.id=b.tag_id WHERE t.slug=? AND b.is_active=1)',
          `${label}: an active best page uses the tag`,
          op.slug
        ),
        ...retireWithRedirect('tag', op.slug, op.redirect, label, manifestId, now)
      ]
    }
    case 'listing-tags-set': {
      const label = `listing-tags-set ${op.slug}`
      return [
        // Approved, live or unpublished: the migration re-files unpublished listings too (1.5).
        guard(
          "EXISTS (SELECT 1 FROM listings WHERE id=? AND slug=? AND status='approved')",
          `${label}: no approved listing has this id and slug`,
          op.id,
          op.slug
        ),
        guard(
          `${CURRENT_TAGS_JSON}=?`,
          `${label}: its tags are not the expected ones`,
          op.id,
          JSON.stringify(op.expected)
        ),
        statement('DELETE FROM listing_tags WHERE listing_id=?', op.id),
        // A missing or retired tag inserts nothing: refused.
        ...op.tags.flatMap((tag, order) => [
          statement(
            'INSERT INTO listing_tags (listing_id,tag_id,sort_order) SELECT ?,id,? FROM tags WHERE slug=? AND is_active=1',
            op.id,
            order,
            tag
          ),
          changedOne(`${label}: the tag ${tag} is missing or retired`)
        ]),
        // The page shows its tags: sitemap lastmod (#218). The checksum stays, so a revision or a
        // paid submission read before this still applies (design 4.1).
        statement('UPDATE listings SET updated_at=? WHERE id=?', now, op.id),
        statement(
          "INSERT INTO listing_events (listing_id,event_type,detail,actor) VALUES (?,'edited',?,?)",
          op.id,
          JSON.stringify({
            fields: ['tags'],
            manifest: manifestId,
            from: op.expected,
            to: op.tags
          }),
          actor
        )
      ]
    }
    case 'best-page-create': {
      const { page } = op
      const label = `best-page-create ${page.slug}`
      return [
        guard(
          'NOT EXISTS (SELECT 1 FROM best_pages WHERE slug=?)',
          `${label}: a best page has this slug, active or retired`,
          page.slug
        ),
        ...poolGuards(page, label),
        statement(
          `INSERT INTO best_pages (slug,${Object.keys(BEST_PAGE_WRITES).join(',')},is_active,created_at,updated_at) VALUES (?,${Object.values(BEST_PAGE_WRITES).join(',')},1,?,?)`,
          page.slug,
          ...bestPageColumns(page),
          now,
          now
        )
      ]
    }
    case 'best-page-update': {
      const { expected, page } = op
      const label = `best-page-update ${op.slug}`
      return [
        // `IS`: the tag, category, volume, and check date may each be null.
        guard(
          'EXISTS (SELECT 1 FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=? AND b.keyword=? AND b.title=? AND b.heading=? AND b.intro=? AND t.slug IS ? AND c.slug IS ? AND b.list_size=? AND b.keyword_volume IS ? AND b.keyword_checked_at IS ? AND b.sort_order=?)',
          `${label}: the best page is missing or not as expected`,
          op.slug,
          ...bestPageColumns(expected)
        ),
        ...poolGuards(page, label),
        statement(
          `UPDATE best_pages SET ${Object.entries(BEST_PAGE_WRITES)
            .map(([column, value]) => `${column}=${value}`)
            .join(',')},updated_at=? WHERE slug=?`,
          ...bestPageColumns(page),
          now,
          op.slug
        )
      ]
    }
    case 'best-page-listings-set': {
      const label = `best-page-listings-set ${op.slug}`
      const insert = (entry: ListingRef, values: string, ...bindings: unknown[]) => [
        statement(
          `INSERT INTO best_page_listings (best_page_id,listing_id,position,excluded,blurb) SELECT (SELECT id FROM best_pages WHERE slug=?),id,${values} FROM listings WHERE id=? AND slug=? AND status='approved'`,
          op.slug,
          ...bindings,
          entry.id,
          entry.slug
        ),
        changedOne(`${label}: no approved listing is ${entry.slug} (${entry.id})`)
      ]
      return [
        // The page changed: its sitemap lastmod. Also the check that the page exists.
        statement('UPDATE best_pages SET updated_at=? WHERE slug=?', now, op.slug),
        changedOne(`${label}: no best page has this slug`),
        guard(
          `${CURRENT_PINS_JSON}=? AND ${CURRENT_EXCLUSIONS_JSON}=?`,
          `${label}: its pins and exclusions are not the expected ones`,
          op.slug,
          pinsJson(op.expected.pins),
          op.slug,
          exclusionsJson(op.expected.exclude)
        ),
        statement(
          'DELETE FROM best_page_listings WHERE best_page_id=(SELECT id FROM best_pages WHERE slug=?)',
          op.slug
        ),
        // `excluded` is the literal 0 or 1, never a bound boolean (#339 review).
        ...op.pins.flatMap((pin, index) => insert(pin, '?,0,?', index + 1, pin.blurb ?? null)),
        ...op.exclude.flatMap(entry => insert(entry, 'NULL,1,NULL'))
      ]
    }
    case 'best-page-unpublish': {
      const label = `best-page-unpublish ${op.slug}`
      return retireWithRedirect('best', op.slug, op.redirect, label, manifestId, now)
    }
    case 'taxonomy-redirect-set': {
      const { expected, from, to } = op
      const label = `taxonomy-redirect-set ${from.kind} ${from.slug}`
      const columns = targetColumns(to)
      return [
        guard(
          `${CURRENT_REDIRECT_TARGET} IS ?`,
          `${label}: its current target is not the expected one`,
          from.kind,
          from.slug,
          expected === null ? null : JSON.stringify(targetPair(expected))
        ),
        ...targetActiveGuard(to, label),
        redirectChainGuard(from, to, label),
        expected === null
          ? insertRedirect(from.kind, from.slug, to, manifestId, now)
          : statement(
              `UPDATE taxonomy_redirects SET target_kind=${columns.sql[0]},target_category_id=${columns.sql[1]},target_tag_id=${columns.sql[2]},target_best_page_id=${columns.sql[3]},manifest_id=? WHERE source_kind=? AND source_slug=?`,
              ...columns.bindings,
              manifestId,
              from.kind,
              from.slug
            )
      ]
    }
  }
}

const ADMIN_ACTIONS = new Set<string>([
  'best-page-pins-check',
  'category-create',
  'category-edit',
  'category-retire',
  'taxonomy-rename'
])
const isAdminOperation = (op: TaxonomyOperation): op is AdminTaxonomyOperation =>
  ADMIN_ACTIONS.has(op.action)

/** One taxonomy operation's statements, guards first. */
export function taxonomyOperationStatements(
  op: TaxonomyOperation,
  context: TaxonomyWriteContext
): StatementPlan[] {
  return isAdminOperation(op) ? adminStatements(op, context) : publisherStatements(op, context)
}

/**
 * The redirect an operation leaves at the end of its batch, if any: the source it wrote, which
 * must still exist and point at an active target.
 */
function redirectLeft(op: TaxonomyOperation): { kind: string; label: string; slug: string } | null {
  switch (op.action) {
    case 'taxonomy-redirect-set':
      return {
        kind: op.from.kind,
        label: `${op.action} ${op.from.kind} ${op.from.slug}`,
        slug: op.from.slug
      }
    case 'tag-unpublish':
      return { kind: 'tag', label: `${op.action} ${op.slug}`, slug: op.slug }
    case 'best-page-unpublish':
      return { kind: 'best', label: `${op.action} ${op.slug}`, slug: op.slug }
    case 'category-retire':
      return { kind: 'category', label: `${op.action} ${op.slug}`, slug: op.slug }
    case 'taxonomy-rename':
      return { kind: op.kind, label: `${op.kind}-rename ${op.slug}`, slug: op.slug }
    default:
      return null
  }
}

/**
 * Checks after a batch's last operation (#344, the ordering gap #338's review found): a later
 * operation in the same batch can retire what an earlier one pointed at. `category-unpublish`
 * re-points nothing, so retiring a category after a redirect to it, or after a best page drawing
 * on it, would leave a redirect to a retired page or an active best page on a retired hub.
 * Either refuses the whole batch, whatever the order of its operations.
 */
export function taxonomyBatchChecks(operations: readonly TaxonomyOperation[]): StatementPlan[] {
  return operations.flatMap(op => {
    const redirect = redirectLeft(op)
    if (redirect)
      return [
        guard(
          "EXISTS (SELECT 1 FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id WHERE r.source_kind=? AND r.source_slug=? AND (r.target_kind='directory' OR c.is_active=1 OR t.is_active=1 OR b.is_active=1))",
          `${redirect.label}: by the end of the batch, its redirect is gone or its target is retired`,
          redirect.kind,
          redirect.slug
        )
      ]
    if (op.action === 'best-page-create' || op.action === 'best-page-update') {
      const slug = op.action === 'best-page-create' ? op.page.slug : op.slug
      return [
        guard(
          'EXISTS (SELECT 1 FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=? AND (b.is_active=0 OR ((b.tag_id IS NULL OR t.is_active=1) AND (b.category_id IS NULL OR c.is_active=1))))',
          `${op.action} ${slug}: by the end of the batch, its tag or category is retired`,
          slug
        )
      ]
    }
    return []
  })
}

/**
 * An admin's taxonomy decision (#405) as one batch: the publication opens on the state the admin
 * read, the operations run in order on the publisher's guards, the end-of-batch checks follow,
 * and the publication advances the catalog version (so cached pages turn over) and records its
 * run with the admin's email. Each redirect it writes names the publication's manifest id.
 */
export function buildTaxonomyPlans(input: {
  operations: readonly TaxonomyOperation[]
  publication: CatalogPublication
}): StatementPlan[] {
  const { operations, publication } = input
  if (operations.length === 0) throw new Error('A taxonomy decision needs an operation.')
  const context = {
    actor: publication.actor,
    manifestId: publication.manifestId,
    now: publication.now
  }
  return [
    // The operations guard their own rows; the publication guards the version the admin read.
    ...beginCatalogPublicationPlans(publication, { params: [], sql: '1' }),
    ...operations.flatMap(op => taxonomyOperationStatements(op, context)),
    ...taxonomyBatchChecks(operations),
    ...finishCatalogPublicationPlans(publication)
  ]
}

/** Listing `alias` is public at the bound instant: the catalog's public eligibility. */
const publicAt = (alias: string) =>
  `${alias}.status='approved' AND ${alias}.is_active=1 AND ${alias}.published_at IS NOT NULL AND ${alias}.published_at<=?`

/**
 * Whether a category, tag, or best page renders at `asOf` (#346), the rule a taxonomy redirect is
 * followed by (`taxonomyTargetRenders` in `catalog-epoch.ts`): a category or tag with a public
 * listing (a tag under an active hub), or a best page with an entry (a public pin, or a public
 * listing of its pool it doesn't exclude). A retirement may redirect only to a page that renders,
 * or its URL would answer 404 (#405). `alias` is the row's table alias.
 */
export function taxonomyRendersSql(
  kind: TaxonomyKind,
  alias: string,
  asOf: string
): { params: unknown[]; sql: string } {
  if (kind === 'category') {
    return {
      params: [asOf],
      sql: `EXISTS (SELECT 1 FROM listing_categories rlc JOIN listings rl ON rl.id=rlc.listing_id WHERE rlc.category_id=${alias}.id AND ${publicAt('rl')})`
    }
  }
  if (kind === 'tag') {
    return {
      params: [asOf],
      sql: `(EXISTS (SELECT 1 FROM categories rh WHERE rh.id=${alias}.category_id AND rh.is_active=1) AND EXISTS (SELECT 1 FROM listing_tags rlt JOIN listings rl ON rl.id=rlt.listing_id WHERE rlt.tag_id=${alias}.id AND ${publicAt('rl')}))`
    }
  }
  const excluded = (listing: string) =>
    `NOT EXISTS (SELECT 1 FROM best_page_listings rx WHERE rx.best_page_id=${alias}.id AND rx.listing_id=${listing}.id AND rx.excluded=1)`
  return {
    params: [asOf, asOf, asOf],
    sql: `(EXISTS (SELECT 1 FROM best_page_listings rp JOIN listings rl ON rl.id=rp.listing_id WHERE rp.best_page_id=${alias}.id AND rp.excluded=0 AND ${publicAt('rl')}) OR EXISTS (SELECT 1 FROM listing_tags rlt JOIN listings rl ON rl.id=rlt.listing_id WHERE rlt.tag_id=${alias}.tag_id AND ${publicAt('rl')} AND (${alias}.category_id IS NULL OR EXISTS (SELECT 1 FROM listing_categories ri WHERE ri.listing_id=rl.id AND ri.category_id=${alias}.category_id)) AND ${excluded('rl')}) OR (${alias}.tag_id IS NULL AND EXISTS (SELECT 1 FROM listing_categories rlc JOIN listings rl ON rl.id=rlc.listing_id WHERE rlc.category_id=${alias}.category_id AND ${publicAt('rl')} AND ${excluded('rl')})))`
  }
}

/** What `selectTaxonomyStatePlan` reads of each kind, as JSON (`item`), or null without a row. */
const TAXONOMY_ITEM_JSON: Record<TaxonomyKind, (renders: string) => string> = {
  category: renders => `(SELECT json_object('slug',c.slug,'name',c.name,'description',c.description,
      'order',c.sort_order,'active',c.is_active,
      'liveListings',(SELECT COUNT(*) FROM listing_categories lc JOIN listings l
        ON l.id=lc.listing_id WHERE lc.category_id=c.id AND l.status='approved' AND l.is_active=1),
      'unpublishedListings',(SELECT COUNT(*) FROM listing_categories ulc JOIN listings l
        ON l.id=ulc.listing_id WHERE ulc.category_id=c.id AND ${UNPUBLISHED_ELSEWHERE_LIVE}),
      'activeTags',(SELECT COUNT(*) FROM tags t WHERE t.category_id=c.id AND t.is_active=1),
      'activeBestPages',(SELECT COUNT(*) FROM best_pages b
        WHERE b.category_id=c.id AND b.is_active=1),
      'redirectSources',(SELECT COUNT(*) FROM listing_categories lc
        JOIN listings l ON l.id=lc.listing_id JOIN listing_slug_redirects r ON r.old_slug=l.slug
        WHERE lc.category_id=c.id),
      'renders',${renders})
    FROM categories c WHERE c.slug=?)`,
  tag: renders => `(SELECT json_object('slug',t.slug,'name',t.name,'description',t.description,
      'order',t.sort_order,'active',t.is_active,'category',c.slug,
      'activeBestPages',(SELECT COUNT(*) FROM best_pages b WHERE b.tag_id=t.id AND b.is_active=1),
      'renders',${renders})
    FROM tags t JOIN categories c ON c.id=t.category_id WHERE t.slug=?)`,
  best: renders => `(SELECT json_object('slug',b.slug,'keyword',b.keyword,'title',b.title,
      'heading',b.heading,'intro',b.intro,'tag',t.slug,'category',c.slug,'listSize',b.list_size,
      'keywordVolume',b.keyword_volume,'keywordCheckedAt',b.keyword_checked_at,
      'order',b.sort_order,'active',b.is_active,
      'pins',json((SELECT json_group_array(json_array(id,slug,blurb)) FROM (SELECT l.id,l.slug,
        p.blurb FROM best_page_listings p JOIN listings l ON l.id=p.listing_id
        WHERE p.best_page_id=b.id AND p.excluded=0 ORDER BY p.position))),
      'exclude',json((SELECT json_group_array(json_array(id,slug)) FROM (SELECT l.id,l.slug
        FROM best_page_listings p JOIN listings l ON l.id=p.listing_id
        WHERE p.best_page_id=b.id AND p.excluded=1 ORDER BY l.id))),
      'renders',${renders})
    FROM best_pages b LEFT JOIN tags t ON t.id=b.tag_id
    LEFT JOIN categories c ON c.id=b.category_id WHERE b.slug=?)`
}

const ITEM_ALIASES: Record<TaxonomyKind, string> = { best: 'b', category: 'c', tag: 't' }

/**
 * A category, tag, or best page as an admin decision compares it (#405), active or retired, with
 * what its refusals count, whether it renders at `asOf`, the redirect from its URL (`[kind, slug]`,
 * as `taxonomy-redirect-set` compares it), and the publication state the decision publishes on:
 * one row of `version`, `publication_checksum`, `item` (JSON, or null), and `redirect`.
 */
export function selectTaxonomyStatePlan(
  kind: TaxonomyKind,
  slug: string,
  asOf: string
): StatementPlan {
  const renders = taxonomyRendersSql(kind, ITEM_ALIASES[kind], asOf)
  return {
    sql: `SELECT ps.version,ps.checksum AS publication_checksum,${TAXONOMY_ITEM_JSON[kind](
      `(CASE WHEN ${renders.sql} THEN 1 ELSE 0 END)`
    )} AS item,
      ${CURRENT_REDIRECT_TARGET} AS redirect FROM publication_state ps WHERE ps.id=1`,
    params: [...renders.params, slug, kind, slug]
  }
}
