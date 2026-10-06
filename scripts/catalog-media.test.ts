import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { isMediaKey } from '@serpdirectory/data-ops/media-keys'
import { assertD1StatementLimits } from '@serpdirectory/data-ops/sql-limits'
import { beforeAll, describe, expect, it } from 'vitest'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from './d1-import-artifact'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import {
  ARCHIVED_REPO_MEDIA_COMMIT,
  hasRepoMediaArchive,
  isArchivedRepoMedia,
  readArchivedRepoMedia
} from './media-repo-archive'
import { type MediaPlanObject, mediaPlanSchema } from './media-upload'

/**
 * The guard for hosted listing media (serpcompany/best.serp.co#95): in the catalog production and
 * staging publish (the committed import with every reviewed manifest under `d1/publications`
 * applied in order, as the publisher would), every listing logo and image is a hosted key, so
 * pages build its URL on the environment's media host and nothing is hotlinked; and every key a
 * manifest names is in a reviewed upload plan under `d1/media` with the same bytes, so the upload
 * that must run first covers it. Runs in `pnpm test:d1`, which Publish D1 Catalog runs too.
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

/** Every `repo:` source of every reviewed upload plan, with its repository-relative path. */
function repoSources(): Array<{ object: MediaPlanObject; path: string }> {
  return files(mediaDirectory, /\.json$/u).flatMap(file =>
    mediaPlanSchema
      .parse(JSON.parse(readFileSync(resolve(mediaDirectory, file), 'utf8')))
      .objects.filter(object => object.source.startsWith('repo:'))
      .map(object => ({ object, path: object.source.slice('repo:'.length) }))
  )
}

function trackedPublicFiles(): Set<string> {
  return new Set(
    execFileSync('git', ['ls-files', '-z', '--', 'apps/web/public'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
  )
}

function expectPlannedBytes(path: string, bytes: Uint8Array, object: MediaPlanObject): void {
  expect(bytes.byteLength, path).toBe(object.bytes)
  expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(object.sha256)
  expect(createHash('md5').update(bytes).digest('hex'), path).toBe(object.md5)
}

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

describe('hosted catalog media (#95)', () => {
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

  it('checks in every live repo: source, holding exactly the planned bytes (#95 release blocker 5)', () => {
    // A seed a global ignore (`*.so`) kept out of Git failed Upload Listing Media with
    // `repo_file_missing` (run 37495034303): every repo: file must be tracked, not just on disk.
    // Files deleted after the production publish (#124) stay out of the tree.
    const tracked = trackedPublicFiles()
    for (const { object, path } of repoSources()) {
      if (isArchivedRepoMedia(path)) continue
      expect(tracked.has(path), `${path} is tracked`).toBe(true)
      expectPlannedBytes(path, readFileSync(resolve(path)), object)
    }
    expect(
      [...tracked].filter(isArchivedRepoMedia),
      'Nothing is checked in again under a directory deleted in #124.'
    ).toEqual([])
  })

  // The committed plan stays the record of what was uploaded: a file it names that was deleted
  // after the production publish keeps its reviewed bytes in Git (docs/MEDIA.md, "Legacy
  // migration"). Publish D1 Catalog and the deploys check out one commit, so PR Review (full
  // history) checks this.
  it.skipIf(!hasRepoMediaArchive())(
    'keeps every deleted repo: source in Git history at exactly the planned bytes (#124)',
    () => {
      const archived = repoSources().filter(({ path }) => isArchivedRepoMedia(path))
      expect(archived.length).toBeGreaterThan(0)
      for (const { object, path } of archived) {
        const bytes = readArchivedRepoMedia(path)
        expect(bytes, `${path} at ${ARCHIVED_REPO_MEDIA_COMMIT}`).not.toBeNull()
        expectPlannedBytes(path, bytes ?? new Uint8Array(), object)
      }
    }
  )

  it('changes only listing logos and images when the manifests are applied', () => {
    // The other reviewed manifests (#100's unpublications, #105's FAQ move) are the baseline:
    // the media and category manifests may change nothing else on top of them.
    const mediaOrCategories = (manifest: ReturnType<typeof parseManifest>) =>
      manifest.operations.every(
        op => op.action === 'listing-media-update' || op.action === 'listing-categories-add'
      )
    const before = publishedDatabase(manifest => !mediaOrCategories(manifest))
    const after = publishedDatabase()
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
