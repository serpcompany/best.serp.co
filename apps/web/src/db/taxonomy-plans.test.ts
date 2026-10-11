import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  count,
  execute,
  planDatabase,
  publication,
  publicationState,
  query,
  seedLiveListing,
  seedTags
} from './plan-test-support'
import {
  buildTaxonomyPlans,
  selectTaxonomyStatePlan,
  type TaxonomyOperation
} from './taxonomy-plans'

/**
 * The admin's taxonomy plans (#405) on node:sqlite with the checked-in migrations: each create,
 * edit, rename, and retirement of a category, tag, and best page runs the publisher's operations
 * between a publication, refuses with its reason and writes nothing, and keeps every old URL
 * redirecting in one hop.
 */

let db: DatabaseSync

/** Sends one admin decision's batch on the current publication state. */
function apply(...operations: TaxonomyOperation[]): void {
  execute(
    db,
    buildTaxonomyPlans({ operations, publication: publication('admin', publicationState(db)) })
  )
}

/** The batch is refused with `reason`, and nothing changes. */
function refused(reason: string, ...operations: TaxonomyOperation[]): void {
  const before = snapshot()
  expect(() => apply(...operations), reason).toThrow(`bad JSON path: '${reason}'`)
  expect(snapshot()).toEqual(before)
}

function snapshot() {
  return {
    bestPages: db.prepare('SELECT * FROM best_pages ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
    pins: db.prepare('SELECT * FROM best_page_listings ORDER BY best_page_id, listing_id').all(),
    publication: publicationState(db),
    redirects: redirects(),
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all()
  }
}

/** Every taxonomy redirect as `<kind> <slug> -> <kind> <slug>`. */
function redirects(): string[] {
  return (
    db
      .prepare(
        `SELECT r.source_kind || ' ' || r.source_slug || ' -> ' || r.target_kind ||
          COALESCE(' ' || COALESCE(c.slug, t.slug, b.slug), '') AS redirect
        FROM taxonomy_redirects r LEFT JOIN categories c ON c.id = r.target_category_id
        LEFT JOIN tags t ON t.id = r.target_tag_id LEFT JOIN best_pages b ON b.id = r.target_best_page_id
        ORDER BY 1`
      )
      .all() as Array<{ redirect: string }>
  ).map(row => row.redirect)
}

function row(table: string, slug: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).get(slug) as
    | Record<string, unknown>
    | undefined
}

const page = {
  category: null,
  heading: 'Best Boards',
  intro: 'Boards.',
  keyword: 'best boards',
  keywordCheckedAt: null,
  keywordVolume: null,
  listSize: 10,
  order: 0,
  tag: 'whiteboards',
  title: 'Best Boards'
}

beforeEach(() => {
  db = planDatabase()
  seedTags(db)
})

describe('admin taxonomy plans (#405)', () => {
  it('publishes each decision: a new catalog version and a run under the admin', () => {
    apply({
      action: 'category-create',
      category: { description: 'Audio tools.', name: 'Audio', order: 3, slug: 'audio' }
    })
    expect(row('categories', 'audio')).toMatchObject({
      description: 'Audio tools.',
      is_active: 1,
      name: 'Audio',
      sort_order: 3
    })
    expect(publicationState(db).version).toBe(2)
    expect(
      db
        .prepare(
          "SELECT actor, workflow, outcome FROM publication_runs WHERE manifest_id = 'admin-v2'"
        )
        .get()
    ).toEqual({ actor: 'reviewer', outcome: 'succeeded', workflow: 'test/plans' })
  })

  it('refuses a stale publication, and an empty decision', () => {
    const stale = buildTaxonomyPlans({
      operations: [
        {
          action: 'category-create',
          category: { description: '', name: 'Audio', order: 0, slug: 'audio' }
        }
      ],
      publication: publication('admin', { version: 7 })
    })
    expect(() => execute(db, stale)).toThrow(/malformed JSON/u)
    expect(row('categories', 'audio')).toBeUndefined()
    expect(() => buildTaxonomyPlans({ operations: [], publication: publication('admin') })).toThrow(
      /needs an operation/u
    )
  })

  describe('categories', () => {
    it('refuses a slug any category has, active or retired', () => {
      for (const slug of ['tools', 'hub-narrow'])
        refused(`category-create ${slug}: a category has this slug, active or retired`, {
          action: 'category-create',
          category: { description: '', name: 'Again', order: 0, slug }
        })
    })

    it('edits a category compared with what the admin saw', () => {
      const expected = { description: 'Tools', name: 'Tools', order: 0 }
      apply({
        action: 'category-edit',
        category: { description: 'All tools.', name: 'Toolbox', order: 4 },
        expected,
        slug: 'tools'
      })
      expect(row('categories', 'tools')).toMatchObject({
        description: 'All tools.',
        name: 'Toolbox',
        sort_order: 4
      })
      refused('category-edit tools: the category is missing, retired, or not as expected', {
        action: 'category-edit',
        category: { description: 'x', name: 'x', order: 0 },
        expected,
        slug: 'tools'
      })
    })

    it('renames a category: its listings follow, and its old URL redirects to it', () => {
      seedLiveListing(db, 'lst_live')
      apply({ action: 'taxonomy-rename', kind: 'category', slug: 'tools', to: 'toolbox' })
      expect(row('categories', 'tools')).toBeUndefined()
      expect(
        db
          .prepare(
            `SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
            WHERE lc.listing_id = 'lst_live'`
          )
          .get()
      ).toEqual({ slug: 'toolbox' })
      expect(redirects()).toContain('category tools -> category toolbox')
      // Renamed back: the old redirect would point at itself, so it goes; the reverse is added.
      apply({ action: 'taxonomy-rename', kind: 'category', slug: 'toolbox', to: 'tools' })
      expect(redirects()).toContain('category toolbox -> category tools')
      expect(redirects()).not.toContain('category tools -> category toolbox')
    })

    it('refuses a rename to a slug any category has, or whose URL already redirects', () => {
      refused('category-rename tools: a category has the new slug, active or retired', {
        action: 'taxonomy-rename',
        kind: 'category',
        slug: 'tools',
        to: 'hub-narrow'
      })
      db.exec("UPDATE categories SET slug = 'gone' WHERE slug = 'hub-narrow'")
      refused('category-rename tools: the new URL already redirects elsewhere', {
        action: 'taxonomy-rename',
        kind: 'category',
        slug: 'tools',
        to: 'hub-narrow'
      })
      refused('category-rename nope: no active category has this slug', {
        action: 'taxonomy-rename',
        kind: 'category',
        slug: 'nope',
        to: 'fresh'
      })
    })

    it('retires a category with its redirect, re-pointing the redirects aimed at it', () => {
      db.exec("UPDATE tags SET is_active = 0 WHERE slug IN ('whiteboards', 'chatbots')")
      db.exec("UPDATE best_pages SET is_active = 0 WHERE slug = 'best-boards'")
      apply({ action: 'category-retire', redirect: { kind: 'directory' }, slug: 'apps' })
      expect(row('categories', 'apps')).toMatchObject({ is_active: 0 })
      expect(redirects()).toEqual(
        expect.arrayContaining(['category apps -> directory', 'category hub-narrow -> directory'])
      )
    })

    it('refuses a retirement that would strand a live listing, a tag, or a best page', () => {
      seedLiveListing(db, 'lst_live', { categories: ['apps'] })
      const retire = (redirect: TaxonomyOperation & { action: 'category-retire' }) => redirect
      refused(
        'category-retire apps: an active tag is filed under it',
        retire({ action: 'category-retire', redirect: { kind: 'directory' }, slug: 'apps' })
      )
      db.exec("UPDATE tags SET is_active = 0 WHERE slug IN ('whiteboards', 'chatbots')")
      db.exec(
        "UPDATE best_pages SET category_id = (SELECT id FROM categories WHERE slug = 'apps') WHERE slug = 'best-boards'"
      )
      refused(
        'category-retire apps: an active best page draws on it',
        retire({ action: 'category-retire', redirect: { kind: 'directory' }, slug: 'apps' })
      )
      db.exec("UPDATE best_pages SET is_active = 0 WHERE slug = 'best-boards'")
      refused(
        'category-retire apps: a live listing is filed under it',
        retire({ action: 'category-retire', redirect: { kind: 'directory' }, slug: 'apps' })
      )
      db.exec("UPDATE listings SET is_active = 0 WHERE id = 'lst_live'")
      db.exec(
        `INSERT INTO listing_slug_redirects (listing_id, old_slug, new_slug, manifest_id, reason)
          VALUES ('lst_live', 'lst_live.example', 'other.example', 'fixture', 'duplicate')`
      )
      refused(
        'category-unpublish apps: a listing filed under it is the source of a slug redirect; re-file that listing first',
        retire({ action: 'category-retire', redirect: { kind: 'directory' }, slug: 'apps' })
      )
    })

    it('refuses a retired or chained redirect target', () => {
      db.exec("UPDATE tags SET is_active = 0 WHERE slug IN ('whiteboards', 'chatbots')")
      db.exec("UPDATE best_pages SET is_active = 0 WHERE slug = 'best-boards'")
      refused(
        'category-retire apps: the redirect target category hub-narrow is missing or retired',
        {
          action: 'category-retire',
          redirect: { kind: 'category', slug: 'hub-narrow' },
          slug: 'apps'
        }
      )
      db.exec(
        `INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, manifest_id)
          VALUES ('tag', 'note-taking', 'directory', 'fixture')`
      )
      refused(
        'category-retire apps: the redirect target itself redirects elsewhere; this would make a chain',
        { action: 'category-retire', redirect: { kind: 'tag', slug: 'note-taking' }, slug: 'apps' }
      )
    })
  })

  describe('tags', () => {
    it('creates, edits, and moves a tag to another hub', () => {
      apply({
        action: 'tag-create',
        tag: { category: 'tools', description: '', name: 'Mind maps', order: 0, slug: 'mind-maps' }
      })
      apply({
        action: 'tag-update',
        expected: { category: 'tools', description: '', name: 'Mind maps' },
        slug: 'mind-maps',
        tag: { category: 'apps', description: 'Maps of ideas.', name: 'Mind Maps', order: 0 }
      })
      expect(
        db
          .prepare(
            `SELECT t.name, t.description, c.slug AS hub FROM tags t
            JOIN categories c ON c.id = t.category_id WHERE t.slug = 'mind-maps'`
          )
          .get()
      ).toEqual({ description: 'Maps of ideas.', hub: 'apps', name: 'Mind Maps' })
      refused('tag-create mind-maps: a tag has this slug, active or retired', {
        action: 'tag-create',
        tag: { category: 'tools', description: '', name: 'Again', order: 0, slug: 'mind-maps' }
      })
      refused('tag-create fresh: the category hub-narrow is missing or retired', {
        action: 'tag-create',
        tag: { category: 'hub-narrow', description: '', name: 'Fresh', order: 0, slug: 'fresh' }
      })
    })

    it('renames a tag: best pages and redirects follow its id, and its old URL redirects', () => {
      apply({ action: 'taxonomy-rename', kind: 'tag', slug: 'whiteboards', to: 'boards' })
      expect(
        db
          .prepare(
            "SELECT t.slug FROM best_pages b JOIN tags t ON t.id = b.tag_id WHERE b.slug = 'best-boards'"
          )
          .get()
      ).toEqual({ slug: 'boards' })
      expect(redirects()).toContain('tag whiteboards -> tag boards')
    })

    it('keeps a redirect the old URL already had, as it would once the tag emptied', () => {
      db.exec(
        `INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_best_page_id,
          manifest_id) SELECT 'tag', 'whiteboards', 'best', id, 'fixture' FROM best_pages
          WHERE slug = 'best-boards'`
      )
      apply({ action: 'taxonomy-rename', kind: 'tag', slug: 'whiteboards', to: 'boards' })
      expect(redirects()).toContain('tag whiteboards -> best best-boards')
      expect(redirects()).not.toContain('tag whiteboards -> tag boards')
    })

    it('retires a tag with its redirect, but not while a best page ranks it', () => {
      refused('tag-unpublish whiteboards: an active best page uses the tag', {
        action: 'tag-unpublish',
        redirect: { kind: 'category', slug: 'apps' },
        slug: 'whiteboards'
      })
      apply({
        action: 'tag-unpublish',
        redirect: { kind: 'category', slug: 'tools' },
        slug: 'note-taking'
      })
      expect(row('tags', 'note-taking')).toMatchObject({ is_active: 0 })
      // The merged narrow category that pointed at it now points where it went.
      expect(redirects()).toEqual(
        expect.arrayContaining([
          'category merged-narrow -> category tools',
          'tag note-taking -> category tools'
        ])
      )
    })
  })

  describe('best pages', () => {
    it('creates a best page with its pins in one batch, then edits and re-pins it', () => {
      seedLiveListing(db, 'lst_a')
      seedLiveListing(db, 'lst_b')
      const pins = [
        { id: 'lst_a', slug: 'lst_a.example' },
        { id: 'lst_b', slug: 'lst_b.example' }
      ]
      apply(
        { action: 'best-page-create', page: { ...page, slug: 'note-apps', tag: 'note-taking' } },
        {
          action: 'best-page-listings-set',
          exclude: [],
          expected: { exclude: [], pins: [] },
          pins,
          slug: 'note-apps'
        }
      )
      expect(
        db
          .prepare(
            `SELECT p.listing_id, p.position FROM best_page_listings p JOIN best_pages b
            ON b.id = p.best_page_id WHERE b.slug = 'note-apps' ORDER BY p.position`
          )
          .all()
      ).toEqual([
        { listing_id: 'lst_a', position: 1 },
        { listing_id: 'lst_b', position: 2 }
      ])
      const expected = { ...page, tag: 'note-taking' }
      apply({
        action: 'best-page-update',
        expected,
        page: { ...expected, heading: 'Best Note Apps', title: 'Best Note Apps' },
        slug: 'note-apps'
      })
      expect(row('best_pages', 'note-apps')).toMatchObject({
        heading: 'Best Note Apps',
        title: 'Best Note Apps'
      })
      apply({
        action: 'best-page-listings-set',
        exclude: [],
        expected: { exclude: [], pins },
        pins: [pins[1] as (typeof pins)[number]],
        slug: 'note-apps'
      })
      expect(count(db, 'SELECT COUNT(*) AS count FROM best_page_listings')).toBe(1)
      refused(
        'best-page-listings-set note-apps: its pins and exclusions are not the expected ones',
        {
          action: 'best-page-listings-set',
          exclude: [],
          expected: { exclude: [], pins },
          pins: [],
          slug: 'note-apps'
        }
      )
    })

    it('refuses a best page on a retired tag', () => {
      refused('best-page-create fresh: the tag retired-tag is missing or retired', {
        action: 'best-page-create',
        page: { ...page, slug: 'fresh', tag: 'retired-tag' }
      })
    })

    it('renames a best page: the redirects aimed at it follow, and its old URL redirects', () => {
      apply({ action: 'taxonomy-rename', kind: 'best', slug: 'best-boards', to: 'board-apps' })
      expect(redirects()).toEqual(
        expect.arrayContaining([
          'best best-boards -> best board-apps',
          'category best-narrow -> best board-apps'
        ])
      )
    })

    it('retires a best page to its tag; the tag can retire after it', () => {
      apply({
        action: 'best-page-unpublish',
        redirect: { kind: 'tag', slug: 'whiteboards' },
        slug: 'best-boards'
      })
      expect(redirects()).toEqual(
        expect.arrayContaining([
          'best best-boards -> tag whiteboards',
          'category best-narrow -> tag whiteboards'
        ])
      )
      apply({
        action: 'tag-unpublish',
        redirect: { kind: 'category', slug: 'apps' },
        slug: 'whiteboards'
      })
      expect(redirects()).toEqual(
        expect.arrayContaining([
          'best best-boards -> category apps',
          'category best-narrow -> category apps',
          'tag whiteboards -> category apps'
        ])
      )
    })
  })

  it('reads an item, what its refusals count, its redirect, and the publication state', () => {
    seedLiveListing(db, 'lst_live', { categories: ['apps'] })
    const [state] = query(db, selectTaxonomyStatePlan('category', 'apps')) as Array<{
      item: string
      publication_checksum: string
      redirect: string | null
      version: number
    }>
    expect(state).toMatchObject({ publication_checksum: 'before', redirect: null, version: 1 })
    expect(JSON.parse(state?.item ?? 'null')).toEqual({
      active: 1,
      activeBestPages: 0,
      activeTags: 2,
      description: 'Apps',
      liveListings: 1,
      name: 'Apps',
      order: 1,
      redirectSources: 0,
      slug: 'apps'
    })
    const [narrow] = query(db, selectTaxonomyStatePlan('category', 'hub-narrow')) as Array<{
      redirect: string
    }>
    expect(JSON.parse(narrow?.redirect ?? 'null')).toEqual(['category', 'apps'])
    const [best] = query(db, selectTaxonomyStatePlan('best', 'best-boards')) as Array<{
      item: string
    }>
    expect(JSON.parse(best?.item ?? 'null')).toMatchObject({
      active: 1,
      exclude: [],
      pins: [],
      tag: 'whiteboards'
    })
    const [missing] = query(db, selectTaxonomyStatePlan('tag', 'nope')) as Array<{ item: null }>
    expect(missing?.item).toBeNull()
  })
})
