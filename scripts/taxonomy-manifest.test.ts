import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { fixtureSeedStatements } from '../apps/web/e2e/fixture-seed'
import { resolveStagedCategorySql } from '../apps/web/src/db/plan-support'
import { applyMigrations } from '../apps/web/src/db/test-support'
import { parseManifest } from './d1-publisher.ts'
import { generateScaleCatalog, scaleCatalogStatements } from './fixtures/scale-catalog'
import {
  applyCommittedManifests,
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
import {
  all,
  apply,
  catalogFrom,
  committed,
  expectMigrated,
  GENERATE_TIMEOUT,
  intro,
  LIVE,
  manifestsBeforeTaxonomy,
  migrate,
  options,
  REPLAY_TIMEOUT,
  reviewedCatalogDatabase,
  withCatalogIds,
  withoutTaxonomy
} from './taxonomy-test-support'

const ids = taxonomyIds(options.date)

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
      const before = manifestsBeforeTaxonomy()
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
      // #348's stale-slug resolver: a draft, submission or revision saved before the retirement
      // still names a narrow slug, and it resolves to the slug's tag and that tag's hub, whether
      // the tag kept the slug or the category merged into another (through its redirect).
      const resolver = resolveStagedCategorySql('staged.category_slug')
      const resolveSlug = db.prepare(
        `WITH staged(category_slug) AS (VALUES (?)) SELECT
           (SELECT slug FROM categories WHERE id=(${resolver.categoryId})) AS category,
           (SELECT slug FROM tags WHERE id=(${resolver.tagId})) AS tag FROM staged`
      )
      const tagOf = new Map<string, string>()
      for (const tag of reviewed.mapping.tags) {
        if (!tag.cluster) tagOf.set(tag.slug, tag.slug)
        for (const merged of tag.merges ?? []) tagOf.set(merged, tag.slug)
      }
      const hubOf = new Map(reviewed.mapping.tags.map(tag => [tag.slug, tag.hub]))
      for (const slug of plan.retiring) {
        const tag = tagOf.get(slug)
        expect(resolveSlug.get(slug), slug).toEqual({ category: hubOf.get(tag ?? ''), tag })
      }
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
