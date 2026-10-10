import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { fixtureSeedStatements } from '../apps/web/e2e/fixture-seed'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { applyMigrations } from '../apps/web/src/db/test-support'
import { d1CompatViolations } from './d1-compat'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import { generateScaleCatalog, scaleCatalogStatements } from './fixtures/scale-catalog'
import {
  applyCommittedManifests,
  BEST_PAGE_PINS,
  buildTaxonomyManifests,
  type CatalogListing,
  committedBatchAssignments,
  committedTaxonomyManifests,
  defaultBestTitle,
  dispatchChecks,
  planTaxonomy,
  readReviewedInputs,
  STATEMENT_CEILING,
  type TaxonomyCatalog,
  type TaxonomyInputs,
  type TaxonomyMapping,
  type TaxonomyPlan,
  taxonomyDefaults,
  taxonomyIds,
  taxonomyInputManifests,
  taxonomyPaths
} from './taxonomy-manifest.ts'

const NOW = '2026-10-10T00:00:00.000Z'
const options = { date: taxonomyDefaults.date, keywordsCheckedAt: '2026-10-10T13:10:00.000Z' }
const ids = taxonomyIds(options.date)
/**
 * Time limits for the tests that generate or replay whole catalogs: a few seconds locally, but CI
 * runners are slower and share the d1 project with the workerd suites, so each has headroom over
 * vitest's 5-second default (which stays as it is for the rest).
 */
const GENERATE_TIMEOUT = 60_000
const REPLAY_TIMEOUT = 120_000
const intro = Array.from({ length: 70 }, (_, index) => `word${index}`).join(' ')

// ---------------------------------------------------------------------------------------------
// A small catalog: two narrow categories, a kept hub, the catch-all, and a retired category.

const listing = (slug: string, categories: string[], live = true): CatalogListing => ({
  id: `lst_${slug.replaceAll('.', '').padEnd(12, 'x')}`,
  slug,
  live,
  categories
})
const small: TaxonomyCatalog = {
  categories: [
    {
      slug: 'ai-chat',
      name: 'AI Chat',
      description: 'Browse ai chat listings and resources.',
      active: true
    },
    {
      slug: 'ai-chat-free',
      name: 'Free AI Chat',
      description: 'Browse free ai chat.',
      active: true
    },
    {
      slug: 'ai-seo',
      name: 'AI SEO',
      description: 'Browse ai seo listings and resources.',
      active: true
    },
    { slug: 'downloaders', name: 'Downloaders', description: 'Downloaders.', active: true },
    { slug: 'other', name: 'Other', description: '', active: true },
    { slug: 'adult', name: 'Adult', description: '', active: false }
  ],
  listings: [
    listing('a.ai', ['ai-chat', 'ai-seo']),
    listing('b.ai', ['ai-chat-free']),
    listing('c.ai', ['ai-seo']),
    listing('d.ai', ['ai-seo'], false),
    listing('e.ai', ['other']),
    listing('f.ai', ['other']),
    listing('g-downloader', ['downloaders', 'ai-chat']),
    listing('h-downloader', ['downloaders']),
    listing('x-downloader', ['downloaders', 'adult'], false)
  ]
}
const id = (slug: string) => small.listings.find(entry => entry.slug === slug)?.id ?? ''
const smallMapping = (): TaxonomyMapping => ({
  decidedAt: '2026-10-10',
  catchAll: 'other',
  keywordsCheckedAt: options.keywordsCheckedAt,
  hubs: [
    { slug: 'chat', name: 'Chat', order: 1, listings: 3 },
    { slug: 'marketing', name: 'Marketing', order: 2, listings: 1 },
    { slug: 'downloaders', existing: true, listings: 2 }
  ],
  other: { listings: 1 },
  tags: [
    { slug: 'ai-chat', hub: 'chat', name: 'AI Chat', merges: ['ai-chat-free'], listings: 3 },
    { slug: 'ai-seo', hub: 'marketing', name: 'AI SEO', listings: 2 },
    { slug: 'ai-writers', hub: 'chat', name: 'AI Writers', cluster: true, listings: 1 }
  ],
  bestPages: [
    {
      slug: 'ai-chatbot',
      keyword: 'ai chatbot',
      volume: 1000,
      tag: 'ai-chat',
      intro,
      pins: [
        { slug: 'b.ai', id: id('b.ai'), evidence: 'first' },
        { slug: 'a.ai', id: id('a.ai'), evidence: 'second' },
        { slug: 'g-downloader', id: id('g-downloader'), evidence: 'third' }
      ]
    }
  ],
  redirects: [
    { from: { kind: 'category', slug: 'ai-chat' }, to: { kind: 'best', slug: 'ai-chatbot' } },
    { from: { kind: 'category', slug: 'ai-chat-free' }, to: { kind: 'best', slug: 'ai-chatbot' } },
    { from: { kind: 'category', slug: 'ai-seo' }, to: { kind: 'tag', slug: 'ai-seo' } },
    { from: { kind: 'tag', slug: 'ai-chat' }, to: { kind: 'best', slug: 'ai-chatbot' } }
  ]
})
const smallInputs = (mapping = smallMapping()): TaxonomyInputs => ({
  mapping,
  catalog: small,
  clusters: new Map([[id('e.ai'), ['ai-writers']]])
})

describe('the taxonomy generator (#349)', () => {
  it('titles a best page "Best {keyword, plural, title case}" (design 5.1)', () => {
    expect(defaultBestTitle('ai photo editor')).toBe('Best AI Photo Editors')
    expect(defaultBestTitle('ai tools for teachers')).toBe('Best AI Tools for Teachers')
    expect(defaultBestTitle('video downloader')).toBe('Best Video Downloaders')
    expect(defaultBestTitle('ai text to speech', 'ai text to speech tools')).toBe(
      'Best AI Text to Speech Tools'
    )
    expect(defaultBestTitle('cloud gpu', 'cloud gpu providers')).toBe('Best Cloud GPU Providers')
    expect(defaultBestTitle('hipaa compliant hosting', 'hipaa compliant hosting providers')).toBe(
      'Best HIPAA Compliant Hosting Providers'
    )
  })

  it('moves every listing filed under a narrow category to its hub, with its tags', () => {
    const plan = planTaxonomy(smallInputs())
    expect(plan.retiring).toEqual(['ai-chat', 'ai-chat-free', 'ai-seo'])
    expect(plan.moves.map(move => [move.slug, move.expected, move.hub, move.tags])).toEqual([
      ['a.ai', ['ai-chat', 'ai-seo'], 'chat', ['ai-chat', 'ai-seo']],
      // A merged category's listing gets the tag it merges into.
      ['b.ai', ['ai-chat-free'], 'chat', ['ai-chat']],
      ['c.ai', ['ai-seo'], 'marketing', ['ai-seo']],
      // Unpublished listings are re-filed too, so their 410 doesn't turn into a 404 (design 1.5).
      ['d.ai', ['ai-seo'], 'marketing', ['ai-seo']],
      // A clustered catch-all listing goes to its cluster's hub.
      ['e.ai', ['other'], 'chat', ['ai-writers']],
      // A kept hub stays the primary; its narrow secondaries become tags.
      ['g-downloader', ['downloaders', 'ai-chat'], 'downloaders', ['ai-chat']]
    ])
    // Untouched: unclustered Other, the kept hub alone, and a listing under a retired category.
    expect(plan.hubCounts).toEqual(
      new Map([
        ['chat', 3],
        ['marketing', 1],
        ['downloaders', 2],
        ['other', 1]
      ])
    )
  })

  it('re-files a listing another manifest retires under its hub, without tags', () => {
    const plan = planTaxonomy({ ...smallInputs(), untagged: new Set([id('d.ai')]) })
    expect(plan.moves.find(move => move.slug === 'd.ai')).toMatchObject({
      hub: 'marketing',
      tags: []
    })
  })

  it.each<[string, (mapping: TaxonomyMapping) => void, RegExp]>([
    [
      'a narrow category without a tag',
      mapping => {
        mapping.tags[0] = { ...mapping.tags[0], merges: [] } as TaxonomyMapping['tags'][0]
      },
      /narrow category ai-chat-free has no tag/u
    ],
    [
      'a redirect aimed at a retiring category',
      mapping => {
        mapping.redirects[2] = {
          from: { kind: 'category', slug: 'ai-seo' },
          to: { kind: 'category', slug: 'ai-chat' }
        }
      },
      /aims at ai-chat, a retiring category/u
    ],
    [
      'a redirect to a tag a best page takes over (a chain)',
      mapping => {
        mapping.redirects[0] = {
          from: { kind: 'category', slug: 'ai-chat' },
          to: { kind: 'tag', slug: 'ai-chat' }
        }
      },
      /ends at tag ai-chat, which redirects too/u
    ],
    [
      'a narrow category without a redirect',
      mapping => {
        mapping.redirects.splice(2, 1)
      },
      /narrow category ai-seo has no redirect/u
    ],
    [
      "a tag-only best page's tag without its redirect",
      mapping => {
        mapping.redirects.pop()
      },
      /tag ai-chat has no redirect to its best page/u
    ],
    [
      'a pin outside the pool',
      mapping => {
        mapping.bestPages[0]?.pins.push({ slug: 'c.ai', id: id('c.ai'), evidence: 'x' })
      },
      /c\.ai is not a live listing of its pool/u
    ],
    [
      'an unpublished pin',
      mapping => {
        mapping.bestPages[0]?.pins.push({ slug: 'd.ai', id: id('d.ai'), evidence: 'x' })
      },
      /d\.ai is not a live listing of its pool/u
    ],
    [
      'an intro outside 60 to 150 words',
      mapping => {
        const page = mapping.bestPages[0]
        if (page) page.intro = 'Too short.'
      },
      /its intro has 2 words, not 60 to 150/u
    ],
    [
      'a count the plan does not reach',
      mapping => {
        const hub = mapping.hubs[0]
        if (hub) hub.listings = 4
      },
      /hub chat would hold 3 listings, not 4/u
    ],
    [
      'a new hub that is already a category',
      mapping => {
        mapping.hubs.push({ slug: 'ai-seo', name: 'SEO', order: 3 })
      },
      /hub ai-seo is already a category/u
    ]
  ])('refuses %s', (_name, change, message) => {
    const mapping = smallMapping()
    change(mapping)
    expect(() => planTaxonomy(smallInputs(mapping))).toThrow(message)
  })

  it('refuses to move a listing whose own submission is in review, naming it', () => {
    expect(() =>
      planTaxonomy({ ...smallInputs(), catalog: { ...small, inReview: new Set([id('c.ai')]) } })
    ).toThrow(/clear the review queue first: c\.ai/u)
  })

  it('re-files a slug redirect source without tags, and refuses one that can never move', () => {
    const sources = new Set([id('c.ai')])
    // Without the declared counts: an untagged source leaves ai-seo with one listing fewer.
    const uncounted = smallMapping()
    uncounted.tags = uncounted.tags.map(({ listings: _, ...tag }) => tag)
    expect(
      planTaxonomy({
        ...smallInputs(uncounted),
        catalog: { ...small, slugRedirectSources: sources }
      }).moves.find(move => move.slug === 'c.ai')
    ).toMatchObject({ hub: 'marketing', tags: [] })
    // Filed under a retired category, it can't be re-filed, so ai-chat could never retire.
    const stuck = {
      ...small,
      listings: [
        ...small.listings,
        listing('y-downloader', ['downloaders', 'adult', 'ai-chat'], false)
      ]
    }
    expect(() =>
      planTaxonomy({
        ...smallInputs(),
        catalog: { ...stuck, slugRedirectSources: new Set([listing('y-downloader', []).id]) }
      })
    ).toThrow(/y-downloader is a slug redirect source filed under ai-chat and a retired category/u)
  })

  it('never pins a listing that names a feature of a larger site', () => {
    const mapping = smallMapping()
    mapping.featureListings = [
      { slug: 'a.ai', id: id('a.ai'), name: 'A GPT', reason: 'a feature of A' }
    ]
    expect(() => planTaxonomy(smallInputs(mapping))).toThrow(
      /best page ai-chatbot pins a\.ai, a feature of a larger site/u
    )
  })

  it('writes the phases in publish order, each a row-level manifest the publisher accepts', () => {
    const manifests = buildTaxonomyManifests(planTaxonomy(smallInputs()), options)
    expect(manifests.map(manifest => manifest.id)).toEqual([
      ids.create,
      ids.redirects,
      ids.move(1),
      ids.retire
    ])
    const [create, redirects, move, retire] = manifests.map(({ source }) => parseManifest(source))
    expect(create?.operations.map(operation => operation.action)).toEqual([
      'category-create',
      'category-create',
      'tag-create',
      'tag-create',
      'tag-create',
      'best-page-create',
      'best-page-listings-set'
    ])
    expect(create?.operations[5]).toMatchObject({
      page: {
        title: 'Best AI Chatbots',
        heading: 'Best AI Chatbots',
        listSize: 10,
        keywordVolume: 1000,
        keywordCheckedAt: options.keywordsCheckedAt
      }
    })
    expect(redirects?.operations).toHaveLength(4)
    expect(move?.operations.slice(0, 2)).toEqual([
      {
        action: 'listing-tags-set',
        id: id('a.ai'),
        slug: 'a.ai',
        expected: [],
        tags: ['ai-chat', 'ai-seo']
      },
      {
        action: 'listing-categories-set',
        id: id('a.ai'),
        slug: 'a.ai',
        expected: ['ai-chat', 'ai-seo'],
        categories: ['chat']
      }
    ])
    expect(retire?.operations).toEqual(
      ['ai-chat', 'ai-chat-free', 'ai-seo'].map(slug => ({ action: 'category-unpublish', slug }))
    )
    for (const manifest of manifests)
      expect(parseManifest(manifest.source).concurrency).toBe('rows')
  })

  it(
    'keeps every listing in its batch when the manifests are regenerated (#342 review)',
    () => {
      const many: TaxonomyCatalog = {
        categories: small.categories,
        listings: Array.from({ length: 300 }, (_, index) =>
          listing(`n${String(index).padStart(3, '0')}.ai`, ['ai-seo'])
        )
      }
      const mapping = smallMapping()
      mapping.hubs = [
        { slug: 'chat', name: 'Chat', order: 1 },
        { slug: 'marketing', name: 'Marketing', order: 2 },
        { slug: 'downloaders', existing: true }
      ]
      mapping.tags = mapping.tags.map(({ listings: _, ...tag }) => tag)
      mapping.bestPages = []
      mapping.other = {}
      mapping.redirects = [
        { from: { kind: 'category', slug: 'ai-chat' }, to: { kind: 'category', slug: 'chat' } },
        {
          from: { kind: 'category', slug: 'ai-chat-free' },
          to: { kind: 'category', slug: 'chat' }
        },
        { from: { kind: 'category', slug: 'ai-seo' }, to: { kind: 'tag', slug: 'ai-seo' } }
      ]
      // A hub with nothing filed under it is refused; give each one a listing.
      many.listings.push(listing('chat.ai', ['ai-chat']), listing('dl', ['downloaders']))
      const inputs = { mapping, catalog: many }
      const first = buildTaxonomyManifests(planTaxonomy(inputs), options)
      const batches = first.filter(({ id: manifestId }) => manifestId.includes('-02-move-'))
      expect(batches.length).toBeGreaterThan(2)
      const assignments = new Map<string, number>()
      batches.forEach(({ source }, index) => {
        for (const operation of parseManifest(source).operations)
          if ('id' in operation) assignments.set(operation.id, index + 1)
      })
      // A listing no batch holds goes to a new batch; the others stay as they were.
      const added = {
        ...inputs,
        catalog: { ...many, listings: [...many.listings, listing('m.ai', ['ai-seo'])] }
      }
      const again = buildTaxonomyManifests(planTaxonomy(added), options, assignments)
      const againBatches = again.filter(({ id: manifestId }) => manifestId.includes('-02-move-'))
      expect(againBatches.slice(0, batches.length).map(({ source }) => source)).toEqual(
        batches.map(({ source }) => source)
      )
      expect(
        parseManifest(againBatches.at(-1)?.source ?? '').operations.map(operation =>
          'slug' in operation ? operation.slug : ''
        )
      ).toEqual(['m.ai', 'm.ai'])
    },
    GENERATE_TIMEOUT
  )
})

// ---------------------------------------------------------------------------------------------
// Replays: the generator's manifests on a database, then the invariants of #349.

/** Applies a manifest's plan in one transaction, as the publisher's batch does; throws on refusal. */
function apply(db: DatabaseSync, id: string, source: string): number {
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

const all = <T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params) as T[]
const LIVE = "l.status='approved' AND l.is_active=1"

/** The catalog as the generator takes it, read from a database. */
function catalogFrom(db: DatabaseSync): TaxonomyCatalog {
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
function synthesizeMapping(
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
function expectMigrated(db: DatabaseSync, mapping: TaxonomyMapping, plan: TaxonomyPlan): void {
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
function migrate(
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
function withCatalogIds(db: DatabaseSync): void {
  const prefix = 'fixture-listing-'
  const rename = `'lst_' || substr(%, ${prefix.length + 1})`
  // Every reference moves with its row, so the keys hold again once all are renamed.
  db.exec('PRAGMA foreign_keys = OFF')
  const tables = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table'")
  for (const { name } of tables) {
    const columns = all<{ name: string }>(db, `PRAGMA table_info(${name})`).map(
      column => column.name
    )
    if (columns.includes('listing_id'))
      db.exec(
        `UPDATE ${name} SET listing_id=${rename.replace('%', 'listing_id')} WHERE listing_id LIKE '${prefix}%'`
      )
  }
  db.exec(`UPDATE listings SET id=${rename.replace('%', 'id')} WHERE id LIKE '${prefix}%'`)
  expect(all(db, 'PRAGMA foreign_key_check')).toEqual([])
  db.exec('PRAGMA foreign_keys = ON')
}

/** Removes the taxonomy a catalog already has: #341's starting point is none. */
function withoutTaxonomy(db: DatabaseSync): void {
  for (const table of [
    'best_page_listings',
    'taxonomy_redirects',
    'best_pages',
    'listing_tags',
    'tags'
  ])
    db.exec(`DELETE FROM ${table}`)
}

describe('the taxonomy manifests replayed (#349)', () => {
  it(
    'migrate the fixture catalog with every invariant holding',
    () => {
      const db = new DatabaseSync(':memory:')
      applyMigrations(db)
      for (const { sql, params } of fixtureSeedStatements()) db.prepare(sql).run(...params)
      withoutTaxonomy(db)
      withCatalogIds(db)
      const { mapping, plan } = migrate(db, { kept: ['design-tools'], hubs: 2, clustered: 0 })
      expect(plan.moves.length).toBeGreaterThan(40)
      expectMigrated(db, mapping, plan)
    },
    REPLAY_TIMEOUT
  )

  it(
    'migrate the scale catalog with every invariant holding',
    () => {
      const db = new DatabaseSync(':memory:')
      db.exec('PRAGMA foreign_keys = ON')
      applyMigrations(db)
      for (const { sql, params } of scaleCatalogStatements(generateScaleCatalog()))
        db.prepare(sql).run(...params)
      withoutTaxonomy(db)
      const { mapping, plan, queueCleared } = migrate(db, {
        catchAll: 'other',
        kept: ['video-downloaders'],
        hubs: 6,
        clustered: 40
      })
      // The scale catalog has submissions in review on listings that move.
      expect(queueCleared).toBe(true)
      expect(plan.retiring.length).toBeGreaterThan(130)
      expect(plan.moves.length).toBeGreaterThan(500)
      expectMigrated(db, mapping, plan)
    },
    REPLAY_TIMEOUT
  )
})

// ---------------------------------------------------------------------------------------------
// The reviewed catalog: the committed mapping and manifests.

interface InventoryRow {
  id: string
  slug: string
  name: string
  description: string
  website: string
  live?: boolean
  categories: string[]
}

/** The reviewed catalog at the inventories' snapshot, in a fresh database. */
function reviewedCatalogDatabase(): DatabaseSync {
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
function committed(name: string, actions?: ReadonlySet<string>): string {
  const source = readFileSync(resolve(taxonomyPaths.publications, name), 'utf8')
  if (!actions) return source
  const manifest = parse(source) as { operations: Array<{ action: string }> }
  return stringify({
    ...manifest,
    operations: manifest.operations.filter(op => actions.has(op.action))
  })
}

describe('the committed taxonomy mapping and manifests (#349)', () => {
  // Read and planned once, in a hook with its own time limit, for every test below.
  let reviewed: ReturnType<typeof readReviewedInputs>
  let plan: TaxonomyPlan
  beforeAll(() => {
    reviewed = readReviewedInputs()
    plan = planTaxonomy(reviewed.inputs)
  }, GENERATE_TIMEOUT)

  it('fits the reviewed catalog: 16 hubs, 125 tags, 30 best pages and 166 redirects', () => {
    const { mapping } = reviewed
    expect(mapping.decidedAt).toBe('2026-10-10')
    expect(mapping.hubs).toHaveLength(16)
    expect(mapping.hubs.filter(hub => hub.existing).map(hub => hub.slug)).toEqual([
      'video-downloaders'
    ])
    expect(mapping.tags).toHaveLength(125)
    expect(mapping.tags.filter(tag => tag.cluster)).toHaveLength(24)
    expect(mapping.tags.flatMap(tag => tag.merges ?? [])).toHaveLength(36)
    expect(mapping.bestPages).toHaveLength(30)
    expect(plan.retiring).toHaveLength(137)
    expect(mapping.redirects.filter(redirect => redirect.from.kind === 'category')).toHaveLength(
      137
    )
    expect(mapping.redirects.filter(redirect => redirect.from.kind === 'tag')).toHaveLength(29)
    // No redirect aims at a category, retiring or not: old narrow URLs go to tags or best pages.
    expect(mapping.redirects.filter(redirect => redirect.to.kind === 'category')).toEqual([])
    // Every keyword was checked: a volume and its time.
    expect(mapping.keywordsCheckedAt).toMatch(/^2026-10-10T/u)
    for (const page of mapping.bestPages) expect(page.volume, page.slug).toBeGreaterThan(0)
    // A feature of a larger site is never pinned, on any page (#366 review).
    const features = new Set((mapping.featureListings ?? []).map(entry => entry.slug))
    for (const slug of [
      'slack.com',
      'crisp.chat',
      'salesforce.com',
      'hubspot.com',
      'miro.com',
      'livechat.com'
    ])
      expect(features.has(slug), slug).toBe(true)
    // The HIPAA page pins only providers with a HIPAA offering, each naming its evidence.
    const hipaa = mapping.bestPages.find(page => page.slug === 'hipaa-compliant-hosting')
    for (const pin of hipaa?.pins ?? [])
      expect(pin.evidence, pin.slug).toMatch(/HIPAA offering: https:/u)
    expect(hipaa?.exclude?.map(entry => entry.slug)).toContain('greengeeks.com')
  })

  it('leaves out what #337, #358 and other-removals retire, and the held listings', () => {
    const { removed, mapping } = reviewed
    expect(new Set(removed.values())).toEqual(
      new Set([
        '2026-10-10-duplicate-listings.yaml',
        '2026-10-10-mismatch-removals.yaml',
        '2026-10-10-other-removals.yaml'
      ])
    )
    expect(removed.size).toBe(14 + 127 + 5)
    // No retired listing is tagged; only the two duplicates filed under narrow categories, which
    // are slug redirect sources, are re-filed (category-unpublish would refuse while they stay).
    const moved = plan.moves.filter(move => removed.has(move.id))
    expect(moved.map(move => [move.slug, move.hub, move.tags])).toEqual([
      ['lambdalabs.com', 'cloud-hosting', []],
      ['timelyapp.com', 'productivity', []]
    ])
    const held = new Set((mapping.held ?? []).map(entry => entry.id))
    expect(held.size).toBe(5)
    expect(plan.moves.filter(move => held.has(move.id))).toEqual([])
    // No pin is a retired, held or claim-held listing.
    const pins = mapping.bestPages.flatMap(page => page.pins.map(pin => pin.id))
    for (const pin of pins) expect(removed.has(pin) || held.has(pin), pin).toBe(false)
  })

  it(
    'keeps the committed manifests identical to what the mapping generates',
    () => {
      const manifests = buildTaxonomyManifests(
        plan,
        { date: taxonomyDefaults.date, keywordsCheckedAt: reviewed.mapping.keywordsCheckedAt },
        committedBatchAssignments()
      )
      expect(committedTaxonomyManifests()).toEqual(
        manifests.map(({ id: manifestId }) => `${manifestId}.yaml`)
      )
      for (const { id: manifestId, source } of manifests)
        expect(
          readFileSync(resolve(taxonomyPaths.publications, `${manifestId}.yaml`), 'utf8'),
          manifestId
        ).toBe(source)
    },
    GENERATE_TIMEOUT
  )

  it(
    'replays on the reviewed catalog after the manifests it follows, every invariant holding',
    () => {
      const db = reviewedCatalogDatabase()
      // The owner's dispatch order before #341 (#321): #337 (its media updates touch no category or
      // live state, and need its uploads), #333's removals and batches, #352, then #358 (its claim
      // hold clears touch nothing here either).
      const unpublishOnly = new Set(['listing-unpublish'])
      const before: Array<[string, string]> = [
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
      for (const [name, source] of before) apply(db, name, source)
      // The generator's view of the same state: its replay of those manifests matches the database's.
      const generatorView = new Map(
        reviewed.inputs.catalog.listings.map(entry => [entry.id, entry])
      )
      for (const entry of catalogFrom(db).listings)
        expect(generatorView.get(entry.id), entry.slug).toEqual(entry)

      const names = committedTaxonomyManifests()
      expect(names[0]).toBe(`${ids.create}.yaml`)
      expect(names[1]).toBe(`${ids.redirects}.yaml`)
      expect(names.at(-1)).toBe(`${ids.retire}.yaml`)
      const checks = dispatchChecks(reviewed.mapping)
      const rows = (sql: string) => all(db, sql)
      expect(rows(checks.reviewQueue)).toEqual([])
      expect(rows(checks.revisions)).toEqual([])
      for (const name of names) {
        // Retiring early refuses whole: live listings are still filed under the narrow categories,
        // and the owner's check before -03 lists them.
        if (name === `${ids.move(1)}.yaml`) {
          expect(() => apply(db, ids.retire, committed(`${ids.retire}.yaml`))).toThrow(
            /does not apply/u
          )
          expect(rows(checks.retire).length).toBeGreaterThan(2000)
        }
        if (name === `${ids.retire}.yaml`) {
          // After every -02 batch the check is empty, so the owner goes on; the 14 unpublished
          // cam downloaders still filed under livestream-downloaders (and Adult) don't block it.
          expect(rows(checks.retire)).toEqual([])
          expect(
            rows(
              `SELECT l.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
               JOIN listings l ON l.id=lc.listing_id WHERE c.slug='livestream-downloaders'
               AND l.is_active=0`
            )
          ).toHaveLength(14)
        }
        expect(apply(db, name, committed(name)), name).toBeLessThanOrEqual(STATEMENT_CEILING)
      }
      expectMigrated(db, reviewed.mapping, plan)
      // The 141 left in Other, and the five held among them, carry no tag.
      expect(
        all(
          db,
          `SELECT l.slug FROM listings l JOIN listing_categories lc ON lc.listing_id=l.id JOIN categories c
         ON c.id=lc.category_id WHERE c.slug='other' AND ${LIVE} AND EXISTS
         (SELECT 1 FROM listing_tags lt WHERE lt.listing_id=l.id)`
        )
      ).toEqual([])
    },
    REPLAY_TIMEOUT
  )

  it(
    'reads only the 16 manifests it names: a later one changes nothing it generates',
    () => {
      expect(taxonomyInputManifests).toHaveLength(16)
      const directory = mkdtempSync(join(tmpdir(), 'taxonomy-manifest-'))
      try {
        for (const name of taxonomyInputManifests)
          copyFileSync(resolve(taxonomyPaths.publications, name), join(directory, name))
        // What #351 or a later hygiene manifest would add: none of it is read.
        const moved = plan.moves.find(move => move.live && move.tags.length > 0)
        writeFileSync(
          join(directory, '2026-10-12-later.yaml'),
          stringify({
            version: 1,
            id: '2026-10-12-later',
            concurrency: 'rows',
            provenance: { actor: 'test', workflow: 'test' },
            operations: [
              { action: 'category-unpublish', slug: 'other' },
              {
                action: 'listing-unpublish',
                id: moved?.id,
                slug: moved?.slug,
                categories: [moved?.hub],
                reason: 'later'
              }
            ]
          })
        )
        const later = readReviewedInputs({ ...taxonomyPaths, publications: directory })
        expect(later.inputs.catalog).toEqual(reviewed.inputs.catalog)
        expect(planTaxonomy(later.inputs)).toEqual(plan)
        // A named input that's missing is an error, not a silent change.
        rmSync(join(directory, '2026-10-10-mismatch-categories.yaml'))
        expect(() => readReviewedInputs({ ...taxonomyPaths, publications: directory })).toThrow(
          /ENOENT/u
        )
      } finally {
        rmSync(directory, { force: true, recursive: true })
      }
    },
    GENERATE_TIMEOUT
  )

  it("documents the owner's checks exactly as the replay runs them", () => {
    const doc = readFileSync(resolve('docs/taxonomy-migration.md'), 'utf8')
    for (const sql of Object.values(dispatchChecks(reviewed.mapping)))
      expect(doc.includes(sql), sql).toBe(true)
  })

  it('applies the committed manifests published after the snapshot the way the publisher does', () => {
    const listings = new Map([
      [
        `lst_${'a'.repeat(12)}`,
        { id: `lst_${'a'.repeat(12)}`, slug: 'a.ai', live: true, categories: ['other'] }
      ]
    ])
    expect(() =>
      applyCommittedManifests(listings, [
        {
          name: 'x.yaml',
          source: stringify({
            operations: [{ action: 'listing-update', id: `lst_${'a'.repeat(12)}` }]
          })
        }
      ])
    ).toThrow(/does not replay listing-update/u)
    expect(() =>
      applyCommittedManifests(listings, [
        {
          name: 'x.yaml',
          source: stringify({
            operations: [
              {
                action: 'listing-categories-set',
                id: `lst_${'a'.repeat(12)}`,
                slug: 'a.ai',
                expected: ['ai-seo'],
                categories: ['ai-chat']
              }
            ]
          })
        }
      ])
    ).toThrow(/does not match the reviewed catalog/u)
  })
})
