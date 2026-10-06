import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { IMAGE_CONTENT_TYPES, sniffImage } from '@serpdirectory/data-ops/media-format'
import {
  type FetchedImage,
  fetchImage,
  type MediaFailure
} from '@serpdirectory/data-ops/media-ingest'
import { type MediaKind, mediaKey } from '@serpdirectory/data-ops/media-keys'
import { safeFetch } from '@serpdirectory/data-ops/safe-fetch'
import {
  iconCandidates,
  metaRefreshUrl,
  parseSiteMetadata
} from '@serpdirectory/data-ops/site-metadata'
import { stringify } from 'yaml'
import { freshMigrationNames, freshMigrationsDirectory } from '../d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from '../d1-import-artifact'
import { project } from '../project'

/**
 * The one-time legacy media migration (serpcompany/best.serp.co#95): every logo and image of the
 * committed import moves into the media bucket, and nothing stays hotlinked.
 *
 * Each `listing_media` logo or image row is resolved to bytes we can host:
 * - an https source (Cloudflare Images, raw.githubusercontent.com, apps.serp.co, serp.ai) is
 *   fetched as is;
 * - a `/media/products/…` path the import copied from apps.serp.co without its file is fetched
 *   from apps.serp.co, where the originals live (byte-identical to serpcompany/store-new);
 * - a file checked in under `apps/web/public` (`/listing-logos/…`, launchbuzz.io's og.png) is
 *   read from the repository (`repo:` source).
 * A source that is dead or not a hostable image (404, SVG, not an image, too large) is replaced
 * from the product's own site, with submit v2's prefill logic: its site icon (apple-touch-icon,
 * declared icons, `/favicon.ico`) for the logo, its social (Open Graph) image for the featured
 * image. A listing that yields nothing keeps the fallback tile; nothing is hotlinked.
 *
 * Outputs (all reviewed, none uploaded or published here):
 * - `d1/media/<id>.json`, the upload plan (`scripts/media-upload.ts`);
 * - `d1/publications/<id>-NN.yaml`, chained manifests of `listing-media-update` operations;
 * - `d1/media/<id>.report.md`, counts per source and the listings left without an image.
 *
 * Fetches are cached under `.runtime/legacy-media-cache` (ignored by Git), so a rerun is fast and
 * reproduces the same outputs. Usage:
 *   pnpm migration:legacy-media [-- --retry-errors] [--limit <n>] [--refresh <upload-summary.json>]
 * `--refresh` refetches the sources an upload reported as changed (`sha256_mismatch`), so their
 * keys follow the new bytes; everything else replays from the cache.
 */

export const MIGRATION_ID = '2026-10-06-legacy-media'
/** Listings per manifest: each stays one D1 batch of a few thousand statements. */
export const LISTINGS_PER_MANIFEST = 500
/** The smallest site icon accepted as a replacement logo (a 32 px favicon, scaled up). */
export const MIN_ICON_PIXELS = 32
/** The smallest social image accepted as a replacement featured image. */
export const MIN_SOCIAL_IMAGE_PIXELS = 120
const USER_AGENT = 'Mozilla/5.0 (compatible; best.serp.co-media/1.0; +https://best.serp.co/about/)'
const PRODUCT_MEDIA_ORIGIN = 'https://apps.serp.co'
const publicDirectory = resolve(project.appDirectory, 'public')

/** Why a known import reference cannot be restored (#89), for the report. */
const KNOWN_DEAD: Readonly<Record<string, string>> = {
  '/media/products/dr.serp.co/logo.png':
    'never created: no dr.serp.co logo exists (json-directory-template#114 named the path only)',
  '/media/products/onlyfans-downloader/onlyfans-downloader-1.jpg':
    'a duplicate of the listing’s first image (serpapps/onlyfans-downloader screenshots/onlyfans-downloader-1.jpg), never published at this path'
}

interface ListingRow {
  id: string
  slug: string
  website: string
}

interface MediaRow {
  kind: MediaKind
  listing_id: string
  sort_order: number
  url: string
}

export interface HostedEntry {
  bytes: number
  contentType: string
  height: number
  key: string
  sha256: string
  source: string
  width: number
}

type SourceClass =
  | 'apps.serp.co'
  | 'imagedelivery.net'
  | 'media-products'
  | 'other-https'
  | 'raw.githubusercontent.com'
  | 'repo'
  | 'serp.ai'

type Resolution = { image: FetchedImage; ok: true; source: string } | { ok: false; reason: string }

interface ListingOutcome {
  images: { dropped: number; hosted: number; replaced: boolean }
  logo: 'dropped' | 'hosted' | 'none' | 'replaced'
  logoReason?: string
  slug: string
}

/** Concurrency per host and overall, so no site sees more than a few requests at once. */
function limiter(perHost: number, overall: number) {
  const active = new Map<string, number>()
  let running = 0
  const waiting: Array<() => void> = []
  const canRun = (host: string) => running < overall && (active.get(host) ?? 0) < perHost
  return async function run<T>(host: string, task: () => Promise<T>): Promise<T> {
    while (!canRun(host)) await new Promise<void>(release => waiting.push(release))
    running += 1
    active.set(host, (active.get(host) ?? 0) + 1)
    try {
      return await task()
    } finally {
      running -= 1
      active.set(host, (active.get(host) ?? 1) - 1)
      for (const release of waiting.splice(0)) release()
    }
  }
}

interface CachedResponse {
  body?: string
  error?: string
  headers: Record<string, string>
  status: number
}

/**
 * A `fetch` that caches every GET answer (redirects and errors too) on disk, so a rerun replays
 * the same bytes. `--retry-errors` refetches cached network errors, 429, and 5xx answers.
 */
export function cachingFetch(
  cacheDirectory: string,
  retryErrors: boolean,
  refresh: ReadonlySet<string> = new Set()
): typeof fetch {
  mkdirSync(cacheDirectory, { recursive: true })
  const limit = limiter(4, 32)
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const file = resolve(cacheDirectory, `${createHash('sha256').update(url).digest('hex')}.json`)
    let cached: CachedResponse | null = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as CachedResponse)
      : null
    if (cached && retryErrors && (cached.error || cached.status >= 500 || cached.status === 429)) {
      cached = null
    }
    if (refresh.has(url)) cached = null
    if (!cached) {
      cached = await limit(new URL(url).host, async () => {
        try {
          const response = await fetch(url, init)
          const headers: Record<string, string> = {}
          for (const name of ['content-type', 'location']) {
            const value = response.headers.get(name)
            if (value) headers[name] = value
          }
          const body = Buffer.from(await response.arrayBuffer())
          return {
            body: body.byteLength ? body.toString('base64') : undefined,
            headers,
            status: response.status
          }
        } catch (error) {
          const name = error instanceof Error ? error.name : ''
          return {
            error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable',
            headers: {},
            status: 0
          }
        }
      })
      writeFileSync(file, JSON.stringify(cached))
    }
    if (cached.error) {
      throw Object.assign(new Error(cached.error), {
        name: cached.error === 'timeout' ? 'TimeoutError' : 'TypeError'
      })
    }
    const body = cached.body ? Buffer.from(cached.body, 'base64') : null
    // A response with a 3xx status cannot carry a body through the Response constructor.
    return new Response(cached.status >= 300 && cached.status < 400 ? null : body, {
      headers: cached.headers,
      status: cached.status
    })
  }
}

export function classifySource(url: string): SourceClass {
  if (url.startsWith('/media/products/') && !existsSync(resolve(publicDirectory, `.${url}`))) {
    return 'media-products'
  }
  if (url.startsWith('/')) return 'repo'
  const host = new URL(url).host
  if (
    host === 'imagedelivery.net' ||
    host === 'raw.githubusercontent.com' ||
    host === 'apps.serp.co' ||
    host === 'serp.ai'
  ) {
    return host
  }
  return 'other-https'
}

/** Where to fetch an imported reference from (an https URL or a `repo:` file). */
export function sourceFor(url: string): string {
  const kind = classifySource(url)
  if (kind === 'media-products') return `${PRODUCT_MEDIA_ORIGIN}${url}`
  if (kind === 'repo') return `repo:${project.appDirectory}/public${url}`
  return url
}

function readRepoImage(source: string): Resolution {
  const path = resolve(source.slice('repo:'.length))
  if (!path.startsWith(`${publicDirectory}/`) || !existsSync(path)) {
    return { ok: false, reason: 'repo_file_missing' }
  }
  const body = new Uint8Array(readFileSync(path))
  const sniffed = sniffImage(body)
  if (!sniffed.ok) return { ok: false, reason: sniffed.reason }
  return {
    image: {
      body,
      contentType: IMAGE_CONTENT_TYPES[sniffed.format],
      format: sniffed.format,
      height: sniffed.height,
      ok: true,
      sha256: createHash('sha256').update(body).digest('hex'),
      url: source,
      width: sniffed.width
    },
    ok: true,
    source
  }
}

function hostedEntry(
  resolution: Extract<Resolution, { ok: true }>,
  kind: MediaKind,
  slug: string
): HostedEntry {
  const { image } = resolution
  return {
    bytes: image.body.byteLength,
    contentType: image.contentType,
    height: image.height,
    key: mediaKey({ format: image.format, kind, sha256: image.sha256, slug }),
    sha256: image.sha256,
    source: resolution.source,
    width: image.width
  }
}

export interface MigrationResult {
  manifests: Array<{ file: string; text: string }>
  outcomes: ListingOutcome[]
  plan: { id: string; objects: HostedEntry[]; site: string; version: 1 }
  report: string
}

export async function migrateLegacyMedia(options: {
  fetcher: typeof fetch
  limit?: number
  listingsPerManifest?: number
}): Promise<MigrationResult> {
  const perManifest = options.listingsPerManifest ?? LISTINGS_PER_MANIFEST
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  database.exec(readReviewedImportSql(readParityReport()))
  const state = database
    .prepare('SELECT version, checksum FROM publication_state WHERE id = 1')
    .get() as {
    checksum: string
    version: number
  }
  const listings = (
    database
      .prepare(
        `SELECT DISTINCT l.id, l.slug, l.website FROM listings l
         JOIN listing_media m ON m.listing_id = l.id AND m.kind IN ('logo','image')
         ORDER BY l.slug`
      )
      .all() as unknown as ListingRow[]
  ).slice(0, options.limit)
  const rowsFor = database.prepare(
    `SELECT listing_id, kind, url, sort_order FROM listing_media
     WHERE listing_id = ? AND kind IN ('logo','image') ORDER BY kind, sort_order`
  )

  const fetchOptions = { fetcher: options.fetcher, userAgent: USER_AGENT }
  const resolved = new Map<string, Promise<Resolution>>()
  const resolveSource = (source: string, minPixels?: number): Promise<Resolution> => {
    const cacheKey = `${source}\0${minPixels ?? 0}`
    let pending = resolved.get(cacheKey)
    if (!pending) {
      pending = source.startsWith('repo:')
        ? Promise.resolve(readRepoImage(source))
        : fetchImage(source, { ...fetchOptions, minPixels }).then(result =>
            result.ok
              ? { image: result, ok: true as const, source: result.url }
              : { ok: false as const, reason: (result as MediaFailure).code }
          )
      resolved.set(cacheKey, pending)
    }
    return pending
  }

  /** The product's own page: the listing website, past a shortener's meta refresh. */
  const productPage = async (website: string, slug: string) => {
    const read = (url: string) =>
      safeFetch(url, {
        accept: type => type === 'text/html' || type === 'application/xhtml+xml',
        acceptHeader: 'text/html,application/xhtml+xml',
        fetcher: options.fetcher,
        // Some product pages inline megabytes before </head>; the metadata is near the top.
        maxBytes: 5_000_000,
        userAgent: USER_AGENT
      })
    let page = await read(website)
    for (let hop = 0; page.ok && hop < 2; hop += 1) {
      const target = metaRefreshUrl(new TextDecoder().decode(page.body), page.url)
      if (!target) break
      page = await read(target)
    }
    // A shortener page is never the product's (its icon would be the shortener's), and a dead
    // short link may still have a live product: the slug is the product's domain.
    const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(slug)
    const shortener = (url: string) => new URL(url).host === 'serp.ly'
    if (isDomain && (page.ok ? shortener(page.url) : shortener(website))) {
      page = await read(`https://${slug}/`)
    }
    return page
  }

  /** The product site's icon and social image (submit v2's prefill logic), once per listing. */
  const siteImages = async (website: string, slug: string) => {
    const page = await productPage(website, slug)
    if (!page.ok) return { icon: null, reason: `site ${page.code}`, social: null }
    if (new URL(page.url).host === 'serp.ly') {
      return { icon: null, reason: 'site is a serp.ly page', social: null }
    }
    const metadata = parseSiteMetadata(new TextDecoder().decode(page.body), page.url)
    let icon: Extract<Resolution, { ok: true }> | null = null
    // Only https sources, as at submit v2's intake: the upload fetches them again.
    const secure = (url: string) => url.startsWith('https://')
    for (const candidate of iconCandidates(metadata, page.url, {
      fallbacks: ['/apple-touch-icon.png', '/favicon.ico'],
      minPixels: MIN_ICON_PIXELS,
      vector: false
    })
      .filter(secure)
      .slice(0, 5)) {
      const result = await resolveSource(candidate, MIN_ICON_PIXELS)
      if (result.ok) {
        icon = result
        break
      }
    }
    const social =
      metadata.socialImage && secure(metadata.socialImage)
        ? await resolveSource(metadata.socialImage, MIN_SOCIAL_IMAGE_PIXELS)
        : null
    return {
      icon,
      reason: icon ? '' : 'site has no hostable icon',
      social: social?.ok ? social : null
    }
  }

  const sourceCounts = new Map<string, { failed: number; hosted: number; rows: number }>()
  const count = (source: SourceClass, ok: boolean) => {
    const entry = sourceCounts.get(source) ?? { failed: 0, hosted: 0, rows: 0 }
    entry.rows += 1
    if (ok) entry.hosted += 1
    else entry.failed += 1
    sourceCounts.set(source, entry)
  }
  const failureReasons = new Map<string, number>()
  const objects = new Map<string, HostedEntry>()
  const operations: Array<Record<string, unknown>> = []
  const outcomes: ListingOutcome[] = []

  const work = async (listing: ListingRow) => {
    const rows = rowsFor.all(listing.id) as unknown as MediaRow[]
    const results = await Promise.all(rows.map(row => resolveSource(sourceFor(row.url))))
    rows.forEach((row, index) => {
      const result = results[index]
      count(classifySource(row.url), Boolean(result?.ok))
      if (result && !result.ok) {
        failureReasons.set(result.reason, (failureReasons.get(result.reason) ?? 0) + 1)
      }
    })
    const logoIndex = rows.findIndex(row => row.kind === 'logo')
    const imageIndexes = rows.flatMap((row, index) => (row.kind === 'image' ? [index] : []))
    let logo = logoIndex >= 0 ? results[logoIndex] : undefined
    let images = imageIndexes
      .map(index => results[index])
      .filter((result): result is Extract<Resolution, { ok: true }> => Boolean(result?.ok))
    const outcome: ListingOutcome = {
      images: { dropped: imageIndexes.length - images.length, hosted: 0, replaced: false },
      logo: logoIndex < 0 ? 'none' : logo?.ok ? 'hosted' : 'dropped',
      slug: listing.slug
    }
    const needsLogo = logoIndex >= 0 && !logo?.ok
    const needsImage = imageIndexes.length > 0 && images.length === 0
    if (needsLogo || needsImage) {
      const site = await siteImages(listing.website, listing.slug)
      if (needsLogo) {
        const deadUrl = rows[logoIndex]?.url ?? ''
        if (site.icon) {
          logo = site.icon
          outcome.logo = 'replaced'
        } else {
          outcome.logoReason =
            KNOWN_DEAD[deadUrl] ?? `${(logo as { reason?: string })?.reason}; ${site.reason}`
        }
      }
      if (needsImage && site.social) {
        images = [site.social]
        outcome.images.replaced = true
      }
    }
    const media: { images?: HostedEntry[]; logo?: HostedEntry } = {}
    if (logo?.ok) media.logo = hostedEntry(logo, 'logo', listing.slug)
    const hostedImages = new Map<string, HostedEntry>()
    for (const image of images) {
      const entry = hostedEntry(image, 'image', listing.slug)
      if (!hostedImages.has(entry.key)) hostedImages.set(entry.key, entry)
    }
    if (hostedImages.size) media.images = [...hostedImages.values()]
    outcome.images.hosted = hostedImages.size
    for (const entry of [media.logo, ...(media.images ?? [])]) {
      if (entry) objects.set(entry.key, entry)
    }
    operations.push({
      action: 'listing-media-update',
      id: listing.id,
      slug: listing.slug,
      expected: rows.map(row => ({ kind: row.kind, url: row.url })),
      media
    })
    outcomes.push(outcome)
  }

  const queue = [...listings]
  let done = 0
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      for (let listing = queue.shift(); listing; listing = queue.shift()) {
        await work(listing)
        done += 1
        if (done % 250 === 0) console.error(`resolved ${done}/${listings.length} listings`)
      }
    })
  )
  operations.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
  outcomes.sort((a, b) => a.slug.localeCompare(b.slug))

  // Chained manifests: each one's base is the state the previous one publishes.
  const manifests: Array<{ file: string; text: string }> = []
  let version = state.version
  let checksum = state.checksum
  const chunks = Math.ceil(operations.length / perManifest)
  for (let index = 0; index < chunks; index += 1) {
    const id = `${MIGRATION_ID}-${String(index + 1).padStart(2, '0')}`
    const header = [
      `# serpcompany/best.serp.co#95, part ${index + 1} of ${chunks}: repoint listing logos and images to`,
      `# hosted copies (scripts/migration/legacy-media.ts). Upload d1/media/${MIGRATION_ID}.json to the`,
      '# environment first; the publisher refuses keys its media host does not serve. Apply in order,',
      '# staging first: Publish D1 Catalog (staging), then Publish D1 Catalog after promotion.',
      ''
    ].join('\n')
    const body = stringify(
      {
        version: 1,
        id,
        basePublicationVersion: version,
        provenance: {
          actor: 'devinschumacher',
          workflow: 'github/publish-d1',
          beforeChecksum: checksum
        },
        operations: operations.slice(index * perManifest, (index + 1) * perManifest)
      },
      { lineWidth: 0 }
    )
    const text = `${header}${body}`
    const inputChecksum = createHash('sha256').update(text).digest('hex')
    checksum = createHash('sha256').update(`${checksum}\0${inputChecksum}`).digest('hex')
    version += 1
    manifests.push({ file: `d1/publications/${id}.yaml`, text })
  }

  const plan = {
    id: MIGRATION_ID,
    objects: [...objects.values()].sort((a, b) => a.key.localeCompare(b.key)),
    site: 'best.serp.co',
    version: 1 as const
  }
  return {
    manifests,
    outcomes,
    plan,
    report: renderReport(outcomes, sourceCounts, failureReasons, plan, manifests.length)
  }
}

function renderReport(
  outcomes: ListingOutcome[],
  sources: Map<string, { failed: number; hosted: number; rows: number }>,
  reasons: Map<string, number>,
  plan: MigrationResult['plan'],
  manifestCount: number
): string {
  const lines = [
    `# Legacy media migration (${MIGRATION_ID})`,
    '',
    'Generated by `scripts/migration/legacy-media.ts` for serpcompany/best.serp.co#95.',
    '',
    `- Listings with a logo or image in the import: ${outcomes.length}`,
    `- Objects to upload: ${plan.objects.length} (${(plan.objects.reduce((total, object) => total + object.bytes, 0) / 1_048_576).toFixed(1)} MiB)`,
    `- Manifests: ${manifestCount} (listing-media-update, chained, ${LISTINGS_PER_MANIFEST} listings each)`,
    '',
    '## Imported rows by source',
    '',
    '| Source | Rows | Fetched and hostable | Dead or unusable |',
    '| --- | --- | --- | --- |',
    ...[...sources.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([source, value]) => `| ${source} | ${value.rows} | ${value.hosted} | ${value.failed} |`
      ),
    '',
    '## Why rows were dead or unusable',
    '',
    '| Reason | Rows |',
    '| --- | --- |',
    ...[...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, rows]) => `| ${reason} | ${rows} |`),
    '',
    '## Listings after the migration',
    '',
    '| Logo | Listings |',
    '| --- | --- |',
    ...(['hosted', 'replaced', 'dropped', 'none'] as const).map(
      kind =>
        `| ${kind === 'replaced' ? 'replaced from the site icon' : kind === 'dropped' ? 'dropped (fallback tile)' : kind === 'none' ? 'none in the import' : 'hosted from its source'} | ${outcomes.filter(outcome => outcome.logo === kind).length} |`
    ),
    '',
    `- Listings whose featured image came from the site's social image: ${outcomes.filter(outcome => outcome.images.replaced).length}`,
    `- Listings that had images and keep none: ${outcomes.filter(outcome => outcome.images.hosted === 0 && (outcome.images.dropped > 0 || outcome.images.replaced)).length}`,
    `- Image rows dropped: ${outcomes.reduce((total, outcome) => total + outcome.images.dropped, 0)}`,
    '',
    '## Logos dropped (fallback tile)',
    '',
    ...outcomes
      .filter(outcome => outcome.logo === 'dropped')
      .map(outcome => `- \`${outcome.slug}\`: ${outcome.logoReason ?? 'unknown'}`),
    ''
  ]
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(value => value !== '--')
  const limitIndex = args.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined
  // `--refresh <upload summary>`: refetch the sources of objects an upload found changed.
  const refreshIndex = args.indexOf('--refresh')
  const refresh = new Set<string>()
  if (refreshIndex >= 0) {
    const summary = JSON.parse(readFileSync(resolve(args[refreshIndex + 1] ?? ''), 'utf8')) as {
      failed: Array<{ key: string }>
    }
    const plan = JSON.parse(readFileSync(resolve(`d1/media/${MIGRATION_ID}.json`), 'utf8')) as {
      objects: Array<{ key: string; source: string }>
    }
    const sources = new Map(plan.objects.map(object => [object.key, object.source]))
    for (const { key } of summary.failed) {
      const source = sources.get(key)
      if (source?.startsWith('https://')) refresh.add(source)
    }
  }
  const fetcher = cachingFetch(
    resolve('.runtime/legacy-media-cache'),
    args.includes('--retry-errors'),
    refresh
  )

  const result = await migrateLegacyMedia({ fetcher, limit })
  mkdirSync(resolve('d1/media'), { recursive: true })
  writeFileSync(
    resolve(`d1/media/${MIGRATION_ID}.json`),
    `${JSON.stringify(result.plan, null, 1)}\n`
  )
  writeFileSync(resolve(`d1/media/${MIGRATION_ID}.report.md`), result.report)
  for (const manifest of result.manifests) writeFileSync(resolve(manifest.file), manifest.text)
  console.log(result.report)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
