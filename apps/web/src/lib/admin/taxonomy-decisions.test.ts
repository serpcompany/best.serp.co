/**
 * The admin's taxonomy decisions (#405) on node:sqlite with the checked-in migrations: each
 * create, edit, rename, and retirement publishes once and answers its replay as a no-op, a stale
 * view answers 409, invalid input 422, and a retirement that would strand a live listing, a tag,
 * or a best page is refused with nothing written; a best page's pins come from its live pool,
 * never a feature of a larger site.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDatabase } from '@/db/client'
import { insertPublishedListing, SqliteD1 } from '@/db/test-support'
import type { AdminContext } from './decisions'
import {
  createBestPage,
  createCategory,
  createTag,
  retireBestPage,
  retireCategory,
  retireTag,
  setBestPagePins,
  updateBestPage,
  updateCategory,
  updateTag
} from './taxonomy-decisions'

const NOW = new Date('2026-10-12T12:00:00.000Z')
/** A listing D1 marks as a feature of a larger site (#409: `is_feature_listing`). */
const FEATURE_ID = 'lst_feature'

function fixture() {
  const sqlite = new SqliteD1()
  const db = sqlite.database
  db.exec(`
    INSERT INTO categories (slug, name, description, sort_order)
      VALUES ('tools', 'Tools', 'All tools.', 0), ('apps', 'Apps', '', 1);
    INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'before');
    INSERT INTO tags (slug, name, category_id, sort_order) VALUES
      ('note-taking', 'Note Taking', 1, 0), ('whiteboards', 'Whiteboards', 2, 0);
  `)
  const listing = (id: string, slug: string, category = 1) =>
    insertPublishedListing(db, {
      categoryIds: [category],
      content: 'Content',
      description: `${slug} description`,
      displayOrder: 0,
      id,
      isFeatured: false,
      name: `Name ${slug}`,
      publishedAt: '2026-05-16',
      slug,
      website: `https://${slug}/`
    })
  const tag = (listingId: string, tagSlug: string) =>
    db.exec(`INSERT INTO listing_tags (listing_id, tag_id, sort_order)
      SELECT '${listingId}', id, 0 FROM tags WHERE slug = '${tagSlug}'`)
  const context = (overrides: Partial<AdminContext> = {}): AdminContext => ({
    actor: 'devin@serp.co',
    client: createDatabase(sqlite.asD1Database()),
    eventKey: (event, ...ids) => [event, ...ids].join(':'),
    notify: vi.fn(async () => undefined) as AdminContext['notify'],
    now: () => NOW,
    ...overrides
  })
  const row = (sql: string, ...params: string[]) =>
    db.prepare(sql).get(...params) as Record<string, unknown> | undefined
  const version = () => Number(row('SELECT version FROM publication_state')?.version)
  const redirects = () =>
    (
      db
        .prepare(
          `SELECT r.source_kind || ' ' || r.source_slug || ' -> ' || r.target_kind ||
            COALESCE(' ' || COALESCE(c.slug, t.slug, b.slug), '') AS redirect
          FROM taxonomy_redirects r LEFT JOIN categories c ON c.id = r.target_category_id
          LEFT JOIN tags t ON t.id = r.target_tag_id
          LEFT JOIN best_pages b ON b.id = r.target_best_page_id ORDER BY 1`
        )
        .all() as Array<{ redirect: string }>
    ).map(entry => entry.redirect)
  /** A client whose first write batch loses the race for the publication version. */
  const racingClient = () => {
    const d1 = sqlite.asD1Database()
    const sqlOf = new WeakMap<object, string>()
    const prepare = d1.prepare.bind(d1)
    d1.prepare = sql => {
      const statement = prepare(sql)
      sqlOf.set(statement, sql)
      return statement
    }
    const batch = d1.batch.bind(d1)
    let left = 1
    d1.batch = async statements => {
      if (
        left > 0 &&
        statements.some(statement => /^\s*(?:INSERT|UPDATE)\b/iu.test(sqlOf.get(statement) ?? ''))
      ) {
        left -= 1
        db.exec("UPDATE publication_state SET version = version + 1, checksum = 'elsewhere'")
      }
      return batch(statements)
    }
    return createDatabase(d1)
  }
  return { context, db, listing, racingClient, redirects, row, tag, version }
}

const audio = { description: 'Sound.', name: 'Audio', order: 2, slug: 'audio' }

describe('category decisions', () => {
  it('creates a category once, under the admin, and answers its replay', async () => {
    const { context, row, version } = fixture()
    expect(await createCategory(context(), { ...audio, name: '  Audio  ' })).toEqual({
      ok: true,
      replayed: false,
      slug: 'audio'
    })
    expect(
      row("SELECT name, description, sort_order, is_active FROM categories WHERE slug = 'audio'")
    ).toEqual({ description: 'Sound.', is_active: 1, name: 'Audio', sort_order: 2 })
    expect(version()).toBe(2)
    expect(
      row(
        "SELECT actor, workflow, outcome FROM publication_runs WHERE manifest_id = 'category-create-audio-v2'"
      )
    ).toEqual({ actor: 'devin@serp.co', outcome: 'succeeded', workflow: 'app/admin' })
    expect(await createCategory(context(), audio)).toMatchObject({ ok: true, replayed: true })
    expect(await createCategory(context(), { ...audio, name: 'Other' })).toMatchObject({
      error: 'slug_taken',
      status: 422
    })
    expect(version()).toBe(2)
  })

  it('refuses invalid fields with nothing written', async () => {
    const { context, version } = fixture()
    for (const [fields, error] of [
      [{ ...audio, slug: 'Audio Tools' }, 'invalid_slug'],
      [{ ...audio, slug: '-audio' }, 'invalid_slug'],
      [{ ...audio, name: ' ' }, 'invalid_field'],
      [{ ...audio, description: 'x'.repeat(501) }, 'invalid_field'],
      [{ ...audio, order: -1 }, 'invalid_field'],
      [{ ...audio, order: 1.5 }, 'invalid_field']
    ] as const) {
      expect(await createCategory(context(), fields), JSON.stringify(fields)).toMatchObject({
        error,
        status: 422
      })
    }
    expect(version()).toBe(1)
  })

  it('edits and renames a category; its old URL redirects to it, and a replay is a no-op', async () => {
    const { context, redirects, row } = fixture()
    const expected = { description: 'All tools.', name: 'Tools', order: 0, slug: 'tools' }
    const category = { description: 'Every tool.', name: 'Toolbox', order: 4, slug: 'toolbox' }
    expect(await updateCategory(context(), { category, expected, slug: 'tools' })).toEqual({
      ok: true,
      replayed: false,
      slug: 'toolbox'
    })
    expect(
      row("SELECT name, description, sort_order FROM categories WHERE slug = 'toolbox'")
    ).toEqual({ description: 'Every tool.', name: 'Toolbox', sort_order: 4 })
    expect(redirects()).toEqual(['category tools -> category toolbox'])
    expect(await updateCategory(context(), { category, expected, slug: 'tools' })).toMatchObject({
      replayed: true
    })
    // A view from before the rename is stale.
    expect(
      await updateCategory(context(), {
        category: { ...category, name: 'Other' },
        expected,
        slug: 'toolbox'
      })
    ).toMatchObject({ error: 'conflict', status: 409 })
  })

  it('refuses a rename to a taken slug or one whose URL redirects elsewhere', async () => {
    const { context, db } = fixture()
    const expected = { description: 'All tools.', name: 'Tools', order: 0, slug: 'tools' }
    expect(
      await updateCategory(context(), {
        category: { ...expected, slug: 'apps' },
        expected,
        slug: 'tools'
      })
    ).toMatchObject({ error: 'slug_taken', status: 422 })
    db.exec(`INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, manifest_id)
      VALUES ('category', 'old-hub', 'directory', 'fixture')`)
    expect(
      await updateCategory(context(), {
        category: { ...expected, slug: 'old-hub' },
        expected,
        slug: 'tools'
      })
    ).toMatchObject({ error: 'slug_redirects', status: 422 })
    expect(await createCategory(context(), { ...audio, slug: 'old-hub' })).toMatchObject({
      error: 'slug_redirects'
    })
  })

  it('refuses a retirement that would strand a listing, live or unpublished, a tag, or a best page', async () => {
    const { context, db, listing, row, version } = fixture()
    listing('lst_live', 'live.example', 2)
    const retire = () =>
      retireCategory(context(), { redirect: { kind: 'directory' }, slug: 'apps' })
    expect(await retire()).toMatchObject({ error: 'category_has_listings', status: 409 })
    db.exec("UPDATE listings SET is_active = 0 WHERE id = 'lst_live'")
    expect(await retire()).toMatchObject({ error: 'category_has_tags', status: 409 })
    db.exec("UPDATE tags SET category_id = 1 WHERE slug = 'whiteboards'")
    db.exec(`INSERT INTO best_pages (slug, keyword, title, heading, intro, category_id)
      VALUES ('best-apps', 'apps', 'Best Apps', 'Best Apps', 'Apps.', 2)`)
    expect(await retire()).toMatchObject({ error: 'category_has_best_pages', status: 409 })
    db.exec("UPDATE best_pages SET is_active = 0 WHERE slug = 'best-apps'")
    // Its unpublished listing answers 410; retired, the category would make that a 404 (#260).
    expect(await retire()).toMatchObject({ error: 'category_has_unpublished', status: 409 })
    expect(row("SELECT is_active FROM categories WHERE slug = 'apps'")).toEqual({ is_active: 1 })
    expect(version()).toBe(1)
    // Filed under the other category instead, it no longer holds this one back.
    db.exec("UPDATE listing_categories SET category_id = 1 WHERE listing_id = 'lst_live'")
    expect(await retire()).toMatchObject({ ok: true, replayed: false })
  })

  it('retires a category with its redirect, re-pointing those aimed at it; a replay is a no-op', async () => {
    const { context, db, listing, redirects } = fixture()
    listing('lst_t', 't.example')
    db.exec(`
      UPDATE tags SET category_id = 1 WHERE slug = 'whiteboards';
      INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, target_category_id,
        manifest_id) VALUES ('category', 'old-apps', 'category', 2, 'fixture');
    `)
    const input = { redirect: { kind: 'category', slug: 'tools' } as const, slug: 'apps' }
    expect(await retireCategory(context(), input)).toEqual({
      ok: true,
      replayed: false,
      slug: 'apps'
    })
    expect(redirects()).toEqual([
      'category apps -> category tools',
      'category old-apps -> category tools'
    ])
    expect(await retireCategory(context(), input)).toMatchObject({ replayed: true })
    expect(
      await retireCategory(context(), { redirect: { kind: 'directory' }, slug: 'apps' })
    ).toMatchObject({ error: 'conflict', status: 409 })
  })

  it('refuses a redirect to itself, a retired or empty page, or one whose URL redirects elsewhere', async () => {
    const { context, db, listing, tag } = fixture()
    db.exec("UPDATE tags SET category_id = 1 WHERE slug = 'whiteboards'")
    const retire = (redirect: Parameters<typeof retireCategory>[1]['redirect']) =>
      retireCategory(context(), { redirect, slug: 'apps' })
    expect(await retire({ kind: 'category', slug: 'apps' })).toMatchObject({
      error: 'invalid_redirect'
    })
    expect(await retire({ kind: 'tag', slug: 'nope' })).toMatchObject({ error: 'invalid_redirect' })
    // An active page with nothing to show: a redirect is followed only to a page that renders.
    expect(await retire({ kind: 'category', slug: 'tools' })).toMatchObject({
      error: 'redirect_empty',
      status: 422
    })
    listing('lst_t', 't.example')
    tag('lst_t', 'note-taking')
    db.exec(`INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind, manifest_id)
      VALUES ('tag', 'note-taking', 'directory', 'fixture')`)
    expect(await retire({ kind: 'tag', slug: 'note-taking' })).toMatchObject({
      error: 'redirect_chain',
      status: 422
    })
  })
})

describe('tag decisions', () => {
  const maps = { category: 'tools', description: '', name: 'Mind Maps', slug: 'mind-maps' }

  it('creates a tag under an active category, and answers its replay', async () => {
    const { context, db, row } = fixture()
    db.exec("INSERT INTO categories (slug, name, is_active) VALUES ('gone', 'Gone', 0)")
    expect(await createTag(context(), { ...maps, category: 'gone' })).toMatchObject({
      error: 'invalid_category',
      status: 422
    })
    expect(await createTag(context(), maps)).toEqual({
      ok: true,
      replayed: false,
      slug: 'mind-maps'
    })
    expect(
      row(`SELECT t.name, c.slug AS hub FROM tags t JOIN categories c ON c.id = t.category_id
        WHERE t.slug = 'mind-maps'`)
    ).toEqual({ hub: 'tools', name: 'Mind Maps' })
    expect(await createTag(context(), maps)).toMatchObject({ replayed: true })
    expect(await createTag(context(), { ...maps, name: 'Other' })).toMatchObject({
      error: 'slug_taken'
    })
  })

  it('moves and renames a tag; its listings keep it, and its old URL redirects', async () => {
    const { context, listing, redirects, row, tag } = fixture()
    listing('lst_a', 'a.example')
    tag('lst_a', 'note-taking')
    const expected = {
      category: 'tools',
      description: '',
      name: 'Note Taking',
      slug: 'note-taking'
    }
    const next = { category: 'apps', description: 'Notes.', name: 'Notes', slug: 'notes' }
    expect(await updateTag(context(), { expected, slug: 'note-taking', tag: next })).toEqual({
      ok: true,
      replayed: false,
      slug: 'notes'
    })
    expect(
      row(`SELECT t.slug, t.name, c.slug AS hub FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
        JOIN categories c ON c.id = t.category_id WHERE lt.listing_id = 'lst_a'`)
    ).toEqual({ hub: 'apps', name: 'Notes', slug: 'notes' })
    expect(redirects()).toEqual(['tag note-taking -> tag notes'])
    expect(await updateTag(context(), { expected, slug: 'note-taking', tag: next })).toMatchObject({
      replayed: true
    })
  })

  it('retires a tag to its category, but not while a best page ranks it', async () => {
    const { context, db, listing, redirects } = fixture()
    listing('lst_t', 't.example')
    db.exec(`INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id)
      SELECT 'best-notes', 'notes', 'Best Notes', 'Best Notes', 'Notes.', id FROM tags
      WHERE slug = 'note-taking'`)
    const input = { redirect: { kind: 'category', slug: 'tools' } as const, slug: 'note-taking' }
    expect(await retireTag(context(), input)).toMatchObject({
      error: 'tag_has_best_pages',
      status: 409
    })
    db.exec("UPDATE best_pages SET is_active = 0 WHERE slug = 'best-notes'")
    expect(await retireTag(context(), input)).toMatchObject({ ok: true, replayed: false })
    expect(redirects()).toEqual(['tag note-taking -> category tools'])
    expect(await retireTag(context(), input)).toMatchObject({ replayed: true })
  })

  it('runs once more when another publication won the race', async () => {
    const { context, racingClient, row } = fixture()
    expect(await createTag(context({ client: racingClient() }), maps)).toMatchObject({
      ok: true,
      replayed: false
    })
    expect(row("SELECT is_active FROM tags WHERE slug = 'mind-maps'")).toEqual({ is_active: 1 })
  })
})

describe('best page decisions', () => {
  const fields = {
    intro: 'Note apps.',
    keyword: 'note app',
    slug: 'note-app',
    tag: 'note-taking',
    title: 'Best Note Apps'
  }

  it('creates a best page on an active tag, with the title as its H1', async () => {
    const { context, row } = fixture()
    expect(await createBestPage(context(), { ...fields, tag: 'nope' })).toMatchObject({
      error: 'invalid_tag',
      status: 422
    })
    expect(await createBestPage(context(), { ...fields, intro: '' })).toMatchObject({
      error: 'invalid_field'
    })
    expect(await createBestPage(context(), fields)).toEqual({
      ok: true,
      replayed: false,
      slug: 'note-app'
    })
    expect(
      row(`SELECT b.keyword, b.title, b.heading, b.list_size, t.slug AS tag FROM best_pages b
        JOIN tags t ON t.id = b.tag_id WHERE b.slug = 'note-app'`)
    ).toEqual({
      heading: 'Best Note Apps',
      keyword: 'note app',
      list_size: 10,
      tag: 'note-taking',
      title: 'Best Note Apps'
    })
    expect(await createBestPage(context(), fields)).toMatchObject({ replayed: true })
  })

  it('edits and renames a best page: the H1 follows the title unless it was set apart', async () => {
    const { context, db, redirects, row } = fixture()
    await createBestPage(context(), fields)
    const next = { ...fields, slug: 'note-apps', tag: 'whiteboards', title: 'Top Note Apps' }
    expect(
      await updateBestPage(context(), { expected: fields, page: next, slug: 'note-app' })
    ).toMatchObject({ ok: true, replayed: false, slug: 'note-apps' })
    expect(row("SELECT title, heading FROM best_pages WHERE slug = 'note-apps'")).toEqual({
      heading: 'Top Note Apps',
      title: 'Top Note Apps'
    })
    expect(redirects()).toEqual(['best note-app -> best note-apps'])
    db.exec("UPDATE best_pages SET heading = 'Note apps, ranked' WHERE slug = 'note-apps'")
    await updateBestPage(context(), {
      expected: next,
      page: { ...next, title: 'Note Apps' },
      slug: 'note-apps'
    })
    expect(row("SELECT title, heading FROM best_pages WHERE slug = 'note-apps'")).toEqual({
      heading: 'Note apps, ranked',
      title: 'Note Apps'
    })
  })

  it('changes its tag only while every pin carries the new one', async () => {
    const { context, listing, row, tag } = fixture()
    await createBestPage(context(), fields)
    listing('lst_a', 'a.example')
    tag('lst_a', 'note-taking')
    expect(
      await setBestPagePins(context(), {
        expectedPins: [],
        pins: [{ id: 'lst_a', slug: 'a.example' }],
        slug: 'note-app'
      })
    ).toMatchObject({ ok: true })
    const retagged = { ...fields, tag: 'whiteboards' }
    // The page would still rank its pin first (pins join the pool), so it's unpinned first.
    expect(
      await updateBestPage(context(), { expected: fields, page: retagged, slug: 'note-app' })
    ).toMatchObject({ error: 'pins_outside_pool', status: 409 })
    expect(
      row(
        `SELECT t.slug FROM best_pages b JOIN tags t ON t.id = b.tag_id WHERE b.slug = 'note-app'`
      )
    ).toEqual({ slug: 'note-taking' })
    tag('lst_a', 'whiteboards')
    expect(
      await updateBestPage(context(), { expected: fields, page: retagged, slug: 'note-app' })
    ).toMatchObject({ ok: true, replayed: false })
  })

  it('edits a best page that ranks a category alone, and pins from that category', async () => {
    const { context, db, listing, row } = fixture()
    // Like the published `video-downloader`: a category and no tag.
    db.exec(`INSERT INTO best_pages (slug, keyword, title, heading, intro, category_id)
      VALUES ('tool', 'tool', 'Best Tools', 'Best Tools', 'Tools.', 1)`)
    listing('lst_t', 't.example')
    const current = { intro: 'Tools.', keyword: 'tool', slug: 'tool', tag: '', title: 'Best Tools' }
    expect(
      await updateBestPage(context(), {
        expected: current,
        page: { ...current, title: 'Top Tools' },
        slug: 'tool'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(
      row("SELECT title, heading, tag_id, category_id FROM best_pages WHERE slug = 'tool'")
    ).toEqual({ category_id: 1, heading: 'Top Tools', tag_id: null, title: 'Top Tools' })
    expect(
      await setBestPagePins(context(), {
        expectedPins: [],
        pins: [{ id: 'lst_t', slug: 't.example' }],
        slug: 'tool'
      })
    ).toMatchObject({ ok: true, replayed: false })
    // A new best page still needs a tag: the form has no category.
    expect(await createBestPage(context(), { ...current, slug: 'fresh', tag: '' })).toMatchObject({
      error: 'invalid_tag',
      status: 422
    })
  })

  it('pins live listings of its pool in order, keeping blurbs, never a feature listing', async () => {
    const { context, db, listing, row, tag, version } = fixture()
    await createBestPage(context(), fields)
    for (const [id, slug] of [
      ['lst_a', 'a.example'],
      ['lst_b', 'b.example'],
      [FEATURE_ID, 'feature.example']
    ] as const) {
      listing(id, slug)
      tag(id, 'note-taking')
    }
    db.exec(`UPDATE listings SET is_feature_listing = 1 WHERE id = '${FEATURE_ID}'`)
    listing('lst_other', 'other.example')
    const a = { id: 'lst_a', slug: 'a.example' }
    const b = { id: 'lst_b', slug: 'b.example' }
    const pin = (pins: Array<{ id: string; slug: string }>, expectedPins: typeof pins = []) =>
      setBestPagePins(context(), { expectedPins, pins, slug: 'note-app' })
    const before = version()
    expect(await pin([{ id: FEATURE_ID, slug: 'feature.example' }])).toMatchObject({
      error: 'feature_listing',
      status: 422
    })
    expect(version()).toBe(before)
    expect(await pin([{ id: 'lst_other', slug: 'other.example' }])).toMatchObject({
      error: 'invalid_pins'
    })
    expect(await pin([a, a])).toMatchObject({ error: 'invalid_pins' })
    expect(await pin([b, a])).toEqual({ ok: true, pins: ['lst_b', 'lst_a'], replayed: false })
    expect(version()).toBe(before + 1)
    expect(await pin([b, a])).toMatchObject({ replayed: true })
    expect(await pin([a], [])).toMatchObject({ error: 'conflict', status: 409 })
    db.exec("UPDATE best_page_listings SET blurb = 'Why A.' WHERE listing_id = 'lst_a'")
    expect(await pin([a], [b, a])).toMatchObject({ ok: true, replayed: false })
    expect(row('SELECT listing_id, position, blurb FROM best_page_listings')).toEqual({
      blurb: 'Why A.',
      listing_id: 'lst_a',
      position: 1
    })
    db.exec("UPDATE best_pages SET list_size = 5 WHERE slug = 'note-app'")
    const many = ['c', 'd', 'e', 'f', 'g', 'h'].map(letter => {
      listing(`lst_${letter}`, `${letter}.example`)
      tag(`lst_${letter}`, 'note-taking')
      return { id: `lst_${letter}`, slug: `${letter}.example` }
    })
    expect(await pin(many, [a])).toMatchObject({
      error: 'invalid_pins',
      message: 'Pin at most 5 listings.'
    })
    // D1's flag decides, not a list of ids: once a manifest clears it, the listing can be pinned.
    db.exec(`UPDATE listings SET is_feature_listing = 0 WHERE id = '${FEATURE_ID}'`)
    expect(await pin([a, { id: FEATURE_ID, slug: 'feature.example' }], [a])).toMatchObject({
      ok: true,
      replayed: false
    })
  })

  it('retires a best page to its tag, which can then retire', async () => {
    const { context, listing, redirects, tag } = fixture()
    listing('lst_a', 'a.example')
    tag('lst_a', 'note-taking')
    await createBestPage(context(), fields)
    expect(
      await retireBestPage(context(), {
        redirect: { kind: 'tag', slug: 'note-taking' },
        slug: 'note-app'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(
      await retireTag(context(), {
        redirect: { kind: 'category', slug: 'tools' },
        slug: 'note-taking'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(redirects()).toEqual([
      'best note-app -> category tools',
      'tag note-taking -> category tools'
    ])
    expect(
      await setBestPagePins(context(), { expectedPins: [], pins: [], slug: 'note-app' })
    ).toMatchObject({ status: 404 })
  })
})
