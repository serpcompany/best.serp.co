import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { assertD1StatementLimits } from '@serpdirectory/data-ops/sql-limits'
import { describe, expect, it } from 'vitest'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher'
import {
  buildFaqMoveManifest,
  FAQ_MANIFEST_ID,
  FAQ_MANIFEST_PATH,
  type FaqListing,
  faqBlockSuffix,
  manifestPath,
  reviewedImportFaqListings
} from './listing-faq-move'

/**
 * #105: the imported FAQs leave the long descriptions for the FAQs section. The generator removes
 * only each description's closing FAQ block, and the committed manifest is exactly what it writes
 * from the reviewed import. It is row-level, so it applies whatever was published before it.
 */
const publications = 'd1/publications'
const HIJACKED_DOMAINS_PATH = `${publications}/2026-10-06-hijacked-domains.yaml`

const faqs = [
  { answer: 'Yes, in your browser.', question: 'Is it free?' },
  { answer: 'Saved under OnlyFans/{creator}.', question: 'Where do files go?' }
]
// As the import wrote it: MDX braces escaped.
const block =
  '## FAQ\n\n### Is it free?\n\nYes, in your browser.\n\n### Where do files go?\n\nSaved under OnlyFans/\\{creator\\}.'
const listing = (content: string): FaqListing => ({ content, faqs, id: 'lst_x', slug: 'x.example' })

describe('the FAQ block a description loses', () => {
  it('is the blank line and the closing block, exactly', () => {
    expect(faqBlockSuffix(listing(`## Overview\n\nA tool 🚀.\n\n${block}`))).toBe(`\n\n${block}`)
  })

  it('requires the import’s exact text, MDX brace escapes included', () => {
    const unescaped = block.replace('\\{creator\\}', '{creator}')
    expect(() => faqBlockSuffix(listing(`Intro.\n\n${unescaped}`))).toThrow(/doesn't match/u)
  })

  it.each([
    ['there is no FAQ heading', 'Intro.\n\n## Overview\n\nText.', /found 0/u],
    ['there are two', `Intro.\n\n${block}\n\n${block}`, /found 2/u],
    ['a section follows it', `Intro.\n\n${block}\n\n## Notes\n\nMore.`, /last section/u],
    ['it lacks a blank line before it', `Intro.\n${block}`, /blank line/u],
    ['an answer differs', `Intro.\n\n${block.replace('Yes,', 'No,')}`, /doesn't match/u],
    ['it holds more than the FAQs', `Intro.\n\n${block}\n\nAn extra line.`, /doesn't match/u]
  ])('is refused when %s', (_name, content, message) => {
    expect(() => faqBlockSuffix(listing(content))).toThrow(message)
  })
})

describe('the committed FAQ manifest', () => {
  const listings = reviewedImportFaqListings()
  const source = readFileSync(resolve(FAQ_MANIFEST_PATH), 'utf8')
  const manifest = parseManifest(source)

  it('is exactly what the generator writes, row-level with no base', () => {
    expect(manifest.concurrency).toBe('rows')
    expect(manifest.basePublicationVersion).toBeUndefined()
    expect(manifest.provenance.beforeChecksum).toBeUndefined()
    expect(source).toBe(buildFaqMoveManifest(listings, { id: FAQ_MANIFEST_ID }))
    expect(listings).toHaveLength(335)
    expect(listings.reduce((total, item) => total + item.faqs.length, 0)).toBe(2254)
  })

  it.each([
    ['after #100’s', [HIJACKED_DOMAINS_PATH]],
    [
      'after #100’s and #98’s',
      readdirSync(resolve(publications))
        .filter(file => file.endsWith('.yaml') && !file.includes('listing-faqs'))
        .sort()
        .map(file => `${publications}/${file}`)
    ]
  ])('applies %s to the reviewed catalog, removing only the FAQ blocks', (_name, previous) => {
    const database = new DatabaseSync(':memory:')
    for (const migration of freshMigrationNames())
      database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    database.exec(readReviewedImportSql(readParityReport()))
    const contents = () =>
      new Map(
        (
          database
            .prepare("SELECT id, COALESCE(content,'') AS content FROM listings")
            .all() as Array<{
            content: string
            id: string
          }>
        ).map(row => [row.id, row.content])
      )
    const faqRows = () =>
      database
        .prepare(
          'SELECT listing_id,question,answer,sort_order FROM listing_faqs ORDER BY listing_id,sort_order'
        )
        .all()
    const apply = (path: string) => {
      const text = readFileSync(resolve(path), 'utf8')
      const parsed = parseManifest(text)
      const live =
        parsed.concurrency === 'rows'
          ? (database.prepare('SELECT version, checksum FROM publication_state').get() as {
              checksum: string
              version: number
            })
          : undefined
      const plan = buildPublicationPlan(parsed, text, '2026-10-06T00:00:00.000Z', live)
      database.exec('DROP TABLE IF EXISTS publication_guard; BEGIN')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        database
          .prepare(item.query)
          .run(
            ...(item.bindings.map(value =>
              typeof value === 'boolean' ? Number(value) : value
            ) as SQLInputValue[])
          )
      }
      database.exec('COMMIT')
    }
    for (const path of previous) apply(path)
    const before = contents()
    const faqsBefore = faqRows()
    const versionBefore = (
      database.prepare('SELECT version FROM publication_state').get() as { version: number }
    ).version
    apply(FAQ_MANIFEST_PATH)
    const after = contents()
    const moved = new Map(
      manifest.operations.map(operation =>
        operation.action === 'listing-content-remove-suffix'
          ? [operation.id, operation.suffix]
          : ['', '']
      )
    )
    for (const [id, content] of before) {
      const suffix = moved.get(id)
      // Every other character stays; listings without FAQs are untouched.
      expect(after.get(id), id).toBe(
        suffix ? content.slice(0, content.length - suffix.length) : content
      )
      if (suffix) expect(content.endsWith(suffix), id).toBe(true)
    }
    for (const item of listings) {
      const content = after.get(item.id) ?? ''
      expect(content, item.slug).not.toMatch(/^## FAQ$/mu)
      for (const faq of item.faqs)
        expect(content.includes(`### ${faq.question}`), item.slug).toBe(false)
    }
    // The FAQs themselves stay, for the FAQs section.
    expect(faqRows()).toEqual(faqsBefore)
    expect(database.prepare('SELECT version FROM publication_state').get()).toEqual({
      version: versionBefore + 1
    })
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_events WHERE event_type='edited' AND detail LIKE '%#105%'"
        )
        .get()
    ).toEqual({ count: 335 })
    database.close()
  })
})

describe('regenerating for an environment that has moved on', () => {
  const listings: FaqListing[] = [
    { ...listing(`Intro.\n\n${block}`), id: 'lst_aaaaaaaaaa', slug: 'a.example' },
    { ...listing(`Other.\n\n${block}`), id: 'lst_bbbbbbbbbb', slug: 'b.example' }
  ]
  const options = { id: '2026-10-07-listing-faqs-staging' }

  it('writes each manifest id to its own file, keeping the reviewed one', () => {
    expect(manifestPath(options.id)).toBe('d1/publications/2026-10-07-listing-faqs-staging.yaml')
    expect(manifestPath(FAQ_MANIFEST_ID)).toBe(FAQ_MANIFEST_PATH)
  })

  it('leaves out skipped listings, and says so', () => {
    const source = buildFaqMoveManifest(listings, { ...options, skip: ['b.example'] })
    const manifest = parseManifest(source)
    expect(manifest).toMatchObject({ concurrency: 'rows', id: options.id })
    expect(
      manifest.operations.map(operation => ('slug' in operation ? operation.slug : ''))
    ).toEqual(['a.example'])
    expect(source).toContain('# Left out (their description drifted there): b.example.')
  })

  it('refuses to skip a listing it doesn’t know', () => {
    expect(() => buildFaqMoveManifest(listings, { ...options, skip: ['c.example'] })).toThrow(
      /names no listing/u
    )
  })
})
