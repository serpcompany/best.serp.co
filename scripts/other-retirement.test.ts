import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { fixtureSeedStatements } from '../apps/web/e2e/fixture-seed'
import { applyMigrations } from '../apps/web/src/db/test-support'
import { parseManifest } from './d1-publisher.ts'
import { generateScaleCatalog, scaleCatalogStatements } from './fixtures/scale-catalog'
import {
  buildOtherRetirementManifests,
  buildResidueInventory,
  committedRetirementAssignments,
  committedRetirementManifests,
  namedInputManifests,
  otherRetirementDefaults,
  otherRetirementIds,
  otherRetirementInputManifests,
  otherRetirementPaths,
  planOtherRetirement,
  RETIRE_REASONS,
  type ReplayedCatalog,
  type ReplayedListing,
  type ResidueMapping,
  type RetireKind,
  type RetirementInputs,
  type RetirementPlan,
  readReplayedCatalog,
  readRetirementInputs,
  recordedChecks,
  renderInventory,
  replayManifests,
  retireKinds,
  retirementChecks
} from './other-retirement.ts'
import {
  committedTaxonomyManifests,
  STATEMENT_CEILING,
  taxonomyInputManifests
} from './taxonomy-manifest.ts'
import {
  all,
  apply,
  committed,
  GENERATE_TIMEOUT,
  LIVE,
  manifestsBeforeTaxonomy,
  migrate,
  REPLAY_TIMEOUT,
  reviewedCatalogDatabase,
  withCatalogIds,
  withoutTaxonomy
} from './taxonomy-test-support'

const DATE = otherRetirementDefaults.date
const ids = otherRetirementIds(DATE)

// ---------------------------------------------------------------------------------------------
// A small catalog: the catch-all with live and unpublished listings, two hubs, a kept duplicate.

const listing = (
  slug: string,
  categories: string[],
  live = true,
  tags: string[] = []
): ReplayedListing => ({
  id: `lst_${slug.replaceAll('.', '').padEnd(12, 'x')}`,
  slug,
  live,
  categories,
  tags
})
const smallCatalog = (): ReplayedCatalog => {
  const listings = [
    listing('a.ai', ['other']),
    listing('b.ai', ['other']),
    listing('c.ai', ['other']),
    listing('d.ai', ['other']),
    listing('e.ai', ['other'], false),
    listing('f.ai', ['other'], false),
    listing('g.ai', ['other'], false),
    listing('k.ai', ['hub-a'], true, ['tag-a'])
  ]
  return {
    listings: new Map(listings.map(entry => [entry.id, entry])),
    categories: new Map([
      ['other', true],
      ['hub-a', true],
      ['hub-b', true],
      ['adult', false]
    ]),
    tags: new Map([
      ['tag-a', { slug: 'tag-a', hub: 'hub-a', active: true }],
      ['tag-b', { slug: 'tag-b', hub: 'hub-b', active: true }],
      ['tag-old', { slug: 'tag-old', hub: 'hub-b', active: false }]
    ]),
    redirects: new Map(),
    // g.ai's slug redirects to another listing (#338): it must leave Other first.
    slugRedirectSources: new Set([listing('g.ai', []).id])
  }
}
const id = (slug: string) => listing(slug, []).id
const ref = (slug: string) => ({ slug, id: id(slug) })
const smallMapping = (): ResidueMapping => ({
  decidedAt: DATE,
  catchAll: 'other',
  redirect: { kind: 'directory' },
  hubs: { 'hub-a': 2, 'hub-b': 1 },
  tags: { 'tag-a': 2 },
  listings: [
    { ...ref('a.ai'), hub: 'hub-a', tags: ['tag-a'], evidence: 'a' },
    { ...ref('b.ai'), hub: 'hub-b', evidence: 'b' },
    { ...ref('c.ai'), hub: 'hub-b', retire: 'not-a-product', evidence: 'c' },
    { ...ref('d.ai'), hub: 'hub-a', retire: 'duplicate', duplicateOf: ref('k.ai'), evidence: 'd' }
  ],
  unpublished: [
    { ...ref('e.ai'), hub: 'hub-b', basis: 'name' },
    { ...ref('g.ai'), hub: 'hub-a', basis: 'name' }
  ],
  leftInOther: [{ ...ref('f.ai'), reason: 'adult' }]
})
const smallInputs = (
  mapping = smallMapping(),
  catalog = smallCatalog(),
  inReview = new Set<string>()
): RetirementInputs => ({
  mapping,
  catalog,
  websites: new Map(
    [...catalog.listings.values()].map(entry => [entry.id, `https://${entry.slug}/`])
  ),
  inReview
})

describe('the Other retirement generator (#351)', () => {
  it('retires, moves and re-files every listing filed under the catch-all', () => {
    const plan = planOtherRetirement(smallInputs())
    expect(plan.removals.map(removal => [removal.slug, removal.kind, removal.website])).toEqual([
      ['c.ai', 'not-a-product', 'https://c.ai/'],
      ['d.ai', 'duplicate', 'https://d.ai/']
    ])
    expect(plan.moves.map(move => [move.slug, move.live, move.hub, move.tags])).toEqual([
      ['a.ai', true, 'hub-a', ['tag-a']],
      ['b.ai', true, 'hub-b', []],
      // A retirement is re-filed too, without tags, so its 410 stays a 410.
      ['c.ai', false, 'hub-b', []],
      ['d.ai', false, 'hub-a', []],
      // Unpublished listings are re-filed (design 1.5), the slug redirect source among them.
      ['e.ai', false, 'hub-b', []],
      ['g.ai', false, 'hub-a', []]
    ])
    expect(plan.slugRedirects).toEqual([{ from: ref('d.ai'), to: ref('k.ai') }])
    expect(plan.hubCounts).toEqual(
      new Map([
        ['hub-a', 2],
        ['hub-b', 1]
      ])
    )
    expect(plan.tagCounts).toEqual(new Map([['tag-a', 2]]))
  })

  it.each<[string, (mapping: ResidueMapping, catalog: ReplayedCatalog) => void, RegExp]>([
    [
      'a listing it leaves unmapped',
      mapping => {
        mapping.unpublished.pop()
      },
      /g\.ai is filed under other but not mapped/u
    ],
    [
      'a listing named twice',
      mapping => {
        mapping.unpublished.push({ ...ref('e.ai'), hub: 'hub-a', basis: 'name' })
      },
      /e\.ai is named twice/u
    ],
    [
      'a listing not filed under the catch-all',
      mapping => {
        mapping.unpublished.push({ ...ref('k.ai'), hub: 'hub-a', basis: 'name' })
      },
      /k\.ai \(lst_\w+\) is not a listing filed under other/u
    ],
    [
      'the catch-all or a retired category as a hub',
      mapping => {
        mapping.listings[1] = { ...ref('b.ai'), hub: 'other', evidence: 'b' }
        mapping.unpublished[0] = { ...ref('e.ai'), hub: 'adult', basis: 'name' }
      },
      /b\.ai: other is not an active hub[\s\S]*e\.ai: adult is not an active hub/u
    ],
    [
      'a retired tag',
      mapping => {
        mapping.listings[1] = { ...ref('b.ai'), hub: 'hub-b', tags: ['tag-old'], evidence: 'b' }
      },
      /b\.ai: tag-old is not an active tag/u
    ],
    [
      'a live listing listed as unpublished',
      mapping => {
        mapping.listings.splice(1, 1)
        mapping.unpublished.push({ ...ref('b.ai'), hub: 'hub-b', basis: 'name' })
      },
      /b\.ai is listed as unpublished but is live/u
    ],
    [
      'tags on a retirement',
      mapping => {
        mapping.listings[2] = {
          ...ref('c.ai'),
          hub: 'hub-b',
          retire: 'dead',
          tags: ['tag-b'],
          evidence: 'c'
        }
      },
      /c\.ai retires, so it gets no tags/u
    ],
    [
      'a duplicate of a listing that retires too',
      mapping => {
        mapping.listings[3] = {
          ...ref('d.ai'),
          hub: 'hub-a',
          retire: 'duplicate',
          duplicateOf: ref('b.ai'),
          evidence: 'd'
        }
      },
      /d\.ai duplicates b\.ai, which is not a live listing that stays/u
    ],
    [
      'a slug redirect source left in the catch-all',
      mapping => {
        mapping.unpublished.pop()
        mapping.leftInOther?.push({ ...ref('g.ai'), reason: 'x' })
      },
      /g\.ai is a slug redirect source, so other could never retire/u
    ],
    [
      'a count the plan does not reach',
      mapping => {
        mapping.hubs = { 'hub-a': 3 }
      },
      /hub hub-a would hold 2 listings, not 3/u
    ],
    [
      'a tag that gains listings without a count',
      mapping => {
        mapping.tags = {}
      },
      /tag tag-a gains listings but has no count/u
    ],
    [
      'a redirect the catch-all already has',
      (_mapping, catalog) => {
        catalog.redirects.set('category:other', 'directory')
      },
      /other already redirects/u
    ]
  ])('refuses %s', (_name, change, message) => {
    const mapping = smallMapping()
    const catalog = smallCatalog()
    change(mapping, catalog)
    expect(() => planOtherRetirement(smallInputs(mapping, catalog))).toThrow(message)
  })

  it('refuses to change a listing whose own submission is in review, naming it', () => {
    expect(() =>
      planOtherRetirement(smallInputs(smallMapping(), smallCatalog(), new Set([id('b.ai')])))
    ).toThrow(/b\.ai's own submission is in review/u)
  })

  it('writes the phases in publish order, each a row-level manifest the publisher accepts', () => {
    const manifests = buildOtherRetirementManifests(planOtherRetirement(smallInputs()), DATE)
    expect(manifests.map(manifest => manifest.id)).toEqual([ids.removals, ids.move(1), ids.retire])
    const [removals, move, retire] = manifests.map(({ source }) => parseManifest(source))
    expect(removals?.operations).toEqual([
      {
        action: 'listing-unpublish',
        id: id('c.ai'),
        slug: 'c.ai',
        categories: ['other'],
        reason: RETIRE_REASONS['not-a-product'](),
        // A hygiene removal comes down whoever owns it (#340 decision 1).
        expected: { website: 'https://c.ai/' }
      },
      {
        action: 'listing-unpublish',
        id: id('d.ai'),
        slug: 'd.ai',
        categories: ['other'],
        reason: RETIRE_REASONS.duplicate('k.ai'),
        // A duplicate refuses its batch while someone owns it (#332).
        expected: { website: 'https://d.ai/', unowned: true }
      },
      {
        action: 'taxonomy-redirect-set',
        from: { kind: 'category', slug: 'other' },
        expected: null,
        to: { kind: 'directory' }
      }
    ])
    expect(move?.operations.slice(0, 3)).toEqual([
      { action: 'listing-tags-set', id: id('a.ai'), slug: 'a.ai', expected: [], tags: ['tag-a'] },
      {
        action: 'listing-categories-set',
        id: id('a.ai'),
        slug: 'a.ai',
        expected: ['other'],
        categories: ['hub-a']
      },
      {
        action: 'listing-categories-set',
        id: id('b.ai'),
        slug: 'b.ai',
        expected: ['other'],
        categories: ['hub-b']
      }
    ])
    expect(retire?.operations).toEqual([
      {
        action: 'listing-slug-redirect',
        from: ref('d.ai'),
        to: { id: id('k.ai'), slug: 'k.ai' },
        reason: '#351 duplicate of k.ai'
      },
      { action: 'category-unpublish', slug: 'other' }
    ])
    for (const manifest of manifests)
      expect(parseManifest(manifest.source).concurrency).toBe('rows')
    for (const kind of Object.keys(RETIRE_REASONS) as RetireKind[])
      expect(RETIRE_REASONS[kind]('a-much-longer-listing-slug.example').length).toBeLessThan(200)
  })

  it('keeps every listing in its committed batch', () => {
    const plan = planOtherRetirement(smallInputs())
    const manifests = buildOtherRetirementManifests(plan, DATE, new Map([[id('g.ai'), 3]]))
    expect(manifests.map(manifest => manifest.id)).toEqual([
      ids.removals,
      ids.move(3),
      ids.move(4),
      ids.retire
    ])
    expect(
      parseManifest(manifests[1]?.source ?? '').operations.map(operation =>
        'slug' in operation ? operation.slug : ''
      )
    ).toEqual(['g.ai'])
  })

  it('replays manifests the way the publisher guards them', () => {
    const catalog = smallCatalog()
    const manifests = buildOtherRetirementManifests(planOtherRetirement(smallInputs()), DATE)
    replayManifests(
      catalog,
      manifests.map(({ id: name, source }) => ({ name, source }))
    )
    expect(catalog.categories.get('other')).toBe(false)
    expect(catalog.redirects.get('category:other')).toBe('directory')
    // Replaying again refuses: nothing is filed under Other as expected any more.
    expect(() =>
      replayManifests(
        catalog,
        manifests.map(({ id: name, source }) => ({ name, source }))
      )
    ).toThrow(/does not match the replayed catalog/u)
  })
})

// ---------------------------------------------------------------------------------------------
// Replays: the generator's manifests on a database, then #351's invariants.

/** The catalog as this generator takes it, read from a database. */
function replayedCatalogFrom(db: DatabaseSync): RetirementInputs['catalog'] & {
  websites: Map<string, string>
  inReview: Set<string>
} {
  const rows = all<{
    id: string
    slug: string
    website: string
    is_active: number
    categories: string
    tags: string
  }>(
    db,
    `SELECT l.id,l.slug,l.website,l.is_active,
       (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc JOIN categories c
         ON c.id=lc.category_id WHERE lc.listing_id=l.id ORDER BY lc.sort_order, c.slug)) AS categories,
       (SELECT json_group_array(slug) FROM (SELECT t.slug FROM listing_tags lt JOIN tags t
         ON t.id=lt.tag_id WHERE lt.listing_id=l.id ORDER BY lt.sort_order, t.slug)) AS tags
     FROM listings l WHERE l.status='approved'`
  )
  const redirects = all<{ source: string; target: string }>(
    db,
    `SELECT r.source_kind || ':' || r.source_slug AS source, CASE r.target_kind
       WHEN 'directory' THEN 'directory' WHEN 'category' THEN 'category:' || c.slug
       WHEN 'tag' THEN 'tag:' || t.slug ELSE 'best:' || b.slug END AS target
     FROM taxonomy_redirects r LEFT JOIN categories c ON c.id=r.target_category_id
     LEFT JOIN tags t ON t.id=r.target_tag_id LEFT JOIN best_pages b ON b.id=r.target_best_page_id`
  )
  return {
    listings: new Map(
      rows.map(row => [
        row.id,
        {
          id: row.id,
          slug: row.slug,
          live: row.is_active === 1,
          categories: JSON.parse(row.categories) as string[],
          tags: JSON.parse(row.tags) as string[]
        }
      ])
    ),
    categories: new Map(
      all<{ slug: string; is_active: number }>(db, 'SELECT slug,is_active FROM categories').map(
        row => [row.slug, row.is_active === 1]
      )
    ),
    tags: new Map(
      all<{ slug: string; hub: string; is_active: number }>(
        db,
        'SELECT t.slug, c.slug AS hub, t.is_active FROM tags t JOIN categories c ON c.id=t.category_id'
      ).map(row => [row.slug, { slug: row.slug, hub: row.hub, active: row.is_active === 1 }])
    ),
    redirects: new Map(redirects.map(row => [row.source, row.target])),
    slugRedirectSources: new Set(
      all<{ id: string }>(
        db,
        'SELECT l.id FROM listings l JOIN listing_slug_redirects r ON r.old_slug=l.slug'
      ).map(row => row.id)
    ),
    websites: new Map(rows.map(row => [row.id, row.website])),
    inReview: new Set(
      all<{ listing_id: string }>(
        db,
        "SELECT listing_id FROM listing_submissions WHERE status IN ('paid_pending_review','changes_requested') AND listing_id IS NOT NULL"
      ).map(row => row.listing_id)
    )
  }
}

/**
 * A mapping for a synthetic catalog, as the reviewed one is built: every live listing under the
 * catch-all moves to a hub in turn (every third with an active tag of that hub) or, every 23rd,
 * retires, cycling through the hygiene kinds; every unpublished one is re-filed, but, of two or
 * more, the first that isn't a slug redirect source, which stays.
 */
function synthesizeResidue(
  catalog: ReturnType<typeof replayedCatalogFrom>,
  catchAll: string,
  hubs: string[]
): ResidueMapping {
  const residue = [...catalog.listings.values()]
    .filter(entry => entry.categories.includes(catchAll))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1))
  const kinds: RetireKind[] = ['dead', 'not-a-product', 'spam', 'hijacked']
  const unpublished = residue.filter(entry => !entry.live).length
  const tagOf = (hub: string) =>
    [...catalog.tags.values()].find(tag => tag.active && tag.hub === hub)?.slug
  const base: ResidueMapping = {
    decidedAt: DATE,
    catchAll,
    redirect: { kind: 'directory' },
    listings: [],
    unpublished: [],
    leftInOther: []
  }
  residue.forEach((entry, index) => {
    const hub = hubs[index % hubs.length] ?? ''
    if (entry.live) {
      const tag = tagOf(hub)
      base.listings.push(
        index % 23 === 3
          ? {
              slug: entry.slug,
              id: entry.id,
              hub,
              retire: kinds[index % kinds.length],
              evidence: 'x'
            }
          : {
              slug: entry.slug,
              id: entry.id,
              hub,
              ...(index % 3 === 0 && tag ? { tags: [tag] } : {}),
              evidence: 'x'
            }
      )
    } else if (
      unpublished > 1 &&
      base.leftInOther?.length === 0 &&
      !catalog.slugRedirectSources.has(entry.id)
    )
      base.leftInOther.push({ slug: entry.slug, id: entry.id, reason: 'x' })
    else base.unpublished.push({ slug: entry.slug, id: entry.id, hub, basis: 'x' })
  })
  // First pass: what the plan leaves, as the declared counts.
  const first = planOtherRetirement({ mapping: base, catalog, websites: catalog.websites })
  const added = new Set(base.listings.flatMap(entry => entry.tags ?? []))
  return {
    ...base,
    hubs: Object.fromEntries(hubs.map(hub => [hub, first.hubCounts.get(hub) ?? 0])),
    tags: Object.fromEntries([...added].map(tag => [tag, first.tagCounts.get(tag) ?? 0]))
  }
}

/** #351's invariants once every phase is published. */
function expectRetired(db: DatabaseSync, mapping: ResidueMapping, plan: RetirementPlan): void {
  const { catchAll } = mapping
  expect(
    all<{ is_active: number }>(db, 'SELECT is_active FROM categories WHERE slug=?', catchAll)
  ).toEqual([{ is_active: 0 }])
  // Only the listings the mapping leaves there are still filed under the catch-all, unpublished.
  expect(
    all<{ slug: string; is_active: number }>(
      db,
      `SELECT l.slug, l.is_active FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
       JOIN listings l ON l.id=lc.listing_id WHERE c.slug=? AND l.status='approved' ORDER BY l.slug`,
      catchAll
    )
  ).toEqual((mapping.leftInOther ?? []).map(entry => ({ slug: entry.slug, is_active: 0 })))
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
  // Its URL redirects to the directory.
  expect(
    all(
      db,
      "SELECT target_kind FROM taxonomy_redirects WHERE source_kind='category' AND source_slug=?",
      catchAll
    )
  ).toEqual([{ target_kind: mapping.redirect.kind }])
  // Every re-filed listing is under its hub alone, live or unpublished as planned.
  const filed = new Map(
    all<{ id: string; categories: string; is_active: number }>(
      db,
      `SELECT l.id, l.is_active, (SELECT json_group_array(c.slug) FROM listing_categories lc
         JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=l.id) AS categories
       FROM listings l WHERE l.status='approved'`
    ).map(row => [row.id, row])
  )
  for (const move of plan.moves) {
    const row = filed.get(move.id)
    expect(JSON.parse(row?.categories ?? '[]'), move.slug).toEqual([move.hub])
    expect(row?.is_active, move.slug).toBe(move.live ? 1 : 0)
  }
  // Hub and tag counts are the mapping's.
  const hubCounts = new Map(
    all<{ slug: string; count: number }>(
      db,
      `SELECT c.slug, COUNT(*) AS count FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
       JOIN listings l ON l.id=lc.listing_id WHERE ${LIVE} AND lc.is_primary=1 GROUP BY c.slug`
    ).map(row => [row.slug, row.count])
  )
  for (const [hub, count] of Object.entries(mapping.hubs ?? {}))
    expect(hubCounts.get(hub) ?? 0, hub).toBe(count)
  const tagCounts = new Map(
    all<{ slug: string; count: number }>(
      db,
      `SELECT t.slug, COUNT(*) AS count FROM listing_tags lt JOIN tags t ON t.id=lt.tag_id
       JOIN listings l ON l.id=lt.listing_id WHERE ${LIVE} AND t.is_active=1 GROUP BY t.slug`
    ).map(row => [row.slug, row.count])
  )
  for (const [tag, count] of Object.entries(mapping.tags ?? {}))
    expect(tagCounts.get(tag) ?? 0, tag).toBe(count)
  // Each retired duplicate's slug redirects to the listing it duplicates.
  for (const redirect of plan.slugRedirects)
    expect(
      all(db, 'SELECT listing_id FROM listing_slug_redirects WHERE old_slug=?', redirect.from.slug),
      redirect.from.slug
    ).toEqual([{ listing_id: redirect.to.id }])
}

/** Plans the database's catch-all away and publishes every phase in order, checking as it goes. */
function retire(
  db: DatabaseSync,
  catchAll: string,
  hubs: string[]
): { mapping: ResidueMapping; plan: RetirementPlan } {
  const catalog = replayedCatalogFrom(db)
  const mapping = synthesizeResidue(catalog, catchAll, hubs)
  const plan = planOtherRetirement({
    mapping,
    catalog,
    websites: catalog.websites,
    inReview: catalog.inReview
  })
  const checks = retirementChecks(catchAll)
  for (const { id: manifestId, source } of buildOtherRetirementManifests(plan, DATE)) {
    // Retiring early refuses whole, and the owner's check before -03 says why.
    if (manifestId === ids.move(1)) {
      expect(() =>
        apply(
          db,
          ids.retire,
          stringify({
            version: 1,
            id: 'early',
            concurrency: 'rows',
            provenance: { actor: 'test', workflow: 'test' },
            operations: [{ action: 'category-unpublish', slug: catchAll }]
          })
        )
      ).toThrow(/does not apply/u)
      expect(all(db, checks.retire).length).toBeGreaterThan(0)
    }
    if (manifestId === ids.retire) expect(all(db, checks.retire)).toEqual([])
    expect(apply(db, manifestId, source), manifestId).toBeLessThanOrEqual(STATEMENT_CEILING)
  }
  return { mapping, plan }
}

describe('the Other retirement manifests replayed (#351)', () => {
  it(
    'retire a catch-all of the fixture catalog with every invariant holding',
    () => {
      const db = new DatabaseSync(':memory:')
      applyMigrations(db)
      for (const { sql, params } of fixtureSeedStatements()) db.prepare(sql).run(...params)
      withCatalogIds(db)
      // The fixture has no Other: file every third approved listing under a new one, and every
      // unpublished one, as the taxonomy left the reviewed catalog's.
      const catalog = replayedCatalogFrom(db)
      const filed = [...catalog.listings.values()]
        .filter(entry => !catalog.inReview.has(entry.id))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .filter((entry, index) => index % 3 === 0 || !entry.live)
      apply(
        db,
        'setup',
        stringify({
          version: 1,
          id: 'setup',
          concurrency: 'rows',
          provenance: { actor: 'test', workflow: 'test' },
          operations: [
            {
              action: 'category-create',
              category: { slug: 'other', name: 'Other', description: '', order: 99 }
            },
            ...filed.map(entry => ({
              action: 'listing-categories-set',
              id: entry.id,
              slug: entry.slug,
              expected: entry.categories,
              categories: ['other']
            }))
          ]
        })
      )
      const { mapping, plan } = retire(db, 'other', ['design-tools', 'developer-tools'])
      expect(
        plan.moves.some(move => !move.live && plan.removals.every(r => r.id !== move.id))
      ).toBe(true)
      expect(plan.removals.length).toBeGreaterThan(0)
      expectRetired(db, mapping, plan)
    },
    REPLAY_TIMEOUT
  )

  it(
    "retire the scale catalog's Other after its taxonomy migration, every invariant holding",
    () => {
      const db = new DatabaseSync(':memory:')
      db.exec('PRAGMA foreign_keys = ON')
      applyMigrations(db)
      for (const { sql, params } of scaleCatalogStatements(generateScaleCatalog()))
        db.prepare(sql).run(...params)
      withoutTaxonomy(db)
      const taxonomy = migrate(db, {
        catchAll: 'other',
        kept: ['video-downloaders'],
        hubs: 6,
        clustered: 40
      })
      const hubs = taxonomy.mapping.hubs.map(hub => hub.slug)
      const { mapping, plan } = retire(db, 'other', hubs)
      expect(plan.moves.length).toBeGreaterThan(100)
      expectRetired(db, mapping, plan)
    },
    REPLAY_TIMEOUT
  )
})

// ---------------------------------------------------------------------------------------------
// The reviewed catalog: the committed mapping, inventory and manifests.

describe('the committed Other retirement (#351)', () => {
  let inputs: RetirementInputs
  let plan: RetirementPlan
  beforeAll(() => {
    inputs = readRetirementInputs()
    plan = planOtherRetirement(inputs)
  }, GENERATE_TIMEOUT)

  it('maps all 726 listings left in Other: 141 live, 585 unpublished', () => {
    const { mapping } = inputs
    expect(mapping.decidedAt).toBe('2026-10-11')
    expect(mapping.redirect).toEqual({ kind: 'directory' })
    expect(mapping.listings).toHaveLength(141)
    expect(mapping.unpublished).toHaveLength(584)
    expect(mapping.leftInOther?.map(entry => entry.slug)).toEqual(['imgnai.com'])
    expect(plan.removals).toHaveLength(46)
    expect(plan.moves).toHaveLength(725)
    expect(plan.moves.filter(move => move.live)).toHaveLength(95)
    expect(plan.slugRedirects).toEqual([
      {
        from: { id: 'lst_07d139284ae444577f159706', slug: 'notion.com' },
        to: { id: 'lst_4b1393df1ad560e42c9b76e6', slug: 'notion.ai' }
      },
      {
        from: { id: 'lst_d2b096011b7cf4a03641f07a', slug: 'plusdocs.com' },
        to: { id: 'lst_9178db1976b647af0ee6a538', slug: 'plusai.com' }
      }
    ])
    // #337's four duplicates in Other are slug redirect sources: they leave it, or it can't retire.
    const sources = plan.moves.filter(move => inputs.catalog.slugRedirectSources.has(move.id))
    expect(sources.map(move => move.slug)).toEqual([
      'flowrite.com',
      'magical.so',
      'phrasee.co',
      'trajectdata.com'
    ])
    // Every decision has its evidence; only wrong copy and duplicates are `unowned`.
    for (const entry of mapping.listings)
      expect(entry.evidence.length, entry.slug).toBeGreaterThan(20)
    expect(
      Object.fromEntries(
        retireKinds.map(kind => [kind, plan.removals.filter(entry => entry.kind === kind).length])
      )
    ).toEqual({
      dead: 12,
      hijacked: 2,
      'not-a-product': 21,
      spam: 4,
      'wrong-copy': 5,
      duplicate: 2
    })
    const removals = parseManifest(
      readFileSync(resolve(otherRetirementPaths.publications, `${ids.removals}.yaml`), 'utf8')
    ).operations
    for (const removal of plan.removals)
      expect(
        removals.some(
          operation =>
            operation.action === 'listing-unpublish' &&
            operation.id === removal.id &&
            (operation.expected?.unowned === true) ===
              (removal.kind === 'wrong-copy' || removal.kind === 'duplicate')
        ),
        removal.slug
      ).toBe(true)
    // The counts are what the taxonomy left, less the retirements, plus the moves.
    expect([...plan.hubCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(2544 - 46)
    expect(plan.hubCounts.get('other') ?? 0).toBe(0)
  })

  it(
    'keeps the committed manifests identical to what the mapping generates',
    () => {
      const manifests = buildOtherRetirementManifests(plan, DATE, committedRetirementAssignments())
      expect(committedRetirementManifests()).toEqual(
        manifests.map(({ id: manifestId }) => `${manifestId}.yaml`)
      )
      for (const { id: manifestId, source } of manifests)
        expect(
          readFileSync(resolve(otherRetirementPaths.publications, `${manifestId}.yaml`), 'utf8'),
          manifestId
        ).toBe(source)
    },
    GENERATE_TIMEOUT
  )

  it(
    'keeps the committed inventory identical to the replay, with its recorded checks',
    () => {
      const inventory = buildResidueInventory(
        inputs.catalog,
        otherRetirementPaths,
        recordedChecks()
      )
      expect(readFileSync(resolve(otherRetirementPaths.residueInventory), 'utf8')).toBe(
        renderInventory(inventory)
      )
      // Every live listing's website was checked.
      for (const entry of inventory.listings)
        expect(entry.live ? entry.check?.checkedAt : undefined, entry.slug).toBe(
          entry.live ? '2026-10-11' : undefined
        )
    },
    GENERATE_TIMEOUT
  )

  it(
    'replays on the reviewed catalog after the manifests it follows, every invariant holding',
    () => {
      const db = reviewedCatalogDatabase()
      for (const [name, source] of manifestsBeforeTaxonomy()) apply(db, name, source)
      // #349's manifests in file order. #376's downloader links only replace resource links,
      // which the reviewed catalog's inventories don't carry, so the replay leaves them out.
      const taxonomy = committedTaxonomyManifests()
      expect(otherRetirementInputManifests).toEqual([
        ...taxonomy,
        '2026-10-11-downloader-links.yaml'
      ])
      for (const name of taxonomy) apply(db, name, committed(name))
      // The generator's view of the same state: its replay matches the database's.
      const view = replayedCatalogFrom(db)
      for (const [listingId, entry] of view.listings)
        expect(inputs.catalog.listings.get(listingId), entry.slug).toEqual(entry)
      for (const [slug, active] of inputs.catalog.categories)
        expect(view.categories.get(slug), slug).toBe(active)
      // Every website a removal expects is the database's.
      for (const removal of plan.removals)
        expect(view.websites.get(removal.id), removal.slug).toBe(removal.website)

      const checks = retirementChecks(inputs.mapping.catchAll)
      expect(all(db, checks.reviewQueue)).toEqual([])
      expect(all(db, checks.revisions)).toEqual([])
      expect(all(db, checks.inFlight)).toEqual([])
      const names = committedRetirementManifests()
      expect(names[0]).toBe(`${ids.removals}.yaml`)
      expect(names.at(-1)).toBe(`${ids.retire}.yaml`)
      for (const name of names) {
        if (name === `${ids.move(1)}.yaml`) {
          expect(() => apply(db, ids.retire, committed(`${ids.retire}.yaml`))).toThrow(
            /does not apply/u
          )
          expect(all(db, checks.retire).length).toBeGreaterThan(90)
        }
        if (name === `${ids.retire}.yaml`) expect(all(db, checks.retire)).toEqual([])
        expect(apply(db, name, committed(name)), name).toBeLessThanOrEqual(STATEMENT_CEILING)
      }
      expectRetired(db, inputs.mapping, plan)
      // The adult listing left in Other is filed under a retired category: its page answers 404.
      expect(
        all(
          db,
          `SELECT l.slug, l.is_active, c.is_active AS category_active FROM listings l
           JOIN listing_categories lc ON lc.listing_id=l.id JOIN categories c ON c.id=lc.category_id
           WHERE l.slug='imgnai.com'`
        )
      ).toEqual([{ slug: 'imgnai.com', is_active: 0, category_active: 0 }])
      // Nothing it retires or re-files unpublished gains a tag.
      const after = replayedCatalogFrom(db)
      for (const move of plan.moves.filter(entry => !entry.live))
        expect(after.listings.get(move.id)?.tags, move.slug).toEqual(move.expectedTags)
    },
    REPLAY_TIMEOUT
  )

  it(
    'reads only the manifests it names: a later one changes nothing it generates',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'other-retirement-'))
      try {
        const named = namedInputManifests()
        for (const name of taxonomyInputManifests) expect(named).toContain(name)
        for (const name of named)
          copyFileSync(resolve(otherRetirementPaths.publications, name), join(directory, name))
        const moved = plan.moves.find(move => move.live)
        writeFileSync(
          join(directory, '2026-10-12-later.yaml'),
          stringify({
            version: 1,
            id: '2026-10-12-later',
            concurrency: 'rows',
            provenance: { actor: 'test', workflow: 'test' },
            operations: [
              {
                action: 'listing-unpublish',
                id: moved?.id,
                slug: moved?.slug,
                categories: ['other'],
                reason: 'later'
              }
            ]
          })
        )
        const paths = { ...otherRetirementPaths, publications: directory }
        const later = readRetirementInputs(paths)
        expect(planOtherRetirement(later)).toEqual(plan)
        expect(buildResidueInventory(readReplayedCatalog(paths), paths, recordedChecks())).toEqual(
          buildResidueInventory(inputs.catalog, otherRetirementPaths, recordedChecks())
        )
        // A named input that's missing is an error, not a silent change.
        rmSync(join(directory, '2026-10-10-taxonomy-03-retire.yaml'))
        expect(() => readReplayedCatalog(paths)).toThrow(/ENOENT/u)
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    },
    GENERATE_TIMEOUT
  )

  it("documents the owner's checks exactly as the replay runs them", () => {
    const doc = readFileSync(resolve('docs/taxonomy-migration.md'), 'utf8')
    for (const sql of Object.values(retirementChecks(inputs.mapping.catchAll)))
      expect(doc.includes(sql), sql).toBe(true)
  })
})
