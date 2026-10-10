import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { parseMediaKey } from '../apps/web/src/db/media-keys'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, type HostedImageEntry, parseManifest } from './d1-publisher.ts'
import {
  ARCHIVED_REPO_MEDIA_COMMIT,
  hasRepoMediaArchive,
  isArchivedRepoMedia,
  readArchivedRepoMedia
} from './media-repo-archive'
import { type MediaPlanObject, mediaPlanSchema } from './media-upload'

/**
 * The guard for hosted listing media (serpcompany/best.serp.co#95) in every reviewed manifest
 * under `d1/publications`: each image it names is its own listing's hosted key (slug and kind),
 * and is in a reviewed upload plan under `d1/media` with the same bytes, so the upload that must
 * run first covers it and pages build its URL on the environment's media host. No manifest embeds
 * an image in listing content, so no other host is ever rendered (#122). Runs in `pnpm test:d1`,
 * which Publish D1 Catalog runs too. A listing's rows keep only its own keys after a
 * `listing-slug-change` too, checked on fixture rows. (Until #315 the same checks also ran on the
 * catalog the manifests left on the v1 import, now archived in
 * `.archive/scripts/v1-import-publications.test.ts`.)
 */
const publicationsDirectory = resolve('d1/publications')
const mediaDirectory = resolve('d1/media')
/** Written and removed by other tests while the suite runs. */
const transientFiles = new Set(['remote-publisher-media-test.yaml', 'remote-publisher-test.yaml'])

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory)
    .filter(file => pattern.test(file) && !transientFiles.has(file))
    .sort()
}

/** Each listing a reviewed manifest writes: its content and the images it names. */
function manifestTargets(): Array<{
  at: string
  content: string | undefined
  images: Array<readonly ['image' | 'logo', HostedImageEntry]>
  slug: string
}> {
  return files(publicationsDirectory, /\.ya?ml$/u).flatMap(file =>
    parseManifest(readFileSync(resolve(publicationsDirectory, file), 'utf8')).operations.flatMap(
      (op, index) => {
        const target =
          op.action === 'listing-create' || op.action === 'listing-update'
            ? { content: op.listing.content, media: op.listing.media, slug: op.listing.slug }
            : op.action === 'listing-media-update'
              ? { content: undefined, media: op.media, slug: op.slug }
              : null
        if (!target) return []
        const images = [
          ...(target.media?.logo ? [['logo', target.media.logo] as const] : []),
          ...(target.media?.images ?? []).map(image => ['image', image] as const)
        ]
        return [
          {
            at: `${file} operation ${index + 1}`,
            content: target.content,
            images,
            slug: target.slug
          }
        ]
      }
    )
  )
}

/** A Markdown image (`![alt](url)`) or HTML image in listing content. */
const listingContentImage = /!\[[^\]]*\]\s*\(|<img\b|<picture\b/iu

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

/** Listing logo and image rows whose hosted key is not the listing's own slug and kind (#122). */
function foreignMediaKeys(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      `SELECT l.slug, m.kind, m.media_key FROM listing_media m JOIN listings l ON l.id = m.listing_id
       WHERE m.kind IN ('logo', 'image') AND m.media_key IS NOT NULL
       ORDER BY l.slug, m.kind, m.sort_order`
    )
    .all() as Array<{ kind: string; media_key: string; slug: string }>
  return rows.flatMap(row => {
    const key = parseMediaKey(row.media_key)
    return key?.scope === 'listings' && key.slug === row.slug && key.kind === row.kind
      ? []
      : [`${row.slug} ${row.kind} ${row.media_key}`]
  })
}

/** Applies a manifest as the publisher's batch would, in one transaction. */
function publish(database: DatabaseSync, manifest: Record<string, unknown>): void {
  const source = stringify(manifest)
  const parsed = parseManifest(source)
  const live = database
    .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
    .get() as { checksum: string; version: number }
  const plan = buildPublicationPlan(parsed, source, '2026-10-10T00:00:00.000Z', live)
  database.exec('BEGIN')
  try {
    for (const item of plan.statements) {
      const bindings = item.bindings.map(value =>
        typeof value === 'boolean' ? Number(value) : value
      ) as SQLInputValue[]
      database.prepare(item.query).run(...bindings)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

describe('hosted catalog media (#95)', () => {
  it('lets manifests name only hosted keys of their own listing, or no image (#122)', () => {
    const problems: string[] = []
    let named = 0
    for (const target of manifestTargets()) {
      const { at } = target
      for (const [kind, image] of target.images) {
        named += 1
        const key = parseMediaKey(image.key)
        if (key?.scope !== 'listings' || key.slug !== target.slug || key.kind !== kind)
          problems.push(`${at}: ${kind} ${image.key} is not ${target.slug}'s hosted ${kind}`)
        // Where the bytes came from is provenance, never rendered: a public https URL or a
        // file checked in under apps/web/public.
        if (!/^(?:https:\/\/|repo:apps\/web\/public\/)/u.test(image.source))
          problems.push(`${at}: ${kind} source ${image.source} is not https or repo:`)
      }
      if (target.content && listingContentImage.test(target.content))
        problems.push(`${at}: content embeds an image`)
    }
    expect(named).toBeGreaterThan(1_000)
    expect(
      problems,
      'A manifest image is a hosted listings/<slug>/<kind>/ key with its plan (docs/MEDIA_PUBLISHING.md#uploading-and-publishing).'
    ).toEqual([])
  })

  it('uploads every key a manifest names, with the bytes the manifest records', () => {
    // The publisher writes a manifest image's key and metadata to the listing as they are, so
    // the object a reviewed upload plan puts at that key must match them.
    const uploaded = new Map<string, MediaPlanObject>()
    for (const file of files(mediaDirectory, /\.json$/u)) {
      const plan = mediaPlanSchema.parse(
        JSON.parse(readFileSync(resolve(mediaDirectory, file), 'utf8'))
      )
      for (const object of plan.objects) uploaded.set(object.key, object)
    }
    const notUploaded = manifestTargets().flatMap(({ at, images }) =>
      images.flatMap(([kind, image]) => {
        const object = uploaded.get(image.key)
        const same =
          object &&
          object.sha256 === image.sha256 &&
          object.bytes === image.bytes &&
          object.contentType === image.contentType &&
          object.width === image.width &&
          object.height === image.height
        return same ? [] : [`${at}: ${kind} ${image.key}`]
      })
    )
    expect(notUploaded, 'Each hosted key needs a matching object in a d1/media plan.').toEqual([])
  })

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
  // after the production publish keeps its reviewed bytes in Git (docs/MEDIA_PUBLISHING.md,
  // "Legacy migration"). Publish D1 Catalog and the deploys check out one commit, so CI's `check`
  // job (full history) checks this.
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

  // #314 review: with the v1 import archived (#315), this is the check that a slug change never
  // leaves a listing's media under its old slug, on fixture rows instead of the import's.
  it('leaves no listing media keyed to an old slug after a listing-slug-change', () => {
    const hashed = (slug: string, digit: string): HostedImageEntry => ({
      bytes: 2048,
      contentType: 'image/png',
      height: 128,
      key: `best.serp.co/listings/${slug}/logo/${digit.repeat(16)}.png`,
      sha256: digit.repeat(64),
      source: 'https://fixture.test/logo.png',
      width: 128
    })
    const before = hashed('fixture-old', 'a')
    const database = new DatabaseSync(':memory:')
    try {
      for (const migration of freshMigrationNames()) {
        database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
      }
      database.exec(`
        PRAGMA foreign_keys=ON;
        INSERT INTO categories (id,slug,name) VALUES (1,'seo','SEO');
        INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum)
          VALUES ('lst_fixture_media','fixture-old','Fixture','A fixture listing.','https://fixture.test/','draft','2026-10-01','fixture','fixture','${'c'.repeat(64)}');
        INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) VALUES ('lst_fixture_media',1,0,1);
        INSERT INTO listing_media (listing_id,kind,url,sort_order,media_key,sha256,content_type,bytes,width,height)
          VALUES ('lst_fixture_media','logo','${before.source}',0,'${before.key}','${before.sha256}','image/png',2048,128,128);
        UPDATE listings SET status='approved' WHERE id='lst_fixture_media';
        INSERT INTO publication_state (id,version,manifest_id,checksum,published_at) VALUES (1,1,NULL,'${'b'.repeat(64)}','2026-10-01T00:00:00.000Z');
      `)
      expect(foreignMediaKeys(database)).toEqual([])
      const provenance = { actor: 'fixture@example.test', workflow: 'test/catalog-media' }

      // The publisher renames the listing and keeps its rows: the logo is now another slug's key,
      // which pages would still build and the media health check reports as foreign_key.
      publish(database, {
        version: 1,
        id: 'fixture-rename',
        basePublicationVersion: 1,
        provenance: { ...provenance, beforeChecksum: 'b'.repeat(64) },
        operations: [
          {
            action: 'listing-slug-change',
            id: 'lst_fixture_media',
            from: 'fixture-old',
            to: 'fixture-new',
            categories: ['seo'],
            reason: 'Rename'
          }
        ]
      })
      expect(foreignMediaKeys(database)).toEqual([`fixture-new logo ${before.key}`])

      // So a rename ships with a media update that re-hosts its images under the new slug.
      publish(database, {
        version: 1,
        id: 'fixture-rename-media',
        concurrency: 'rows',
        provenance,
        operations: [
          {
            action: 'listing-media-update',
            id: 'lst_fixture_media',
            slug: 'fixture-new',
            expected: [{ kind: 'logo', url: before.source, key: before.key }],
            media: { logo: hashed('fixture-new', 'b') }
          }
        ]
      })
      expect(foreignMediaKeys(database)).toEqual([])
    } finally {
      database.close()
    }

    // Every committed rename is followed by a media update of that listing under its new slug.
    const manifests = files(publicationsDirectory, /\.ya?ml$/u).map(file =>
      parseManifest(readFileSync(resolve(publicationsDirectory, file), 'utf8'))
    )
    const unmoved = manifests.flatMap((manifest, index) =>
      manifest.operations.flatMap(op =>
        op.action === 'listing-slug-change' &&
        !manifests
          .slice(index + 1)
          .some(later =>
            later.operations.some(
              next =>
                next.action === 'listing-media-update' && next.id === op.id && next.slug === op.to
            )
          )
          ? [`${manifest.id}: ${op.from} -> ${op.to}`]
          : []
      )
    )
    expect(
      unmoved,
      'Re-host a renamed listing’s media under its new slug (docs/MEDIA.md).'
    ).toEqual([])
  })
})
