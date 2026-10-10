import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import {
  buildOtherCategoryManifests,
  type CategoryProposal,
  categorySetOperations,
  committedOtherCategoryManifests,
  type InventoryListing,
  otherCategoryDefaults,
  readOtherCategoryInputs
} from './other-categories-manifest.ts'

const live = new Set(['ai-chatbots', 'ai-seo', 'ai-copywriting'])
const inventory: InventoryListing[] = [
  { id: 'lst_aaaaaaaaaaaa', slug: 'a.ai', categories: ['other'] },
  { id: 'lst_bbbbbbbbbbbb', slug: 'b.ai', categories: ['other'] },
  { id: 'lst_cccccccccccc', slug: 'c.ai', categories: ['other'] }
]
const proposals: CategoryProposal[] = [
  { slug: 'a.ai', id: 'lst_aaaaaaaaaaaa', primary: 'ai-chatbots', secondary: ['ai-seo'] },
  { slug: 'b.ai', id: 'lst_bbbbbbbbbbbb', primary: 'other' },
  { slug: 'c.ai', id: 'lst_cccccccccccc', primary: 'ai-copywriting' }
]
const options = { ...otherCategoryDefaults, batchSize: 1 }

describe('the Other categorization manifests (#333)', () => {
  it('sets each proposal with a live primary, primary first, and leaves Other proposals out', () => {
    expect(categorySetOperations(proposals, inventory, live)).toEqual([
      {
        action: 'listing-categories-set',
        id: 'lst_aaaaaaaaaaaa',
        slug: 'a.ai',
        expected: ['other'],
        categories: ['ai-chatbots', 'ai-seo']
      },
      {
        action: 'listing-categories-set',
        id: 'lst_cccccccccccc',
        slug: 'c.ai',
        expected: ['other'],
        categories: ['ai-copywriting']
      }
    ])
  })

  it('numbers row-level batches in slug order, each one the publisher accepts', () => {
    const manifests = buildOtherCategoryManifests(proposals, inventory, live, options)
    expect(manifests.map(manifest => manifest.id)).toEqual([
      '2026-10-10-other-categories-01',
      '2026-10-10-other-categories-02'
    ])
    const [first] = manifests
    const parsed = parseManifest(first?.source ?? '')
    expect(parsed.concurrency).toBe('rows')
    expect(parsed.operations.map(operation => ('slug' in operation ? operation.slug : ''))).toEqual(
      ['a.ai']
    )
    expect(first?.source).toMatch(/^# serpcompany\/best\.serp\.co#333: file 1 listings/u)
  })

  it.each([
    ['a missing proposal', proposals.slice(0, 2), /c\.ai has no proposal/u],
    [
      'a listing proposed twice',
      [...proposals, proposals[0] as CategoryProposal],
      /proposed twice/u
    ],
    [
      'a listing outside the inventory',
      [...proposals, { slug: 'd.ai', id: 'lst_dddddddddddd', primary: 'ai-seo' }],
      /d\.ai is not in the inventory/u
    ],
    [
      'another listing id',
      [{ ...proposals[0], id: 'lst_zzzzzzzzzzzz' } as CategoryProposal, ...proposals.slice(1)],
      /proposal id lst_zzzzzzzzzzzz/u
    ],
    [
      'a category that is not live',
      [{ ...proposals[0], primary: 'ai-nope' } as CategoryProposal, ...proposals.slice(1)],
      /ai-nope is not a live category/u
    ],
    [
      'Other as a secondary',
      [{ ...proposals[0], secondary: ['other'] } as CategoryProposal, ...proposals.slice(1)],
      /Other is never a secondary/u
    ],
    [
      'a category named twice',
      [{ ...proposals[0], secondary: ['ai-chatbots'] } as CategoryProposal, ...proposals.slice(1)],
      /names a category twice/u
    ]
  ])('refuses %s', (_name, given, message) => {
    expect(() => categorySetOperations(given, inventory, live)).toThrow(message)
  })

  it('refuses a listing that is not filed under Other alone', () => {
    const moved = inventory.map(listing =>
      listing.slug === 'c.ai' ? { ...listing, categories: ['ai-seo'] } : listing
    )
    expect(() => categorySetOperations(proposals, moved, live)).toThrow(/not Other alone/u)
  })

  it('keeps the committed manifests identical to what the committed proposal generates', () => {
    const { proposals: committed, inventory: listings, liveCategories } = readOtherCategoryInputs()
    const manifests = buildOtherCategoryManifests(
      committed,
      listings,
      liveCategories,
      otherCategoryDefaults
    )
    expect(committedOtherCategoryManifests()).toEqual(manifests.map(({ id }) => `${id}.yaml`))
    for (const { id, source } of manifests)
      expect(readFileSync(resolve('d1/publications', `${id}.yaml`), 'utf8'), id).toBe(source)
  })

  it('moves every proposed listing out of Other when the committed batches replay', () => {
    const { proposals: committed, inventory: listings, liveCategories } = readOtherCategoryInputs()
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
    for (const listing of listings) {
      insertListing.run(
        listing.id,
        listing.slug,
        listing.slug,
        'Description',
        'https://example.com',
        now,
        'c'.repeat(64)
      )
      fileUnderOther.run(listing.id)
    }
    db.exec("UPDATE listings SET status='approved'")
    db.exec(
      `INSERT INTO publication_state (id,version,checksum,published_at) VALUES (1,1,'${'a'.repeat(64)}','${now}')`
    )
    db.exec('COMMIT')
    const count = (slug: string) =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM listing_categories lc JOIN categories c ON c.id=lc.category_id
             JOIN listings l ON l.id=lc.listing_id WHERE c.slug=? AND l.status='approved' AND l.is_active=1`
          )
          .get(slug) as { count: number }
      ).count
    expect(count('other')).toBe(listings.length)

    for (const name of committedOtherCategoryManifests()) {
      const source = readFileSync(resolve('d1/publications', name), 'utf8')
      const state = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as {
        version: number
        checksum: string
      }
      const plan = buildPublicationPlan(parseManifest(source), source, now, state)
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
        throw new Error(`${name} does not apply: ${error}`)
      }
    }

    const moving = committed.filter(proposal => proposal.primary !== 'other')
    expect(count('other')).toBe(listings.length - moving.length)
    const expected = new Map<string, number>()
    for (const proposal of moving)
      for (const slug of [proposal.primary, ...(proposal.secondary ?? [])])
        expected.set(slug, (expected.get(slug) ?? 0) + 1)
    for (const slug of liveCategories) expect(count(slug), slug).toBe(expected.get(slug) ?? 0)
    // Each listing is filed exactly as proposed, primary first, and stays published.
    const filed = db.prepare(
      `SELECT json_group_array(slug) AS categories FROM (SELECT c.slug FROM listing_categories lc
       JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? ORDER BY lc.sort_order)`
    )
    for (const proposal of moving)
      expect(JSON.parse((filed.get(proposal.id) as { categories: string }).categories)).toEqual([
        proposal.primary,
        ...(proposal.secondary ?? [])
      ])
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=1")
        .get()
    ).toEqual({ count: listings.length })
  })
})
