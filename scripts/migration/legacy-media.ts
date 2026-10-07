import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { IMAGE_CONTENT_TYPES, sniffImage } from '@serpdirectory/data-ops/media-format'
import {
  type FetchedImage,
  fetchImage,
  type MediaFailure
} from '@serpdirectory/data-ops/media-ingest'
import { isListingMediaKey, type MediaKind, mediaKey } from '@serpdirectory/data-ops/media-keys'
import { safeFetch } from '@serpdirectory/data-ops/safe-fetch'
import { nodeFetch } from '@serpdirectory/data-ops/safe-fetch-node'
import {
  iconCandidates,
  metaRefreshUrl,
  parseSiteMetadata
} from '@serpdirectory/data-ops/site-metadata'
import { urlKey } from '@serpdirectory/utils/url-key'
import { stringify } from 'yaml'
import { parseWranglerRows } from '../cloudflare-release'
import { freshMigrationNames, freshMigrationsDirectory } from '../d1-drizzle-local'
import { readParityReport, readReviewedImportSql } from '../d1-import-artifact'
import { isArchivedRepoMedia, readArchivedRepoMedia } from '../media-repo-archive'
import { project } from '../project'

/**
 * The one-time legacy media migration (serpcompany/best.serp.co#95): every logo and image of the
 * catalog moves into the media bucket, and nothing stays hotlinked.
 *
 * Each `listing_media` logo or image row without a hosted key is resolved to bytes we can host:
 * - an https source (Cloudflare Images, raw.githubusercontent.com, apps.serp.co, serp.ai) is
 *   fetched as is;
 * - a `/media/products/…` path the import copied from apps.serp.co without its file is fetched
 *   from apps.serp.co, where the originals live (byte-identical to serpcompany/store-new);
 * - a file checked in under `apps/web/public` is read from the repository (`repo:` source); one
 *   deleted after the production publish (#124) is read from Git (`media-repo-archive.ts`).
 *
 * A source that is dead, not a hostable image, or a known default asset (`DEFAULT_ASSETS`: the
 * placeholder chevron of 387 imported logos, framework favicons, builder default images,
 * parking-page icons) is replaced from the product's own site with submit v2's prefill logic:
 * its site icon for the logo (at least `MIN_ICON_PIXELS`), its social (Open Graph) image for the
 * featured image. A replacement is taken only from a page the listing owns (owner decisions on
 * #95, 2026-10-06):
 * - the final page, after redirects and a shortener's meta refresh, is on the listing's own
 *   registrable domain (its website's or its slug's), or on serp.co (SERP's own app pages);
 * - the page is not a parking, for-sale, gambling, or spam page (`pageFlags`).
 * Adult listings never get a featured image from another site's Open Graph tag: only SERP's own
 * curated screenshot, served by apps.serp.co from serpcompany/store-new. A listing that yields
 * nothing keeps the fallback tile, and every refused replacement is listed in the report for the
 * owner's sign-off; listing content never changes here (#100 handles hijacked listings).
 *
 * Outputs (all reviewed, none uploaded or published here):
 * - `d1/media/<id>.json`, the upload plan (`scripts/media-upload.ts`);
 * - `d1/publications/<id>-NN.yaml`, row-level manifests (`concurrency: rows`) of
 *   `listing-media-update` operations: each applies on any environment whose rows still match;
 * - `d1/media/<id>.report.md`, counts by source and reason, and the owner sign-off lists.
 *
 * The catalog is the committed import, or with `--current <directory>` an environment's current
 * rows (docs/MEDIA.md#recovering-a-refused-media-manifest): rows already hosted are kept as
 * they are. Fetches are cached under `.runtime/legacy-media-cache` (ignored by Git), so a rerun
 * reproduces the same outputs. Usage:
 *   pnpm migration:legacy-media [-- --retry-errors] [--limit <n>] [--current <directory>]
 *     [--refresh <upload-summary.json>] [--snapshot-sql <listings|media>] [--part-size <n>]
 *     [--manifest-id <id>] [--allow-domain <slug>=<domain>]
 * `--refresh` refetches the source of every object an upload reported as failed, so its key
 * follows the new bytes; everything else replays from the cache.
 */

export const MIGRATION_ID = '2026-10-06-legacy-media'
/** Listings per manifest: each stays one D1 batch of a few thousand statements. */
export const LISTINGS_PER_MANIFEST = 500
/** The smallest site icon accepted as a replacement logo (owner decision, #95). */
export const MIN_ICON_PIXELS = 64
/** The smallest social image accepted as a replacement featured image. */
export const MIN_SOCIAL_IMAGE_PIXELS = 120
const USER_AGENT = 'Mozilla/5.0 (compatible; best.serp.co-media/1.0; +https://best.serp.co/about/)'
const PRODUCT_MEDIA_ORIGIN = 'https://apps.serp.co'
/**
 * SERP's own app pages: a SERP app listing's page on apps.serp.co is its own, and its social
 * image is the app's curated screenshot (serpcompany/store-new). Its icon is SERP Apps', not the
 * app's, so it is never a replacement logo. Any other serp.co page is SERP's, not the listing's.
 */
const SERP_APP_HOST = 'apps.serp.co'
const SHORTENER_HOSTS = new Set(['serp.ly'])
const publicDirectory = resolve(project.appDirectory, 'public')

/**
 * Images that are not the product's own, by SHA-256: treated as missing wherever they appear,
 * an imported row or a replacement candidate (#98 review S1, S3; owner decision on #95).
 */
export const DEFAULT_ASSETS: Readonly<Record<string, string>> = {
  b912cda4106db3a6c5e28bdac631456446bfee7277493ca52b5c4040b888adaf:
    'placeholder chevron (the logo of 387 imported listings)',
  '2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932':
    'create-next-app default favicon (Next.js template)',
  '9ab2ec2457bc5585b2fccedd5194b9f42bb5a563e57ba5bb932f5a447e2d1825':
    'Lovable default Open Graph image',
  '9998c60ab0994aed9006a441a9d16af2f554efecea71afdf309bc0f96b445401':
    'Spaceship for-sale page favicon',
  f8fef5fc814f7b9aa077aee362033a10e27197ef7aadefc29cecff49504b9e1a:
    'Snagged domain marketplace icon',
  c28fdd2a4f31e2dc64f653962286da5c82a4cdfc518b242d32812c624e9a19a4:
    'create-next-app default favicon (current template)',
  '3d10f7da6c603178340081668c4ac5b3ae9743ca9a262ab0fcd312fbb9f48bdd':
    'create-react-app default favicon',
  c386396ec70db3608075b5fbfaac4ab1ccaa86ba05a68ab393ec551eb66c3e00:
    'create-react-app default logo192.png (the React logo)',
  '9ea4f4da7050c0cc408926f6a39c253624e9babb1d43c7977cd821445a60b461':
    'create-react-app default logo512.png (the React logo)'
}

/**
 * Adult listings by name (#98 review round 2, S2): the downloaders and sites of adult platforms,
 * whatever their category (14 of them are not in the Adult category). An adult listing takes
 * only SERP's curated apps.serp.co screenshot as its featured image.
 */
export const ADULT_TERMS =
  /porn|onlyfans|fansly|xhamster|xnxx|xvideos|redtube|youporn|spankbang|eporner|tnaflix|stripchat|livejasmin|chaturbate|camsoda|bongacams|myfreecams|manyvids|clips4sale|upornia|coomer|sexchat|dreamcam|motherless|brazzers|bangbros|fapello|thisvid|(?<![a-z])(?:erome|beeg|cam4|xxx|nsfw|hentai|rule34|javhd)(?![a-z])/u

/** Adult by category, or by an adult platform's name in its slug or website. */
export function isAdultListing(listing: {
  adult: boolean
  slug: string
  website: string
}): boolean {
  return listing.adult || ADULT_TERMS.test(listing.slug) || ADULT_TERMS.test(listing.website)
}

/**
 * The owner's approved rebrands (#98 review round 2, S3): `slug` → the registrable domain its
 * replacement page may be on. Checked in at `scripts/migration/legacy-media-allowed-domains.json`, and
 * extended per run with `--allow-domain <slug>=<domain>`.
 */
export const ALLOWED_DOMAINS_FILE = 'scripts/migration/legacy-media-allowed-domains.json'

/** The brand label of a registrable domain: `notion` for notion.ai, `lambdalabs` for lambdalabs.com. */
function brandLabel(domain: string): string {
  return domain.split('.')[0]?.replace(/[^a-z0-9]/gu, '') ?? ''
}

/**
 * A likely rebrand: the off-domain page's brand label matches the listing's own (`notion.ai` →
 * `notion.com`), or one contains the other (`lambdalabs.com` → `lambda.ai`). Only a hint for the
 * owner's sign-off; nothing is accepted without the allowlist.
 */
export function isLikelyRebrand(own: ReadonlySet<string>, domain: string): boolean {
  const target = brandLabel(domain)
  if (target.length < 4) return false
  return [...own].some(owned => {
    const label = brandLabel(owned)
    return (
      label.length >= 4 && (label === target || label.includes(target) || target.includes(label))
    )
  })
}

/** Imported references known never to have existed (#89), for the report. */
const KNOWN_DEAD: Readonly<Record<string, string>> = {
  '/media/products/dr.serp.co/logo.png':
    'never created: no dr.serp.co logo exists (json-directory-template#114 named the path only)',
  '/media/products/onlyfans-downloader/onlyfans-downloader-1.jpg':
    'a duplicate of the listing’s first image (serpapps/onlyfans-downloader screenshots/onlyfans-downloader-1.jpg), never published at this path'
}

/** Domain parking and marketplace hosts: a page, icon, or image from one is not the product's. */
const PARKING_HOSTS =
  /(?:^|\.)(?:spaceship(?:-cdn)?\.com|snagged\.com|sedo(?:parking)?\.com|dan\.com|afternic\.com|godaddy\.com|secureserver\.net|parkingcrew\.net|bodis\.com|above\.com|hugedomains\.com|undeveloped\.com|atom\.com|squadhelp\.com|namecheap\.com|parklogic\.com|sav\.com|domainmarket\.com|buydomains\.com|efty\.com|uniregistry\.com)$/u
/** For-sale and parking wording on a page. */
const PARKING_TEXT =
  /\b(?:(?:this|the) domain(?: name)? (?:is|may be|might be) (?:for sale|available|parked)|domain (?:is )?for sale|buy this domain|make an offer|parked (?:free|domain|by)|domain parking|is parked|hugedomains|sedoparking|snagged|spaceship\.com|afternic|dan\.com)\b/iu
const word = (terms: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms})(?![\\p{L}\\p{N}])`, 'giu')
/**
 * Gambling and spam wording, in the languages of the hijacked pages found in review (#98 B1):
 * English, Indonesian, Vietnamese. A strong term is gambling on any page; a weak one only adds
 * up (a pricing page says "bonus", an app says "deposit"). Bare "slot" is neither: a scheduling
 * or UI library page says it often.
 */
const STRONG_SPAM = word(
  'togel|gacor|judi|sbobet|maxwin|casinos?|kasino|baccarat|sportsbook|8xbet|1xbet|bet365|nh[aà] c[aá]i|c[aá] c[uư][oợ]c|x[oổ] s[oố]|pokies|link alternatif|situs slot|slot online|slot ?88|slot ?777|rtp live|bandar togel|viagra|cialis'
)
const WEAK_SPAM = word(
  'bonus|deposit|withdrawal|jackpot|scatter|permainan|bermain|daftar|toto|betting|poker|roulette'
)
/** A gambling brand in a title: letters then two or three digits (`Vegas123`, `CM88`, `OKTA333`). */
const SPAM_BRAND = /(?<![\p{L}\p{N}])\p{L}{2,}\d{2,3}(?![\p{L}\p{N}])/u

/** The page's text without markup, scripts, or styles. */
function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&[a-z]+;|&#\d+;/giu, ' ')
}

/**
 * A gambling or spam verdict, or null: a strong term in the page's title or description; two
 * strong terms in its text, or one with enough weak ones (strong 3 each, weak 1 each, weak
 * terms in the title or description 3 each, 9 in all); or gaming wording in the title or
 * description backed by the text (two weak terms there, or a `Vegas123` brand and one, with
 * three in the text). Weak terms alone never decide it: a pricing page says "bonus" often.
 * Returns the most frequent term.
 */
export function spamSignal(head: string, text: string): string | null {
  const strongHead = head.match(STRONG_SPAM)
  if (strongHead?.[0]) return strongHead[0].toLowerCase()
  const strong = text.match(STRONG_SPAM) ?? []
  const weak = text.match(WEAK_SPAM) ?? []
  const weakHead = head.match(WEAK_SPAM) ?? []
  const score = strong.length * 3 + weak.length + weakHead.length * 3
  const spam =
    strong.length >= 2 ||
    (strong.length === 1 && score >= 9) ||
    (weakHead.length >= 2 && weak.length >= 3) ||
    (SPAM_BRAND.test(head) && weakHead.length >= 1 && weak.length >= 3)
  if (!spam) return null
  const counts = new Map<string, number>()
  for (const term of [...strong, ...strong, ...strong, ...weak, ...weakHead]) {
    counts.set(term.toLowerCase(), (counts.get(term.toLowerCase()) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** A page's verdict: the reasons a replacement from it is refused, or none. */
export function pageFlags(page: { html: string; url: string }): string[] {
  const flags: string[] = []
  const host = new URL(page.url).hostname
  if (PARKING_HOSTS.test(host)) flags.push(`parking host ${host}`)
  const metadata = parseSiteMetadata(page.html, page.url)
  const head = [
    metadata.title,
    metadata.description?.value,
    metadata.ogSiteName,
    metadata.applicationName
  ]
    .filter(Boolean)
    .join(' · ')
  const text = pageText(page.html)
  // A small parking page states it in its body; a large page is read by its head only.
  const parking = PARKING_TEXT.exec(`${head} ${page.html.length < 60_000 ? text : ''}`)?.[0]
  if (parking) flags.push(`for sale or parked ("${parking.toLowerCase()}")`)
  const assets = [metadata.socialImage, ...metadata.icons.map(icon => icon.href)].filter(
    (value): value is string => Boolean(value)
  )
  const parkedAsset = assets.find(asset => PARKING_HOSTS.test(new URL(asset).hostname))
  if (parkedAsset) flags.push(`parking asset ${new URL(parkedAsset).hostname}`)
  const spam = spamSignal(head, text)
  if (spam) flags.push(`gambling or spam ("${spam}")`)
  return flags
}

/** The registrable domain (eTLD+1) of a URL's host, or the host itself. */
export function registrableDomain(url: string): string {
  return urlKey(url).blockKey
}

/** The domains a listing owns: its website's (unless a shortener) and its slug's. */
export function ownDomains(listing: { slug: string; website: string }): Set<string> {
  const domains = new Set<string>()
  try {
    const website = new URL(listing.website)
    if (!SHORTENER_HOSTS.has(website.hostname)) domains.add(registrableDomain(listing.website))
  } catch {
    // An unparsable website owns nothing.
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(listing.slug)) {
    domains.add(registrableDomain(`https://${listing.slug}/`))
  }
  return domains
}

/** Code-point order, as SQLite's BINARY collation (`ORDER BY l.slug`) and on every machine. */
export function codePointCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export interface CatalogListing {
  adult: boolean
  /** Category slugs in sort order (the snapshot's JSON array); absent in hand-built snapshots. */
  categories?: string[] | string
  id: string
  slug: string
  website: string
}

export interface CatalogMediaRow {
  bytes: number | null
  content_type: string | null
  height: number | null
  kind: MediaKind
  listing_id: string
  media_key: string | null
  sha256: string | null
  sort_order: number
  url: string
  width: number | null
}

/** The catalog a migration reads: its listings with media, and each listing's rows. */
export interface CatalogSnapshot {
  listings: CatalogListing[]
  rows(listingId: string): CatalogMediaRow[]
}

/**
 * Listings with a logo or image, and whether each is in the Adult category. `include` adds
 * listings by slug whatever their rows: an approved rebrand whose refused replacement removed its
 * dead rows (it shows the tile) has none left, and still needs its site's icon and image.
 */
export function snapshotListingsSql(include: readonly string[] = []): string {
  const slugs = include.map(slug => `'${slug.replaceAll("'", "''")}'`).join(',')
  return `SELECT l.id, l.slug, l.website,
  EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
    WHERE lc.listing_id = l.id AND c.slug = 'adult') AS adult,
  (SELECT json_group_array(slug) FROM (SELECT c.slug FROM listing_categories lc
    JOIN categories c ON c.id = lc.category_id WHERE lc.listing_id = l.id
    ORDER BY lc.sort_order, c.slug)) AS categories
FROM listings l
WHERE EXISTS (SELECT 1 FROM listing_media m WHERE m.listing_id = l.id AND m.kind IN ('logo','image'))${
    slugs ? `\n  OR l.slug IN (${slugs})` : ''
  }
ORDER BY l.slug`
}

export const SNAPSHOT_LISTINGS_SQL = snapshotListingsSql()

/** Every logo and image row, with its hosted metadata when it has a key. */
export const SNAPSHOT_MEDIA_SQL = `SELECT listing_id, kind, url, sort_order, media_key, sha256,
  content_type, bytes, width, height
FROM listing_media WHERE kind IN ('logo','image') ORDER BY listing_id, kind, sort_order`

function snapshotFrom(listings: CatalogListing[], media: CatalogMediaRow[]): CatalogSnapshot {
  const byListing = new Map<string, CatalogMediaRow[]>()
  for (const row of media) {
    const rows = byListing.get(row.listing_id) ?? []
    rows.push(row)
    byListing.set(row.listing_id, rows)
  }
  for (const rows of byListing.values()) {
    rows.sort((a, b) => codePointCompare(a.kind, b.kind) || a.sort_order - b.sort_order)
  }
  return {
    listings: [...listings]
      .map(listing => ({
        ...listing,
        adult: Boolean(Number(listing.adult)),
        categories:
          typeof listing.categories === 'string'
            ? (JSON.parse(listing.categories) as string[])
            : listing.categories
      }))
      .sort((a, b) => codePointCompare(a.slug, b.slug)),
    rows: listingId => byListing.get(listingId) ?? []
  }
}

/** The committed import, as the migration was reviewed against. */
export function importSnapshot(): CatalogSnapshot {
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  database.exec(readReviewedImportSql(readParityReport()))
  const snapshot = snapshotFrom(
    database.prepare(SNAPSHOT_LISTINGS_SQL).all() as unknown as CatalogListing[],
    database.prepare(SNAPSHOT_MEDIA_SQL).all() as unknown as CatalogMediaRow[]
  )
  database.close()
  return snapshot
}

/**
 * An environment's current catalog from two read-only exports (`listings.json`, `media.json`):
 * the `--json` output of `wrangler d1 execute` for `SNAPSHOT_LISTINGS_SQL` and
 * `SNAPSHOT_MEDIA_SQL` (docs/MEDIA.md#recovering-a-refused-media-manifest).
 */
export function currentSnapshot(directory: string): CatalogSnapshot {
  const read = (file: string) => parseWranglerRows(readFileSync(resolve(directory, file), 'utf8'))
  return snapshotFrom(
    read('listings.json') as unknown as CatalogListing[],
    read('media.json') as unknown as CatalogMediaRow[]
  )
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

type Resolved = { image: FetchedImage; ok: true; source: string }
type Resolution = Resolved | { ok: false; reason: string }

type LogoOutcome =
  | { kind: 'hosted'; source: SourceClass | 'already hosted' }
  | { kind: 'replaced'; pixels: number; source: string }
  | { kind: 'tile'; reason: string }
  | { kind: 'none' }

type ImageOutcome =
  | { kind: 'kept'; sources: Array<SourceClass | 'already hosted'> }
  | { kind: 'replaced'; from: 'serp-app' | 'site'; source: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'none' }

export interface ListingOutcome {
  adult: boolean
  /** Imported rows treated as missing because their bytes are a known default asset. */
  defaults: string[]
  images: ImageOutcome
  logo: LogoOutcome
  /** Why a replacement from the listing's site was refused, for the owner's sign-off. */
  refused?: { page: string; reasons: string[] }
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
 * the same bytes. A miss goes through the DNS-checked Node fetcher (`nodeFetch`), so no hop
 * reaches a private address. `--retry-errors` refetches cached network errors, 429, and 5xx
 * answers.
 */
export function cachingFetch(
  cacheDirectory: string,
  retryErrors: boolean,
  refresh: ReadonlySet<string> = new Set(),
  network: typeof fetch = nodeFetch
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
          const response = await network(url, init)
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
          if (name === 'RestrictedAddressError')
            return { error: 'restricted', headers: {}, status: 0 }
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
        name:
          cached.error === 'timeout'
            ? 'TimeoutError'
            : cached.error === 'restricted'
              ? 'RestrictedAddressError'
              : 'TypeError'
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

/** A site-relative path's file in the repository: checked in, or deleted in #124. */
function repoPath(url: string): string {
  return `${project.appDirectory}/public${url}`
}

export function classifySource(url: string): SourceClass {
  if (
    url.startsWith('/media/products/') &&
    !existsSync(resolve(publicDirectory, `.${url}`)) &&
    !isArchivedRepoMedia(repoPath(url))
  ) {
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
  if (kind === 'repo') return `repo:${repoPath(url)}`
  return url
}

function readRepoImage(source: string): Resolution {
  const path = resolve(source.slice('repo:'.length))
  if (!path.startsWith(`${publicDirectory}/`)) return { ok: false, reason: 'repo_file_missing' }
  // A file deleted after the production publish is read from Git, so a replay is unchanged.
  const body = existsSync(path)
    ? new Uint8Array(readFileSync(path))
    : readArchivedRepoMedia(source.slice('repo:'.length))
  if (!body) return { ok: false, reason: 'repo_file_missing' }
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

/**
 * The MD5 of each new entry's bytes, for the upload plan only (#95 release blocker 3): R2's ETag
 * is the stored bytes' MD5, so the uploader and the publisher verify a listed object without
 * reading it back. Manifests never carry it.
 */
const entryMd5 = new WeakMap<HostedEntry, string>()

function hostedEntry(resolution: Resolved, kind: MediaKind, slug: string): HostedEntry {
  const { image } = resolution
  const entry: HostedEntry = {
    bytes: image.body.byteLength,
    contentType: image.contentType,
    height: image.height,
    key: mediaKey({ format: image.format, kind, sha256: image.sha256, slug }),
    sha256: image.sha256,
    source: resolution.source,
    width: image.width
  }
  entryMd5.set(entry, createHash('md5').update(image.body).digest('hex'))
  return entry
}

/** A row that is already hosted, as the manifest repeats it (its object is in the bucket). */
function alreadyHosted(row: CatalogMediaRow): HostedEntry | null {
  if (!row.media_key || !isListingMediaKey(row.media_key)) return null
  if (!row.sha256 || !row.content_type || !row.bytes || !row.width || !row.height) return null
  return {
    bytes: row.bytes,
    contentType: row.content_type,
    height: row.height,
    key: row.media_key,
    sha256: row.sha256,
    source: row.url,
    width: row.width
  }
}

export interface MigrationResult {
  /**
   * The Adult category for adult listings that lack it (owner decision on #98): a separate,
   * row-level manifest of `listing-categories-add`, or null when none lacks it.
   */
  categoryManifest: { file: string; text: string } | null
  manifests: Array<{ file: string; text: string }>
  outcomes: ListingOutcome[]
  plan: { id: string; objects: Array<HostedEntry & { md5: string }>; site: string; version: 1 }
  report: string
}

interface SiteImages {
  icon: Resolved | null
  iconReason: string
  page: string
  refused: string[]
  social: Resolved | null
  socialReason: string
}

export async function migrateLegacyMedia(options: {
  /** Owner-approved rebrands: slug → the registrable domain its page may be on. */
  allowedDomains?: Readonly<Record<string, string>>
  fetcher: typeof fetch
  limit?: number
  listingsPerManifest?: number
  /** The plan, report, and manifest id prefix (new ids for a regeneration, MEDIA.md). */
  migrationId?: string
  snapshot?: CatalogSnapshot
}): Promise<MigrationResult> {
  const perManifest = options.listingsPerManifest ?? LISTINGS_PER_MANIFEST
  const migrationId = options.migrationId ?? MIGRATION_ID
  const allowedDomains = options.allowedDomains ?? {}
  if (!Number.isSafeInteger(perManifest) || perManifest < 1) {
    throw new Error('A manifest holds at least one listing.')
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/u.test(migrationId)) throw new Error('Invalid migration id.')
  const snapshot = options.snapshot ?? importSnapshot()
  const listings = snapshot.listings.slice(0, options.limit)

  const fetchOptions = { fetcher: options.fetcher, userAgent: USER_AGENT }
  const resolved = new Map<string, Promise<Resolution>>()
  const resolveSource = (source: string, minPixels?: number): Promise<Resolution> => {
    const cacheKey = `${source}\0${minPixels ?? 0}`
    let pending = resolved.get(cacheKey)
    if (!pending) {
      pending = (
        source.startsWith('repo:')
          ? Promise.resolve(readRepoImage(source))
          : fetchImage(source, { ...fetchOptions, minPixels }).then(result =>
              result.ok
                ? { image: result, ok: true as const, source: result.url }
                : { ok: false as const, reason: (result as MediaFailure).code }
            )
      ).then(result =>
        result.ok && DEFAULT_ASSETS[result.image.sha256]
          ? { ok: false as const, reason: `default asset: ${DEFAULT_ASSETS[result.image.sha256]}` }
          : result
      )
      resolved.set(cacheKey, pending)
    }
    return pending
  }

  const readPage = (url: string) =>
    safeFetch(url, {
      accept: type => type === 'text/html' || type === 'application/xhtml+xml',
      acceptHeader: 'text/html,application/xhtml+xml',
      fetcher: options.fetcher,
      // Some product pages inline megabytes before </head>; the metadata is near the top.
      maxBytes: 5_000_000,
      userAgent: USER_AGENT,
      webPortsOnly: true
    })

  /** The product's own page: the listing website, past a shortener's meta refresh. */
  const productPage = async (listing: CatalogListing) => {
    let page = await readPage(listing.website)
    for (let hop = 0; page.ok && hop < 2; hop += 1) {
      const target = metaRefreshUrl(new TextDecoder().decode(page.body), page.url)
      if (!target) break
      page = await readPage(target)
    }
    // A shortener page is never the product's (its icon would be the shortener's), and a dead
    // short link may still have a live product: the slug is the product's domain.
    // A dead short link lands on serp.co's catch-all (#98 round 2 S3): not the product either.
    const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(listing.slug)
    const shortener = (url: string) => {
      const host = new URL(url).hostname
      return (
        SHORTENER_HOSTS.has(host) ||
        (SHORTENER_HOSTS.has(new URL(listing.website).hostname) &&
          host !== SERP_APP_HOST &&
          registrableDomain(url) === 'serp.co')
      )
    }
    if (isDomain && (page.ok ? shortener(page.url) : shortener(listing.website))) {
      page = await readPage(`https://${listing.slug}/`)
    }
    return page
  }

  /**
   * The product site's icon and social image (submit v2's prefill logic), once per listing, only
   * from a page the listing owns and that is not parked, for sale, gambling, or spam.
   */
  const siteImages = async (listing: CatalogListing): Promise<SiteImages> => {
    const none = (page: string, reason: string, refused: string[] = []): SiteImages => ({
      icon: null,
      iconReason: reason,
      page,
      refused,
      social: null,
      socialReason: reason
    })
    const page = await productPage(listing)
    if (!page.ok) return none('', `site ${page.code}`)
    if (SHORTENER_HOSTS.has(new URL(page.url).host)) return none(page.url, 'site is a short link')
    const html = new TextDecoder().decode(page.body)
    const refused = pageFlags({ html, url: page.url })
    const domain = registrableDomain(page.url)
    const serpApp = new URL(page.url).hostname === SERP_APP_HOST
    const own = ownDomains(listing)
    const allowed = allowedDomains[listing.slug] === domain
    if (!serpApp && !allowed && !own.has(domain)) {
      refused.unshift(
        isLikelyRebrand(own, domain) ? `likely rebrand to ${domain}` : `off-domain page ${domain}`
      )
    }
    if (refused.length > 0) return none(page.url, 'site refused', refused)

    const metadata = parseSiteMetadata(html, page.url)
    // Only https sources, as at submit v2's intake: the upload fetches them again.
    const secure = (url: string) => url.startsWith('https://')
    let icon: Resolved | null = null
    let iconReason = serpApp
      ? 'SERP app page: its icon is SERP Apps’, not the app’s'
      : 'site has no hostable icon of 64 px or more'
    for (const candidate of (serpApp
      ? []
      : iconCandidates(metadata, page.url, {
          fallbacks: ['/apple-touch-icon.png', '/favicon.ico'],
          minPixels: MIN_ICON_PIXELS,
          vector: false
        })
    )
      .filter(secure)
      .slice(0, 5)) {
      const result = await resolveSource(candidate, MIN_ICON_PIXELS)
      if (result.ok) {
        icon = result
        break
      }
      if (result.reason.startsWith('default asset')) iconReason = `site icon is a ${result.reason}`
    }
    let social: Resolved | null = null
    let socialReason = 'site has no hostable social image'
    if (metadata.socialImage && secure(metadata.socialImage)) {
      // Adult listings take only SERP's own curated screenshot (apps.serp.co, store-new).
      const curated = serpApp && new URL(metadata.socialImage).host === SERP_APP_HOST
      if (isAdultListing(listing) && !curated) {
        socialReason = 'adult listing: only a SERP-curated screenshot is used'
      } else {
        const result = await resolveSource(metadata.socialImage, MIN_SOCIAL_IMAGE_PIXELS)
        if (result.ok) social = result
        else socialReason = `social image ${result.reason}`
      }
    } else if (isAdultListing(listing)) {
      socialReason = 'adult listing: only a SERP-curated screenshot is used'
    }
    return { icon, iconReason, page: page.url, refused: [], social, socialReason }
  }

  const objects = new Map<string, HostedEntry>()
  const operations: Array<Record<string, unknown> & { slug: string }> = []
  const outcomes: ListingOutcome[] = []
  const rowSources = new Map<string, { failed: number; hosted: number; rows: number }>()
  const rowReasons = new Map<string, number>()
  const tally = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1)

  const work = async (listing: CatalogListing) => {
    const rows = snapshot.rows(listing.id)
    const results = await Promise.all(
      rows.map(async (row): Promise<Resolution | { hosted: HostedEntry; ok: true }> => {
        const hosted = alreadyHosted(row)
        if (hosted) return { hosted, ok: true }
        return resolveSource(sourceFor(row.url))
      })
    )
    const outcome: ListingOutcome = {
      adult: isAdultListing(listing),
      defaults: [],
      images: { kind: 'none' },
      logo: { kind: 'none' },
      slug: listing.slug
    }
    rows.forEach((row, index) => {
      const result = results[index]
      if (result && 'hosted' in result) return
      const source = classifySource(row.url)
      const entry = rowSources.get(source) ?? { failed: 0, hosted: 0, rows: 0 }
      entry.rows += 1
      if (result?.ok) entry.hosted += 1
      else entry.failed += 1
      rowSources.set(source, entry)
      if (result && !result.ok) {
        tally(rowReasons, result.reason.startsWith('default asset') ? result.reason : result.reason)
        if (result.reason.startsWith('default asset')) outcome.defaults.push(row.kind)
      }
    })
    const logoIndex = rows.findIndex(row => row.kind === 'logo')
    const imageIndexes = rows.flatMap((row, index) => (row.kind === 'image' ? [index] : []))
    const logoResult = logoIndex >= 0 ? results[logoIndex] : undefined
    const imageResults = imageIndexes.map(index => ({ result: results[index], row: rows[index] }))

    const media: { images?: HostedEntry[]; logo?: HostedEntry } = {}
    if (logoResult?.ok) {
      const row = rows[logoIndex]
      media.logo =
        'hosted' in logoResult
          ? logoResult.hosted
          : hostedEntry(logoResult as Resolved, 'logo', listing.slug)
      outcome.logo = {
        kind: 'hosted',
        source: 'hosted' in logoResult ? 'already hosted' : classifySource(row?.url ?? '')
      }
    }
    const keptImages: HostedEntry[] = []
    const keptSources: Array<SourceClass | 'already hosted'> = []
    for (const { result, row } of imageResults) {
      if (!result?.ok) continue
      keptImages.push(
        'hosted' in result ? result.hosted : hostedEntry(result as Resolved, 'image', listing.slug)
      )
      keptSources.push('hosted' in result ? 'already hosted' : classifySource(row?.url ?? ''))
    }

    // An approved rebrand with no row left (a refused replacement removed its dead ones) takes its
    // site's icon and social image like a listing whose rows are dead.
    const approved = Object.hasOwn(allowedDomains, listing.slug)
    const needsLogo = logoIndex >= 0 ? !logoResult?.ok : approved
    const needsImage = imageIndexes.length > 0 ? keptImages.length === 0 : approved
    let site: SiteImages | null = null
    if (needsLogo || needsImage) site = await siteImages(listing)
    if (site && site.refused.length > 0)
      outcome.refused = { page: site.page, reasons: site.refused }

    if (needsLogo) {
      const deadUrl = rows[logoIndex]?.url ?? ''
      const importReason =
        logoIndex < 0
          ? 'no logo'
          : ((logoResult as { reason?: string } | undefined)?.reason ?? 'dead')
      if (site?.icon) {
        media.logo = hostedEntry(site.icon, 'logo', listing.slug)
        outcome.logo = {
          kind: 'replaced',
          pixels: Math.min(site.icon.image.width, site.icon.image.height),
          source: new URL(site.icon.source).host
        }
      } else {
        outcome.logo = {
          kind: 'tile',
          reason:
            KNOWN_DEAD[deadUrl] ??
            `${importReason}; ${site?.refused.length ? `site refused: ${site.refused.join('; ')}` : (site?.iconReason ?? 'no site')}`
        }
      }
    }
    if (keptImages.length > 0) {
      outcome.images = { kind: 'kept', sources: keptSources }
    } else if (needsImage) {
      if (site?.social) {
        keptImages.push(hostedEntry(site.social, 'image', listing.slug))
        outcome.images = {
          from: new URL(site.page).hostname === SERP_APP_HOST ? 'serp-app' : 'site',
          kind: 'replaced',
          source: new URL(site.social.source).host
        }
      } else {
        outcome.images = {
          kind: 'dropped',
          reason: site?.refused.length ? 'site refused' : (site?.socialReason ?? 'no site')
        }
      }
    }
    const hostedImages = new Map<string, HostedEntry>()
    for (const entry of keptImages)
      if (!hostedImages.has(entry.key)) hostedImages.set(entry.key, entry)
    if (hostedImages.size) media.images = [...hostedImages.values()]
    // Rows already hosted are in the bucket; only new objects go into the upload plan.
    const alreadyInBucket = new Set(rows.flatMap(row => (row.media_key ? [row.media_key] : [])))
    for (const entry of [media.logo, ...(media.images ?? [])]) {
      if (entry && !alreadyInBucket.has(entry.key)) objects.set(entry.key, entry)
    }
    const unchanged =
      rows.every(row => alreadyHosted(row)) &&
      rows.length === (media.logo ? 1 : 0) + (media.images?.length ?? 0)
    if (!unchanged) {
      operations.push({
        action: 'listing-media-update',
        id: listing.id,
        slug: listing.slug,
        expected: rows.map(row => ({ kind: row.kind, url: row.url, key: row.media_key ?? null })),
        media
      })
    }
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
  operations.sort((a, b) => codePointCompare(a.slug, b.slug))
  outcomes.sort((a, b) => codePointCompare(a.slug, b.slug))

  // Row-level manifests: each applies on any environment whose listing rows still match.
  const manifests: Array<{ file: string; text: string }> = []
  const chunks = Math.ceil(operations.length / perManifest)
  for (let index = 0; index < chunks; index += 1) {
    const id = `${migrationId}-${String(index + 1).padStart(2, '0')}`
    const header = [
      `# serpcompany/best.serp.co#95, part ${index + 1} of ${chunks}: repoint listing logos and images to`,
      `# hosted copies (scripts/migration/legacy-media.ts). Upload d1/media/${migrationId}.json to the`,
      '# environment first: the publisher refuses keys its bucket does not hold. Each part checks its',
      "# listings' rows, not a base version, so the parts apply in any order, staging first.",
      ''
    ].join('\n')
    const body = stringify(
      {
        version: 1,
        id,
        concurrency: 'rows',
        provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
        operations: operations.slice(index * perManifest, (index + 1) * perManifest)
      },
      { lineWidth: 0 }
    )
    manifests.push({ file: `d1/publications/${id}.yaml`, text: `${header}${body}` })
  }

  const plan = {
    id: migrationId,
    objects: [...objects.values()]
      .sort((a, b) => codePointCompare(a.key, b.key))
      .map(entry => {
        const md5 = entryMd5.get(entry)
        if (!md5) throw new Error(`No MD5 for ${entry.key}.`)
        const { bytes, contentType, height, key, sha256, source, width } = entry
        return { bytes, contentType, height, key, md5, sha256, source, width }
      }),
    site: 'best.serp.co',
    version: 1 as const
  }
  // Adult by name but not by category: add the Adult category, compared and swapped on each
  // listing's current categories. Once applied, the category carries the adult rule.
  const missingAdult = listings.filter(
    listing =>
      !listing.adult &&
      isAdultListing(listing) &&
      Array.isArray(listing.categories) &&
      listing.categories.length > 0
  )
  const categoryId = `${migrationId}-adult-category`
  const categoryManifest = missingAdult.length
    ? {
        file: `d1/publications/${categoryId}.yaml`,
        text: `${[
          '# serpcompany/best.serp.co#95 (#98 owner decision): add the Adult category to adult listings',
          '# that lack it, as a secondary category. Row-level: each operation checks the listing',
          '# still has exactly the categories it lists. Independent of the media parts.',
          ''
        ].join('\n')}${stringify(
          {
            version: 1,
            id: categoryId,
            concurrency: 'rows',
            provenance: { actor: 'devinschumacher', workflow: 'github/publish-d1' },
            operations: missingAdult.map(listing => ({
              action: 'listing-categories-add',
              id: listing.id,
              slug: listing.slug,
              expected: listing.categories,
              add: ['adult']
            }))
          },
          { lineWidth: 0 }
        )}`
      }
    : null
  return {
    categoryManifest,
    manifests,
    outcomes,
    plan,
    report: renderReport({
      adultByName: listings
        .filter(listing => !listing.adult && isAdultListing(listing))
        .map(listing => listing.slug),
      allowed: Object.keys(allowedDomains).length,
      manifests: manifests.length,
      migrationId,
      perManifest,
      operations: operations.length,
      outcomes,
      plan,
      rowReasons,
      rowSources
    })
  }
}

function table(header: [string, string], rows: Array<[string, number]>): string[] {
  return [
    `| ${header[0]} | ${header[1]} |`,
    '| --- | --- |',
    ...rows.map(([a, b]) => `| ${a} | ${b} |`)
  ]
}

function counted(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || codePointCompare(a[0], b[0]))
}

/** A reason without the per-listing detail, so the report can count it. */
function reasonClass(reason: string): string {
  return reason
    .replace(/off-domain page [^\s;]+/gu, 'off-domain page')
    .replace(/likely rebrand to [^\s;]+/gu, 'likely rebrand')
    .replace(/parking (host|asset) [^\s;]+/gu, 'parking $1')
    .replace(/\("[^"]*"\)/gu, '')
    .replace(
      /site (http_\d+|fetch_timeout|site_unreachable|invalid_target|too_many_redirects|response_too_large|unexpected_type|read_failed|invalid_redirect)/gu,
      'site unreachable ($1)'
    )
    .replace(/\s+/gu, ' ')
    .replace(/ ;/gu, ';')
    .trim()
}

function renderReport(input: {
  adultByName: string[]
  allowed: number
  manifests: number
  migrationId: string
  perManifest: number
  operations: number
  outcomes: ListingOutcome[]
  plan: MigrationResult['plan']
  rowReasons: Map<string, number>
  rowSources: Map<string, { failed: number; hosted: number; rows: number }>
}): string {
  const { outcomes, plan } = input
  const mib = (plan.objects.reduce((total, object) => total + object.bytes, 0) / 1_048_576).toFixed(
    1
  )
  const logos = outcomes.map(outcome => outcome.logo)
  const replacedLogos = logos.flatMap(logo => (logo.kind === 'replaced' ? [logo] : []))
  const sizeBand = (pixels: number) =>
    pixels >= 512
      ? '512 px or more'
      : pixels >= 256
        ? '256–511 px'
        : pixels >= 128
          ? '128–255 px'
          : '64–127 px'
  const refused = outcomes.filter(outcome => outcome.refused)
  const isRebrand = (outcome: ListingOutcome) =>
    outcome.refused?.reasons.length === 1 &&
    outcome.refused.reasons[0]?.startsWith('likely rebrand')
  const rebrands = refused.filter(isRebrand)
  const otherRefused = refused.filter(outcome => !isRebrand(outcome))
  const refusedRow = (outcome: ListingOutcome) =>
    `| \`${outcome.slug}\` | ${outcome.refused?.page.replace(/\|/gu, '%7C')} | ${outcome.refused?.reasons.join('; ').replace(/\|/gu, '/')} |`
  const curatedReplaced = outcomes.filter(
    outcome => outcome.images.kind === 'replaced' && outcome.images.from === 'serp-app'
  )
  const adultFromSites = outcomes.filter(
    outcome =>
      outcome.adult && outcome.images.kind === 'replaced' && outcome.images.from !== 'serp-app'
  ).length
  const lines = [
    `# Legacy media migration (${input.migrationId})`,
    '',
    'Generated by `scripts/migration/legacy-media.ts` for serpcompany/best.serp.co#95. Every count',
    'below is computed from the committed plan and manifests.',
    '',
    `- Listings with a logo or image: ${outcomes.length}`,
    `- Listings repointed (operations): ${input.operations}`,
    `- Objects to upload: ${plan.objects.length} (${mib} MiB)`,
    `- Manifests: ${input.manifests} (listing-media-update, row-level, ${input.perManifest} listings each)`,
    '',
    '## Objects by format',
    '',
    ...table(['Format', 'Objects'], counted(plan.objects.map(object => object.contentType))),
    '',
    '## Imported rows by source',
    '',
    '| Source | Rows | Fetched and hostable | Dead, unusable, or a default asset |',
    '| --- | --- | --- | --- |',
    ...[...input.rowSources.entries()]
      .sort(([a], [b]) => codePointCompare(a, b))
      .map(
        ([source, value]) => `| ${source} | ${value.rows} | ${value.hosted} | ${value.failed} |`
      ),
    '',
    '## Why imported rows were dead or unusable',
    '',
    ...table(
      ['Reason', 'Rows'],
      [...input.rowReasons.entries()].sort((a, b) => b[1] - a[1] || codePointCompare(a[0], b[0]))
    ),
    '',
    '## Logos by source',
    '',
    ...table(
      ['Logo', 'Listings'],
      counted(
        logos.map(logo =>
          logo.kind === 'hosted'
            ? `hosted from its imported source (${logo.source})`
            : logo.kind === 'replaced'
              ? 'replaced from the site icon'
              : logo.kind === 'tile'
                ? 'fallback tile'
                : 'none in the catalog'
        )
      )
    ),
    '',
    `Replacement logos by shorter side (minimum ${MIN_ICON_PIXELS} px):`,
    '',
    ...table(['Size', 'Logos'], counted(replacedLogos.map(logo => sizeBand(logo.pixels)))),
    '',
    '## Fallback tiles by reason',
    '',
    ...table(
      ['Reason', 'Listings'],
      counted(
        logos.flatMap(logo =>
          logo.kind === 'tile'
            ? [reasonClass(logo.reason.split('; ').slice(1).join('; ') || logo.reason)]
            : []
        )
      )
    ),
    '',
    '## Featured images by source',
    '',
    ...table(
      ['Featured image', 'Listings'],
      counted(
        outcomes.map(outcome => {
          const images = outcome.images
          if (images.kind === 'kept') return `kept from the catalog (${images.sources[0]})`
          if (images.kind === 'replaced') {
            return images.from === 'serp-app'
              ? 'replaced from SERP’s curated screenshot (apps.serp.co)'
              : "replaced from the site's social image"
          }
          if (images.kind === 'dropped') return `none left (${reasonClass(images.reason)})`
          return 'none in the catalog'
        })
      )
    ),
    '',
    '## Owner sign-off',
    '',
    '### Likely rebrands',
    '',
    `${rebrands.length} listings whose page moved to a domain with the same brand. Approving one is a`,
    `line in \`${ALLOWED_DOMAINS_FILE}\` (\`"<slug>": "<domain>"\`); the next regeneration then takes`,
    `its replacement. Approved so far: ${input.allowed}.`,
    '',
    '| Listing | Final page | Why |',
    '| --- | --- | --- |',
    ...rebrands.map(refusedRow),
    '',
    '### Replacements refused: off-domain, parked, for sale, gambling, or spam',
    '',
    `${otherRefused.length} listings. Their dead images were not replaced; they keep the fallback`,
    'tile (and no featured image) until the owner decides. Listing content is unchanged; #100',
    'covers unpublishing hijacked listings.',
    '',
    '| Listing | Final page | Why |',
    '| --- | --- | --- |',
    ...otherRefused.map(refusedRow),
    '',
    '### Adult by name, not in the Adult category',
    '',
    `${input.adultByName.length} listings are treated as adult (only SERP's curated screenshots) by`,
    'their platform name. The separate `-adult-category` manifest adds the Adult category to them:',
    '',
    input.adultByName.map(slug => `\`${slug}\``).join(', ') || 'none',
    '',
    '### Featured images from SERP’s curated screenshots',
    '',
    `${curatedReplaced.length} SERP app listings get the screenshot their apps.serp.co page names`,
    '(serpcompany/store-new) as their featured image; adult listings are marked.',
    `Adult listings with a featured image from any other site: ${adultFromSites} (none is allowed).`,
    '',
    ...curatedReplaced.map(outcome => {
      const object = plan.objects.find(entry =>
        entry.key.startsWith(`best.serp.co/listings/${outcome.slug}/image/`)
      )
      return `- \`${outcome.slug}\`${outcome.adult ? ' (Adult)' : ''}: ${object?.source ?? 'unknown'}`
    }),
    '',
    '### Default assets treated as missing',
    '',
    'Wherever they appear: an imported row, or a site icon or social image offered as a',
    'replacement (the listing then keeps the tile, or no featured image).',
    '',
    '| Asset | Imported rows | Replacements refused |',
    '| --- | --- | --- |',
    ...Object.entries(DEFAULT_ASSETS).map(([sha, name]) => {
      const marker = `default asset: ${name}`
      // A tile's reason is "<imported row>; <site>": only the site part is a refused replacement.
      const refusedReplacements = outcomes.filter(
        outcome =>
          (outcome.logo.kind === 'tile' &&
            outcome.logo.reason.split('; ').slice(1).join('; ').includes(marker)) ||
          (outcome.images.kind === 'dropped' && outcome.images.reason.includes(marker))
      ).length
      return `| ${name} (\`${sha.slice(0, 12)}\`) | ${input.rowReasons.get(marker) ?? 0} | ${refusedReplacements} |`
    }),
    '',
    '## Logos on the fallback tile',
    '',
    ...logos.flatMap((logo, index) =>
      logo.kind === 'tile' ? [`- \`${outcomes[index]?.slug}\`: ${logo.reason}`] : []
    ),
    ''
  ]
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(value => value !== '--')
  const option = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  // Owner-approved rebrands: the checked-in file, plus `--allow-domain <slug>=<domain>` flags.
  const allowedDomains: Record<string, string> = existsSync(resolve(ALLOWED_DOMAINS_FILE))
    ? (JSON.parse(readFileSync(resolve(ALLOWED_DOMAINS_FILE), 'utf8')) as Record<string, string>)
    : {}
  args.forEach((value, index) => {
    if (value !== '--allow-domain') return
    const [slug, domain] = (args[index + 1] ?? '').split('=')
    if (!slug || !domain) throw new Error('--allow-domain <slug>=<domain>')
    allowedDomains[slug] = domain
  })
  // `--snapshot-sql <listings|media>`: the read-only query for a `--current` export. The listings
  // query includes every approved rebrand, even one with no rows left.
  const sql = option('--snapshot-sql')
  if (sql) {
    if (sql !== 'listings' && sql !== 'media') throw new Error('--snapshot-sql listings|media')
    console.log(
      sql === 'listings' ? snapshotListingsSql(Object.keys(allowedDomains)) : SNAPSHOT_MEDIA_SQL
    )
    return
  }
  const limit = option('--limit') ? Number(option('--limit')) : undefined
  const current = option('--current')
  // `--part-size <n>`: listings per manifest (smaller parts if staging refuses a batch).
  const partSize = option('--part-size') ? Number(option('--part-size')) : undefined
  // `--manifest-id <id>`: new ids for a regeneration (an id that succeeded is never reused).
  const migrationId = option('--manifest-id') ?? MIGRATION_ID
  // `--refresh <upload summary>`: refetch the source of every object an upload reported failed.
  const refresh = new Set<string>()
  const summaryPath = option('--refresh')
  if (summaryPath) {
    const summary = JSON.parse(readFileSync(resolve(summaryPath), 'utf8')) as {
      failed: Array<{ key: string }>
    }
    const plan = JSON.parse(readFileSync(resolve(`d1/media/${migrationId}.json`), 'utf8')) as {
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
  const result = await migrateLegacyMedia({
    allowedDomains,
    fetcher,
    limit,
    listingsPerManifest: partSize,
    migrationId,
    snapshot: current ? currentSnapshot(current) : undefined
  })
  mkdirSync(resolve('d1/media'), { recursive: true })
  writeFileSync(
    resolve(`d1/media/${migrationId}.json`),
    `${JSON.stringify(result.plan, null, 1)}\n`
  )
  writeFileSync(resolve(`d1/media/${migrationId}.report.md`), result.report)
  // A regeneration replaces every part: stale parts from an earlier, larger run are removed.
  for (const file of readdirSync(resolve('d1/publications'))) {
    if (file.startsWith(`${migrationId}-`)) rmSync(resolve('d1/publications', file))
  }
  for (const manifest of result.manifests) writeFileSync(resolve(manifest.file), manifest.text)
  if (result.categoryManifest) {
    writeFileSync(resolve(result.categoryManifest.file), result.categoryManifest.text)
  }
  console.log(result.report.split('## Owner sign-off')[0])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
