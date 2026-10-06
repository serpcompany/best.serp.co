import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { assertD1StatementLimits } from '@serpdirectory/data-ops/sql-limits'
import { beforeAll, describe, expect, it } from 'vitest'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, type PublicationManifest, parseManifest } from './d1-publisher.ts'
import { project } from './project'

/**
 * A listing logo, image, or video stored as a root-relative path (`/media/products/...`,
 * `/listing-logos/...`) is served from the Worker's static assets, so the file must be checked
 * in under `apps/web/public` (serpcompany/best.serp.co#89). The catalog checked is the one
 * production publishes: the committed import with every reviewed manifest under
 * `d1/publications` applied in file-name order. `pnpm test:d1` also runs in Publish D1 Catalog
 * before a manifest is applied.
 */
const publicDirectory = resolve(project.appDirectory, 'public')
const publicationsDirectory = resolve('d1/publications')
/** Written and removed by scripts/d1-remote-publisher.test.ts while the suite runs. */
const transientTestManifests = new Set(['remote-publisher-test.yaml'])

const missingImagesManifest = '2026-10-06-missing-product-images.yaml'
/** The two files that never existed anywhere; #89's manifest drops their references. */
const neverCreated = [
  { slug: 'dr.serp.co', url: '/media/products/dr.serp.co/logo.png' },
  {
    slug: 'onlyfans-downloader',
    url: '/media/products/onlyfans-downloader/onlyfans-downloader-1.jpg'
  }
]

interface Publication {
  file: string
  manifest: PublicationManifest
  source: string
}

interface PublicListing {
  slug: string
  urls: string[]
}

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

function reviewedPublications(): Publication[] {
  return readdirSync(publicationsDirectory)
    .filter(file => /\.ya?ml$/u.test(file) && !transientTestManifests.has(file))
    .sort()
    .map(file => {
      const source = readFileSync(resolve(publicationsDirectory, file), 'utf8')
      return { file, manifest: parseManifest(source), source }
    })
}

/** Public listings by id with their media URLs, after applying the manifests' listing changes. */
function publishedMedia(
  database: DatabaseSync,
  publications: Publication[]
): Map<string, PublicListing> {
  const listings = new Map<string, PublicListing>()
  const rows = database
    .prepare(
      `SELECT l.id, l.slug, m.url FROM listings l
       LEFT JOIN listing_media m ON m.listing_id = l.id
       WHERE l.status = 'approved' AND l.is_active = 1
       ORDER BY l.id, m.kind, m.sort_order`
    )
    .all() as Array<{ id: string; slug: string; url: string | null }>
  for (const row of rows) {
    const listing = listings.get(row.id) ?? { slug: row.slug, urls: [] }
    if (row.url) listing.urls.push(row.url)
    listings.set(row.id, listing)
  }
  for (const { manifest } of publications) {
    for (const op of manifest.operations) {
      if (op.action === 'listing-create' || op.action === 'listing-update') {
        const media = op.listing.media
        listings.set(op.listing.id, {
          slug: op.listing.slug,
          urls: [media?.logo, ...(media?.images ?? []), media?.video].filter((url): url is string =>
            Boolean(url)
          )
        })
      }
      if (op.action === 'listing-unpublish') listings.delete(op.id)
      if (op.action === 'listing-slug-change') {
        const listing = listings.get(op.id)
        if (listing) listing.slug = op.to
      }
    }
  }
  return listings
}

function isRootRelative(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

/** `slug url` for every root-relative media URL with no file under apps/web/public. */
function missingStaticAssets(listings: Map<string, PublicListing>): string[] {
  const missing: string[] = []
  for (const { slug, urls } of listings.values()) {
    for (const url of urls.filter(isRootRelative)) {
      const file = resolve(publicDirectory, `.${decodeURIComponent(url.split(/[?#]/u)[0] ?? '')}`)
      const inside = !relative(publicDirectory, file).startsWith('..')
      let exists = false
      try {
        exists = inside && statSync(file).isFile()
      } catch {
        exists = false
      }
      if (!exists) missing.push(`${slug} ${url}`)
    }
  }
  return missing.sort()
}

/** Every listing's public fields and child rows, keyed by id, for before/after comparison. */
function catalogProjection(database: DatabaseSync): Map<string, Record<string, unknown>> {
  const listings = new Map<string, Record<string, unknown>>()
  const child = (id: string, key: string, value: unknown) => {
    const values = listings.get(id)?.[key]
    if (Array.isArray(values)) values.push(value)
  }
  for (const row of database
    .prepare(
      `SELECT id, slug, name, description, website, content, entity_type, priority,
         is_unofficial, is_featured, is_active, status, published_at, display_order, source,
         link_rel, created_at
       FROM listings ORDER BY id`
    )
    .all() as Array<Record<string, unknown> & { id: string }>) {
    listings.set(row.id, { ...row, categories: [], media: [], resources: [], faqs: [] })
  }
  for (const row of database
    .prepare(
      `SELECT lc.listing_id, c.slug, lc.is_primary FROM listing_categories lc
       JOIN categories c ON c.id = lc.category_id ORDER BY lc.listing_id, lc.sort_order`
    )
    .all() as Array<{ is_primary: number; listing_id: string; slug: string }>) {
    child(row.listing_id, 'categories', [row.slug, row.is_primary])
  }
  for (const row of database
    .prepare(
      'SELECT listing_id, kind, url FROM listing_media ORDER BY listing_id, kind, sort_order'
    )
    .all() as Array<{ kind: string; listing_id: string; url: string }>) {
    child(row.listing_id, 'media', `${row.kind} ${row.url}`)
  }
  for (const row of database
    .prepare(
      'SELECT listing_id, label, url FROM listing_resource_links ORDER BY listing_id, sort_order'
    )
    .all() as Array<{ label: string; listing_id: string; url: string }>) {
    child(row.listing_id, 'resources', [row.label, row.url])
  }
  for (const row of database
    .prepare(
      'SELECT listing_id, question, answer FROM listing_faqs ORDER BY listing_id, sort_order'
    )
    .all() as Array<{ answer: string; listing_id: string; question: string }>) {
    child(row.listing_id, 'faqs', [row.question, row.answer])
  }
  return listings
}

/**
 * Public slugs in publication order (`PUBLICATION_ORDER` in packages/data-ops/src/catalog.ts),
 * all listings and featured ones. `published_at` is compared as text, so a manifest that rewrote
 * an imported `2026-05-16` as an ISO instant would move that listing to the top.
 */
function publicationOrder(database: DatabaseSync): { all: string[]; featured: string[] } {
  const slugs = (featuredOnly: boolean) =>
    (
      database
        .prepare(
          `SELECT slug FROM listings
           WHERE status = 'approved' AND is_active = 1 AND published_at IS NOT NULL
             AND (? = 0 OR is_featured = 1)
           ORDER BY published_at DESC, display_order ASC, slug ASC`
        )
        .all(featuredOnly ? 1 : 0) as Array<{ slug: string }>
    ).map(row => row.slug)
  return { all: slugs(false), featured: slugs(true) }
}

/** D1 binds JavaScript booleans as integers; node:sqlite requires the conversion explicitly. */
function d1Binding(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as SQLInputValue
}

describe('catalog media assets (#89)', () => {
  it('serves every root-relative listing logo, image, and video as a checked-in file', () => {
    const database = importedDatabase()
    try {
      const listings = publishedMedia(database, reviewedPublications())
      const rootRelative = [...listings.values()].flatMap(({ urls }) => urls.filter(isRootRelative))

      // 78 /listing-logos logos and 51 /media/products references after #89.
      expect(rootRelative.length).toBeGreaterThan(120)
      expect(
        missingStaticAssets(listings),
        'Check the file into apps/web/public at that path, or publish a d1/publications manifest that repoints or drops the reference.'
      ).toEqual([])
    } finally {
      database.close()
    }
  }, 60_000)

  it('finds exactly the two never-created files in the import, which the #89 manifest drops', () => {
    // Local and staging D1 are seeded from the import and never receive manifests (only
    // production does), so those two references keep answering 404 there.
    const database = importedDatabase()
    try {
      expect(missingStaticAssets(publishedMedia(database, []))).toEqual(
        neverCreated.map(({ slug, url }) => `${slug} ${url}`)
      )
    } finally {
      database.close()
    }
  }, 60_000)

  it('changes only those two media references when applied to the import', () => {
    const source = readFileSync(resolve(publicationsDirectory, missingImagesManifest), 'utf8')
    const manifest = parseManifest(source)
    const database = importedDatabase()
    try {
      const before = catalogProjection(database)
      const orderBefore = publicationOrder(database)
      const categoriesBefore = database.prepare('SELECT * FROM categories ORDER BY id').all()
      const plan = buildPublicationPlan(manifest, source, '2026-10-06T00:00:00.000Z')

      database.exec('BEGIN IMMEDIATE')
      for (const item of plan.statements) {
        assertD1StatementLimits(item.query, item.bindings)
        database.prepare(item.query).run(...item.bindings.map(d1Binding))
      }
      database.exec('COMMIT')

      const expected = new Map(before)
      for (const { slug, url } of neverCreated) {
        const [id, listing] = [...before].find(([, value]) => value.slug === slug) ?? []
        expect(listing, slug).toBeTruthy()
        if (!id || !listing) continue
        expected.set(id, {
          ...listing,
          media: (listing.media as string[]).filter(entry => !entry.endsWith(` ${url}`))
        })
      }
      expect(catalogProjection(database)).toEqual(expected)
      // Lists, Featured, Recently added, RSS, and previous/next keep their order.
      expect(publicationOrder(database)).toEqual(orderBefore)
      expect(database.prepare('SELECT * FROM categories ORDER BY id').all()).toEqual(
        categoriesBefore
      )
      expect(
        database.prepare('SELECT version, manifest_id FROM publication_state WHERE id = 1').get()
      ).toEqual({ version: 2, manifest_id: manifest.id })
      expect(
        database.prepare('SELECT outcome, published_version FROM publication_runs').all()
      ).toEqual([{ outcome: 'succeeded', published_version: 2 }])
    } finally {
      database.close()
    }
  }, 60_000)
})
