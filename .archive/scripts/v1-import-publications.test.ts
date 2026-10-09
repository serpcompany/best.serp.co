import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { LISTING_IN_RETIRED_CATEGORY_SQL } from '../apps/web/src/db/catalog-epoch'
import { isMediaKey, parseMediaKey } from '../apps/web/src/db/media-keys'
import { hasFileExtension } from '../apps/web/src/lib/seo/canonical-url'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher'
import {
  type AdultDecisions,
  adultDecisionsPathFor,
  adultManifestIds,
  applyManifest,
  buildAdultManifests,
  buildDeadDomainManifest,
  buildDecisionsManifest,
  buildUnpublishManifest,
  committedPublications,
  type DomainReport,
  decisionsPathFor,
  liveListings,
  type OwnerListDecisions,
  recheckPathFor,
  reviewedCatalogDatabase,
  reviewedImportListings
} from './listing-domain-check'
import { mediaPlanSchema } from './media-upload'
import { project } from './project'
import { ADULT_TERMS } from './migration/legacy-media'

/**
 * The committed publications (`d1/publications`), replayed on the v1 import (`d1/artifacts`),
 * the catalog staging and production were bootstrapped from. These tests check plans that are
 * already applied on both, against rows that exist only in the import, so they move to
 * `.archive/` with the import (serpcompany/best.serp.co#315). They came from
 * `catalog-media.test.ts` and `listing-domain-check.test.ts` (#314), which keep the checks of
 * code that still runs; the publisher's actions are tested on fixture rows in
 * `d1-publisher.sqlite.test.ts`.
 */

const publicationsDirectory = resolve('d1/publications')
const mediaDirectory = resolve('d1/media')
/** Written and removed by other tests while the suite runs. */
const transientFiles = new Set(['remote-publisher-media-test.yaml', 'remote-publisher-test.yaml'])

let importSql = ''
beforeAll(() => {
  importSql = readReviewedImportSql(readParityReport())
}, 60_000)

function importedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  database.exec(importSql)
  return database
}

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory)
    .filter(file => pattern.test(file) && !transientFiles.has(file))
    .sort()
}

function d1Binding(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as SQLInputValue
}

/**
 * Applies every reviewed manifest (or those `include` keeps) in file-name order, each as one
 * transaction: a row-level manifest at the version the previous ones left, as the publisher
 * plans it.
 */
function publishedDatabase(
  include: (manifest: ReturnType<typeof parseManifest>) => boolean = () => true
): DatabaseSync {
  const database = importedDatabase()
  for (const file of files(publicationsDirectory, /\.ya?ml$/u)) {
    const source = readFileSync(resolve(publicationsDirectory, file), 'utf8')
    const manifest = parseManifest(source)
    if (!include(manifest)) continue
    // A row-level manifest applies at whatever version the environment is at (#97 review B3).
    const live =
      manifest.concurrency === 'rows'
        ? (database
            .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
            .get() as {
            checksum: string
            version: number
          })
        : undefined
    const plan = buildPublicationPlan(manifest, source, '2026-10-06T00:00:00.000Z', live)
    database.exec('BEGIN IMMEDIATE;')
    try {
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        database.prepare(item.query).run(...item.bindings.map(d1Binding))
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw new Error(`${file} does not apply after the manifests before it: ${error}`)
    }
  }
  return database
}

/** A Markdown image (`![alt](url)`) or HTML image in listing content. */
const listingContentImage = /!\[[^\]]*\]\s*\(|<img\b|<picture\b/iu

interface MediaRow {
  bytes: number | null
  content_type: string | null
  height: number | null
  kind: string
  media_key: string | null
  sha256: string | null
  slug: string
  url: string
  width: number | null
}

describe('hosted catalog media on the v1 import (#95)', () => {
  it('hosts every published listing logo and image, and uploads every key a manifest names', () => {
    const database = publishedDatabase()
    try {
      const rows = database
        .prepare(
          `SELECT l.slug, m.kind, m.url, m.media_key, m.sha256, m.content_type, m.bytes, m.width,
             m.height
           FROM listing_media m JOIN listings l ON l.id = m.listing_id
           WHERE m.kind IN ('logo', 'image')
           ORDER BY l.slug, m.kind, m.sort_order`
        )
        .all() as unknown as MediaRow[]
      expect(rows.length).toBeGreaterThan(1_000)
      const hotlinked = rows
        .filter(row => !row.media_key || !isMediaKey(row.media_key))
        .map(row => `${row.slug} ${row.kind} ${row.url}`)
      expect(
        hotlinked,
        'Every listing logo and image must be a hosted key (docs/MEDIA.md). Repoint it with a listing-media-update manifest after uploading its plan, or drop it.'
      ).toEqual([])
      // A key on the media host, and its own: the listing's slug and the row's kind (#122).
      const foreign = rows.flatMap(row => {
        const key = parseMediaKey(row.media_key ?? '')
        return key?.scope === 'listings' && key.slug === row.slug && key.kind === row.kind
          ? []
          : [`${row.slug} ${row.kind} ${row.media_key}`]
      })
      expect(foreign, 'A listing row holds only its own listings/<slug>/<kind>/ key.').toEqual([])

      const uploaded = new Map<string, Record<string, unknown>>()
      for (const file of files(mediaDirectory, /\.json$/u)) {
        const plan = mediaPlanSchema.parse(
          JSON.parse(readFileSync(resolve(mediaDirectory, file), 'utf8'))
        )
        for (const object of plan.objects) uploaded.set(object.key, object)
      }
      const notUploaded = rows.flatMap(row => {
        const object = row.media_key ? uploaded.get(row.media_key) : undefined
        const same =
          object &&
          object.sha256 === row.sha256 &&
          object.bytes === row.bytes &&
          object.contentType === row.content_type &&
          object.width === row.width &&
          object.height === row.height
        return same ? [] : [`${row.slug} ${row.media_key}`]
      })
      expect(notUploaded, 'Each hosted key needs a matching object in a d1/media plan.').toEqual([])
    } finally {
      database.close()
    }
  }, 120_000)

  it('renders no image from listing content, imported or published (#122)', () => {
    const database = publishedDatabase()
    try {
      const embedded = (
        database.prepare('SELECT slug, content FROM listings WHERE content IS NOT NULL').all() as {
          content: string
          slug: string
        }[]
      )
        .filter(row => listingContentImage.test(row.content))
        .map(row => row.slug)
      expect(
        embedded,
        'Listing content may not embed images: they would render from another host, outside the hosted media and its fallback tile.'
      ).toEqual([])
    } finally {
      database.close()
    }
  }, 120_000)

  it('changes only listing logos and images when the manifests are applied', () => {
    // The other reviewed manifests (#100's unpublications, #105's FAQ move) are the baseline:
    // the media and category manifests may change nothing else on top of them. A manifest that
    // retires a category (#260) unpublishes listings the category manifests filed under it, so
    // it applies only after them: it is on neither side.
    const mediaOrCategories = (manifest: ReturnType<typeof parseManifest>) =>
      manifest.operations.every(
        op => op.action === 'listing-media-update' || op.action === 'listing-categories-add'
      )
    const retiresCategory = (manifest: ReturnType<typeof parseManifest>) =>
      manifest.operations.some(op => op.action === 'category-unpublish')
    const before = publishedDatabase(
      manifest => !mediaOrCategories(manifest) && !retiresCategory(manifest)
    )
    const after = publishedDatabase(manifest => !retiresCategory(manifest))
    try {
      for (const sql of [
        `SELECT id, slug, name, description, website, content, status, is_active, published_at,
           display_order, is_featured, checksum FROM listings ORDER BY id`,
        'SELECT * FROM categories ORDER BY id',
        'SELECT listing_id, label, url, sort_order FROM listing_resource_links ORDER BY listing_id, sort_order',
        'SELECT listing_id, question, answer, sort_order FROM listing_faqs ORDER BY listing_id, sort_order',
        "SELECT listing_id, url, sort_order FROM listing_media WHERE kind = 'video' ORDER BY listing_id"
      ]) {
        expect(after.prepare(sql).all(), sql).toEqual(before.prepare(sql).all())
      }
      // Category changes are only the Adult category added, never primary (#98 owner decision).
      const memberships = (db: DatabaseSync) =>
        db
          .prepare(
            `SELECT lc.listing_id, c.slug, lc.is_primary FROM listing_categories lc
             JOIN categories c ON c.id = lc.category_id ORDER BY lc.listing_id, c.slug`
          )
          .all() as Array<{ is_primary: number; listing_id: string; slug: string }>
      const key = (row: { listing_id: string; slug: string }) => `${row.listing_id} ${row.slug}`
      const existing = new Set(memberships(before).map(key))
      const added = memberships(after).filter(row => !existing.has(key(row)))
      expect(added.every(row => row.slug === 'adult' && row.is_primary === 0)).toBe(true)
      expect(added.length).toBeLessThanOrEqual(20)
      const kept = new Set(memberships(after).map(key))
      expect(memberships(before).filter(row => !kept.has(key(row)))).toEqual([])
    } finally {
      before.close()
      after.close()
    }
  }, 120_000)
})

describe('the listing domain manifests on the v1 import (#100, #104, #260)', () => {
  it('keeps each committed dead-domain manifest identical to its two committed checks', () => {
    const manifests = readdirSync(resolve('d1/publications')).filter(file =>
      file.endsWith('-dead-domains.yaml')
    )
    const listings = reviewedImportListings()
    for (const file of manifests) {
      const source = readFileSync(resolve('d1/publications', file), 'utf8')
      const manifest = parseManifest(source)
      const [, earlierPath, recheckPath] = source.match(/^# Evidence: (\S+) and (\S+)\.$/mu) ?? []
      expect(recheckPath, file).toBe(recheckPathFor(file.slice(0, 10)))
      const read = (path: string) =>
        parse(readFileSync(resolve(path as string), 'utf8')) as DomainReport
      expect(source, file).toBe(
        buildDeadDomainManifest(read(earlierPath), read(recheckPath), listings, {
          earlierPath: earlierPath as string,
          id: manifest.id,
          recheckPath: recheckPath as string
        })
      )
      // It applies, whole, to the reviewed catalog both environments started from.
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-07T00:00:00.000Z', live)
      database.exec('BEGIN')
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
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0`)
          .get()
      ).toEqual({ count: manifest.operations.length })
      database.close()
    }
  }, 60_000)

  it('keeps the committed manifest identical to the committed report and the reviewed catalog', () => {
    const reports = existsSync(resolve('d1/hygiene'))
      ? readdirSync(resolve('d1/hygiene')).filter(file => file.endsWith('-listing-domains.yaml'))
      : []
    expect(reports.length).toBeGreaterThan(0)
    const listings = reviewedImportListings()
    for (const file of reports) {
      const date = file.slice(0, 10)
      const committed = parse(readFileSync(resolve('d1/hygiene', file), 'utf8')) as DomainReport
      const manifestPath = resolve(`d1/publications/${date}-hijacked-domains.yaml`)
      const source = readFileSync(manifestPath, 'utf8')
      const manifest = parseManifest(source)
      // The manifest is exactly what the generator writes from the report and the catalog.
      expect(source, file).toBe(
        buildUnpublishManifest(committed, listings, {
          id: manifest.id,
          reportPath: `d1/hygiene/${file}`
        })
      )
      // It applies, whole, to the reviewed catalog both environments started from.
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      // Row-level: planned at the environment's live state, here the import's.
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-06T00:00:00.000Z', live)
      database.exec('BEGIN')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        const bindings = item.bindings.map(value =>
          typeof value === 'boolean' ? Number(value) : value
        ) as SQLInputValue[]
        database.prepare(item.query).run(...bindings)
      }
      database.exec('COMMIT')
      const ids = manifest.operations.map(operation => ('id' in operation ? operation.id : ''))
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0 AND id IN (${ids.map(() => '?').join(',')})`
          )
          .get(...ids)
      ).toEqual({ count: committed.unpublish.length })
      expect(database.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({
        count: committed.unpublish.length
      })
      expect(database.prepare('SELECT version FROM publication_state').get()).toEqual({
        version: live.version + 1
      })
      database.close()
      expect(
        committed.unpublish.every(entry => ['parking', 'gambling-spam'].includes(entry.class))
      ).toBe(true)
      expect(
        committed.ownerReview.some(entry => ['parking', 'gambling-spam'].includes(entry.class))
      ).toBe(false)
    }
  })

  it('keeps each committed owner-list cleanup identical to its decisions, and disjoint from other unpublications', () => {
    // Committed manifests only: d1-remote-publisher.test.ts writes temporary ones here.
    const publications = execFileSync('git', ['ls-files', 'd1/publications'], { encoding: 'utf8' })
      .split('\n')
      .filter(path => path.endsWith('.yaml'))
      .map(path => path.slice('d1/publications/'.length))
    const unpublished = new Map<string, string>()
    for (const file of publications) {
      if (file.endsWith('-owner-list-cleanup.yaml')) continue
      const manifest = parseManifest(readFileSync(resolve('d1/publications', file), 'utf8'))
      for (const operation of manifest.operations)
        if (operation.action === 'listing-unpublish') unpublished.set(operation.id, file)
    }
    const listings = reviewedImportListings()
    for (const file of publications.filter(name => name.endsWith('-owner-list-cleanup.yaml'))) {
      const source = readFileSync(resolve('d1/publications', file), 'utf8')
      const manifest = parseManifest(source)
      const decisionsPath = decisionsPathFor(file.slice(0, 10))
      const decisions = parse(readFileSync(resolve(decisionsPath), 'utf8')) as OwnerListDecisions
      expect(source, file).toBe(
        buildDecisionsManifest(decisions, listings, { decisionsPath, id: manifest.id })
      )
      // Another manifest's unpublish would leave the listing not live, and this one refuses whole.
      for (const operation of manifest.operations) {
        if (operation.action !== 'listing-unpublish')
          throw new Error(`${file}: ${operation.action}`)
        expect(unpublished.get(operation.id), operation.slug).toBeUndefined()
      }
      const database = new DatabaseSync(':memory:')
      for (const migration of freshMigrationNames())
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      database.exec(readReviewedImportSql(readParityReport()))
      const live = database
        .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(manifest, source, '2026-10-07T00:00:00.000Z', live)
      database.exec('BEGIN')
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
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM listings WHERE status='approved' AND is_active=0`)
          .get()
      ).toEqual({ count: manifest.operations.length })
      database.close()
    }
  }, 60_000)

  it('keeps the committed manifests identical to the decisions; they apply to the reviewed catalog, disjoint from other unpublications, and leave nothing adult or gone', () => {
    const decisionsFiles = readdirSync(resolve('d1/hygiene')).filter(file =>
      file.endsWith('-adult-decisions.yaml')
    )
    expect(decisionsFiles.length).toBeGreaterThan(0)
    for (const file of decisionsFiles) {
      const date = file.slice(0, 10)
      const decisionsPath = adultDecisionsPathFor(date)
      const ids = adultManifestIds(date)
      const decided = parse(readFileSync(resolve(decisionsPath), 'utf8')) as AdultDecisions
      // The catalog this decision's manifests are published on: every committed manifest that
      // sorts before them, never a later one (it may expect this decision's result).
      const database = reviewedCatalogDatabase(ids.categoryId)
      const inactive = () =>
        database
          .prepare('SELECT slug FROM categories WHERE is_active = 0')
          .all()
          .map(row => String(row.slug))
      try {
        const before = liveListings(database)
        const inactiveBefore = new Set(inactive())
        // Later manifests, this decision's own included, are not applied.
        for (const slug of decided.retireCategories)
          expect(inactiveBefore.has(slug), slug).toBe(false)
        const generated = buildAdultManifests(decided, before, { decisionsPath, ...ids })
        const committed = (id: string) => {
          const path = resolve(`d1/publications/${id}.yaml`)
          return existsSync(path) ? readFileSync(path, 'utf8') : null
        }
        expect(committed(ids.categoryId), ids.categoryId).toBe(generated.category)
        expect(committed(ids.removalId), ids.removalId).toBe(generated.removal)

        // Another manifest's unpublish, earlier or later, would leave a listing not live, and
        // whichever publishes second refuses whole.
        const elsewhere = new Map<string, string>()
        for (const path of committedPublications()) {
          const manifest = parseManifest(readFileSync(resolve(path), 'utf8'))
          if (manifest.id === ids.removalId) continue
          for (const operation of manifest.operations)
            if (operation.action === 'listing-unpublish') elsewhere.set(operation.id, path)
        }
        const removal = parseManifest(generated.removal)
        for (const operation of removal.operations)
          if (operation.action === 'listing-unpublish')
            expect(elsewhere.get(operation.id), operation.slug).toBeUndefined()

        // Published in order, the two apply whole; the plans stay within D1's limits.
        for (const source of [generated.category, generated.removal]) {
          if (!source) continue
          const live = database
            .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
            .get() as { checksum: string; version: number }
          for (const item of buildPublicationPlan(
            parseManifest(source),
            source,
            `${date}T00:00:00.000Z`,
            live
          ).statements)
            assertD1StatementLimits(item.query, item.bindings)
          applyManifest(database, source, `${date}T00:00:00.000Z`)
        }
        // Exactly the decided categories retire (Fansite Downloaders, which keeps listings, stays).
        expect(
          inactive()
            .filter(slug => !inactiveBefore.has(slug))
            .sort()
        ).toEqual([...decided.retireCategories].sort())
        const after = liveListings(database)
        expect(before.length - after.length).toBe(decided.unpublish.length)
        const live = new Map(after.map(item => [item.slug, item]))
        for (const entry of decided.unpublish) expect(live.has(entry.slug), entry.slug).toBe(false)
        // Kept listings stay live, off the retired categories.
        for (const entry of decided.kept) {
          expect(live.has(entry.slug), entry.slug).toBe(true)
          expect(
            database
              .prepare(
                `SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
                 JOIN listings l ON l.id = lc.listing_id WHERE l.slug = ? AND c.is_active = 0`
              )
              .all(entry.slug),
            entry.slug
          ).toEqual([])
        }
        // Nothing live is named for an adult platform any more (#98's list, and #260's find),
        // except a listing the owner keeps (the fan-site downloaders).
        const kept = new Set(decided.kept.map(entry => entry.slug))
        expect(
          after
            .filter(
              item =>
                !kept.has(item.slug) &&
                [item.slug, item.name, item.website].some(
                  value =>
                    ADULT_TERMS.test(value.toLowerCase()) || /shemale/u.test(value.toLowerCase())
                )
            )
            .map(item => item.slug)
        ).toEqual([])

        // The Worker's 410 check: every removed listing answers 404, other unpublished ones 410.
        const gone = (slug: string) =>
          database
            .prepare(
              `SELECT 1 AS found FROM listings l WHERE l.slug = ? AND l.status = 'approved'
                AND l.is_active = 0 AND l.published_at IS NOT NULL
                AND NOT ${LISTING_IN_RETIRED_CATEGORY_SQL}`
            )
            .get(slug) !== undefined
        for (const entry of decided.unpublish) expect(gone(entry.slug), entry.slug).toBe(false)
        const earlier = [...elsewhere].find(
          ([, path]) => path < `d1/publications/${ids.categoryId}.yaml`
        )
        const other = database
          .prepare('SELECT slug FROM listings WHERE id = ?')
          .get(earlier?.[0] ?? '')
        expect(gone(String(other?.slug)), String(other?.slug)).toBe(true)
      } finally {
        database.close()
      }
    }
  }, 120_000)
})

// Moved here from `scripts/d1-publisher.sqlite.test.ts` by #315: it read the import's parity report.
describe('slugs of the v1 import', () => {
  it('keeps every slug in the reviewed initial import a page URL', () => {
    const report = parse(readFileSync(resolve(project.artifact.parityReportPath), 'utf8')) as {
      parity: { categories: Array<{ slug: string }>; exactSlugSet: string[] }
    }
    expect(report.parity.exactSlugSet.length).toBeGreaterThan(3000)
    expect(report.parity.exactSlugSet.filter(value => hasFileExtension(value))).toEqual([])
    expect(
      report.parity.categories.map(category => category.slug).filter(hasFileExtension)
    ).toEqual([])
  })
})
