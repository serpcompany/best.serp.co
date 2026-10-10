import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, type PublicationManifest, parseManifest } from './d1-publisher.ts'
import {
  buildMismatchManifests,
  committedListingChanges,
  type InventoryListing,
  type MismatchEntry,
  mismatchManifestIds,
  mismatchOperations,
  readMismatchInputs
} from './mismatch-manifests.ts'
import { committedOtherCategoryManifests } from './other-categories-manifest.ts'

const live = new Set(['ai-design', 'ai-chatbots'])
const listing = (letter: string): InventoryListing => ({
  id: `lst_${letter.repeat(12)}`,
  slug: `${letter}.ai`,
  name: `${letter.toUpperCase()} Old`,
  description: `What ${letter} was.`,
  website: `https://serp.ly/${letter}`,
  categories: ['other']
})
const inventory = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(listing)
const entry = (letter: string, rest: Partial<MismatchEntry>): MismatchEntry =>
  ({ slug: `${letter}.ai`, id: `lst_${letter.repeat(12)}`, ...rest }) as MismatchEntry
const entries: MismatchEntry[] = [
  entry('a', { verdict: 'retire-dead', decision: 'retire' }),
  entry('b', {
    verdict: 'keep-rewrite',
    decision: 'retire-instead-of-rewrite',
    category: 'ai-design'
  }),
  entry('c', { verdict: 'retire-dead', decision: 'hold' }),
  entry('d', {
    verdict: 'rename',
    decision: 'rename',
    category: 'ai-design',
    details: { name: 'D New', description: 'What D does.', website: 'https://d.ai/' }
  }),
  entry('e', {
    verdict: 'rename',
    decision: 'rename',
    category: 'ai-proposed',
    details: { name: 'E New', description: 'What E does.' }
  }),
  entry('f', {
    verdict: 'keep-recategorize',
    decision: 'fix-description',
    category: 'ai-chatbots',
    details: { description: 'What F does.' }
  }),
  entry('g', { verdict: 'rename', decision: 'retire-instead-of-rename', category: 'ai-design' })
]
/** The most statements a committed batch may plan to (#342 review: legacy-media-06 was 2,129). */
const STATEMENT_CEILING = 2000
const committed = (id: string): PublicationManifest =>
  parseManifest(readFileSync(resolve('d1/publications', `${id}.yaml`), 'utf8'))

describe('the mismatch manifests (#340)', () => {
  it('turns each decision into its operations, and holds nothing', () => {
    const { removals, renames, categories } = mismatchOperations(entries, inventory, live)
    expect(removals).toEqual([
      {
        action: 'listing-unpublish',
        id: 'lst_aaaaaaaaaaaa',
        slug: 'a.ai',
        categories: ['other'],
        reason: expect.stringMatching(/^#340 retire-dead \(owner decision 2026-10-10\)/u),
        expected: { website: 'https://serp.ly/a' }
      },
      {
        action: 'listing-unpublish',
        id: 'lst_bbbbbbbbbbbb',
        slug: 'b.ai',
        categories: ['other'],
        reason: expect.stringMatching(/^#340 keep-rewrite, retired instead of rewritten/u),
        expected: { website: 'https://serp.ly/b', unowned: true }
      },
      {
        action: 'listing-unpublish',
        id: 'lst_gggggggggggg',
        slug: 'g.ai',
        categories: ['other'],
        reason: expect.stringMatching(/^#340 rename, retired instead/u),
        expected: { website: 'https://serp.ly/g', unowned: true }
      }
    ])
    expect(renames).toEqual([
      {
        action: 'listing-details-set',
        id: 'lst_dddddddddddd',
        slug: 'd.ai',
        reason: '#340 rename (owner decision 2026-10-10): D Old is now D New',
        expected: { name: 'D Old', description: 'What d was.', website: 'https://serp.ly/d' },
        details: { name: 'D New', description: 'What D does.', website: 'https://d.ai/' }
      },
      expect.objectContaining({
        slug: 'e.ai',
        details: { name: 'E New', description: 'What E does.' }
      }),
      expect.objectContaining({ slug: 'f.ai', details: { description: 'What F does.' } })
    ])
    // Only a renamed or fixed listing with a live category leaves Other; a proposed one stays.
    expect(categories).toEqual([
      {
        action: 'listing-categories-set',
        id: 'lst_dddddddddddd',
        slug: 'd.ai',
        expected: ['other'],
        categories: ['ai-design']
      },
      expect.objectContaining({ slug: 'f.ai', categories: ['ai-chatbots'] })
    ])
    const manifests = buildMismatchManifests(entries, inventory, live)
    expect(manifests.map(({ id }) => id)).toEqual(Object.values(mismatchManifestIds))
    for (const { source } of manifests) expect(parseManifest(source).concurrency).toBe('rows')
  })

  const replace = (slug: string, change: Partial<MismatchEntry>) =>
    entries.map(item => (item.slug === slug ? { ...item, ...change } : item))
  it.each([
    [
      'a decision its verdict does not allow',
      replace('b.ai', { decision: 'retire' }),
      /can't be decided retire/u
    ],
    [
      'a held hijacked domain',
      replace('a.ai', { verdict: 'retire-hijacked', decision: 'hold' }),
      /can't be decided hold/u
    ],
    [
      'a listing outside the inventory',
      [...entries, entry('z', { verdict: 'retire-dead', decision: 'retire' })],
      /z\.ai .* is not in the inventory/u
    ],
    [
      'another listing id',
      replace('a.ai', { id: 'lst_zzzzzzzzzzzz' }),
      /a\.ai .* is not in the inventory/u
    ],
    ['a listing twice', [...entries, entries[0] as MismatchEntry], /in the audit twice/u],
    [
      'details on a removal',
      replace('a.ai', { details: { name: 'A' } }),
      /only a rename or a description fix/u
    ],
    [
      'a retired rename with details',
      replace('g.ai', { details: { name: 'G New' } }),
      /only a rename or a description fix/u
    ],
    [
      'a rename without details',
      replace('d.ai', { details: undefined }),
      /only a rename or a description fix/u
    ],
    [
      'a rename that keeps the name',
      replace('d.ai', { details: { name: 'D Old' } }),
      /needs a new name/u
    ],
    [
      'a description fix that renames',
      replace('f.ai', { details: { name: 'F', description: 'x' } }),
      /changes only the description/u
    ]
  ])('refuses %s', (_name, given, message) => {
    expect(() => mismatchOperations(given, inventory, live)).toThrow(message)
  })

  it('refuses a listing not filed under Other alone, or one another manifest changes', () => {
    const moved = inventory.map(item =>
      item.slug === 'a.ai' ? { ...item, categories: ['ai-design'] } : item
    )
    expect(() => mismatchOperations(entries, moved, live)).toThrow(/not Other alone/u)
    expect(() =>
      mismatchOperations(entries, inventory, live, new Map([['lst_dddddddddddd', 'x.yaml']]))
    ).toThrow(/d\.ai is changed by x\.yaml/u)
    // A held listing has no operation, so another manifest may change it.
    expect(() =>
      mismatchOperations(entries, inventory, live, new Map([['lst_cccccccccccc', 'x.yaml']]))
    ).not.toThrow()
  })

  it('keeps the committed manifests identical to what the audit generates', () => {
    const { entries: decided, inventory: listings, liveCategories } = readMismatchInputs()
    const manifests = buildMismatchManifests(
      decided,
      listings,
      liveCategories,
      committedListingChanges()
    )
    expect(manifests.map(({ id }) => id)).toEqual(Object.values(mismatchManifestIds))
    for (const { id, source } of manifests)
      expect(readFileSync(resolve('d1/publications', `${id}.yaml`), 'utf8'), id).toBe(source)
  })

  it("carries out the owner's decisions of 2026-10-10 for all 139 listings", () => {
    const { entries: decided } = readMismatchInputs()
    expect(decided).toHaveLength(139)
    const count = (decision: string) => decided.filter(item => item.decision === decision).length
    expect({
      retire: count('retire'),
      hold: count('hold'),
      'retire-instead-of-rewrite': count('retire-instead-of-rewrite'),
      'retire-instead-of-rename': count('retire-instead-of-rename'),
      rename: count('rename'),
      'fix-description': count('fix-description')
    }).toEqual({
      retire: 40,
      hold: 3,
      'retire-instead-of-rewrite': 75,
      'retire-instead-of-rename': 12,
      rename: 8,
      'fix-description': 1
    })
    expect(
      decided
        .filter(item => item.decision === 'hold')
        .map(item => item.slug)
        .sort()
    ).toEqual(['knowbuddy.ai', 'perxeive.com', 'wewritecards.com'])
    const removals = committed(mismatchManifestIds.removals).operations.flatMap(operation =>
      operation.action === 'listing-unpublish' ? [operation] : []
    )
    expect(removals).toHaveLength(127)
    // Real products (keep-rewrite, and renames with another product's copy) are `unowned`;
    // hygiene removals are not.
    const verdicts = new Map(decided.map(item => [item.id, item]))
    for (const removal of removals)
      expect(removal.expected?.unowned ?? false, removal.slug).toBe(
        verdicts.get(removal.id)?.decision !== 'retire'
      )
    expect(
      removals.filter(removal => verdicts.get(removal.id)?.verdict === 'rename').map(r => r.slug)
    ).toEqual([
      'earningscall.ai',
      'figma.com',
      'getslate.ai',
      'heroguide.ai',
      'letsfoodie.com',
      'mirrorthink.ai',
      'onetask.me',
      'rapideditor.org',
      'riffusion.com',
      'triplewhale.com',
      'vogent.ai',
      'writepanda.ai'
    ])
    expect(committed(mismatchManifestIds.renames).operations).toHaveLength(9)
    expect(committed(mismatchManifestIds.categories).operations).toHaveLength(4)
  })

  it("leaves out every listing #333's batches move, #332 retires, or other-removals removes", () => {
    const changes = committedListingChanges()
    // The named manifests are among the ones scanned.
    const sources = new Set(changes.values())
    for (const name of [
      ...committedOtherCategoryManifests(),
      '2026-10-10-duplicate-listings.yaml',
      '2026-10-10-other-removals.yaml'
    ])
      expect(sources.has(name), name).toBe(true)
    for (const id of Object.values(mismatchManifestIds))
      for (const operation of committed(id).operations)
        if ('id' in operation && 'slug' in operation)
          expect(changes.get(operation.id), `${id}: ${operation.slug}`).toBeUndefined()
  })

  it('applies after the Other batches and removals, as the reviewed inventory replays', () => {
    const { entries: decided, inventory: listings, liveCategories } = readMismatchInputs()
    const db = new DatabaseSync(':memory:')
    for (const migration of freshMigrationNames())
      db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    const insertCategory = db.prepare('INSERT INTO categories (slug,name) VALUES (?,?)')
    for (const slug of ['other', ...liveCategories]) insertCategory.run(slug, slug)
    const now = '2026-10-10T00:00:00.000Z'
    const insertListing = db.prepare(
      "INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum) VALUES (?,?,?,?,?,'draft',?,'test','fixture',?)"
    )
    const fileUnderOther = db.prepare(
      "INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,0,1 FROM categories WHERE slug='other'"
    )
    db.exec('BEGIN')
    for (const item of listings) {
      insertListing.run(
        item.id,
        item.slug,
        item.name,
        item.description,
        item.website,
        now,
        'c'.repeat(64)
      )
      fileUnderOther.run(item.id)
    }
    db.exec("UPDATE listings SET status='approved'")
    db.exec(
      `INSERT INTO publication_state (id,version,checksum,published_at) VALUES (1,1,'${'a'.repeat(64)}','${now}')`
    )
    db.exec('COMMIT')
    const liveCount = () =>
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=1")
          .get() as { count: number }
      ).count
    // The owner's dispatch order: #333's batches and its removals, then the three #340 manifests.
    const order = [
      ...committedOtherCategoryManifests().map(name => name.slice(0, -'.yaml'.length)),
      '2026-10-10-other-removals',
      ...Object.values(mismatchManifestIds)
    ]
    let before = 0
    for (const id of order) {
      if (id === mismatchManifestIds.removals) before = liveCount()
      const source = readFileSync(resolve('d1/publications', `${id}.yaml`), 'utf8')
      const state = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as {
        version: number
        checksum: string
      }
      const plan = buildPublicationPlan(parseManifest(source), source, now, state)
      expect(plan.statements.length, id).toBeLessThanOrEqual(STATEMENT_CEILING)
      db.exec('BEGIN')
      try {
        for (const statement of plan.statements) {
          assertD1StatementLimits(statement.query, statement.bindings)
          db.prepare(statement.query).run(
            ...statement.bindings.map(value =>
              typeof value === 'boolean' ? Number(value) : (value as SQLInputValue)
            )
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw new Error(`${id} does not apply: ${error}`)
      }
    }

    // The 127 removals are unpublished, and nothing else is.
    expect(liveCount()).toBe(before - 127)
    const state = db.prepare(
      `SELECT l.name,l.description,l.website,l.is_active,(SELECT json_group_array(slug) FROM
       (SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
        WHERE lc.listing_id=l.id ORDER BY lc.sort_order)) AS categories FROM listings l WHERE l.id=?`
    )
    const inventoryById = new Map(listings.map(item => [item.id, item]))
    for (const item of decided) {
      const row = state.get(item.id) as {
        categories: string
        description: string
        is_active: number
        name: string
        website: string
      }
      const original = inventoryById.get(item.id) as InventoryListing
      const removed = item.decision.startsWith('retire')
      expect(row.is_active, item.slug).toBe(removed ? 0 : 1)
      // Renames and the fix carry their new details; every other listing keeps its own.
      expect(
        { name: row.name, description: row.description, website: row.website },
        item.slug
      ).toEqual({
        name: item.details?.name ?? original.name,
        description: item.details?.description ?? original.description,
        website: item.details?.website ?? original.website
      })
      const moves =
        (item.decision === 'rename' || item.decision === 'fix-description') &&
        item.category !== undefined &&
        liveCategories.has(item.category)
      expect(JSON.parse(row.categories), item.slug).toEqual(moves ? [item.category] : ['other'])
    }
  })
})
