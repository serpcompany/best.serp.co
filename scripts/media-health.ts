import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_CONTENT_TYPES } from '@serpdirectory/data-ops/media-format'
import { MEDIA_CACHE_CONTROL, MEDIA_SITE, parseMediaKey } from '@serpdirectory/data-ops/media-keys'
import { type D1Row, processRunner, validateRemoteConfig, wranglerD1 } from './cloudflare-release'
import { project, type RemoteEnvironment } from './project'
import {
  describeFetchError,
  type ListedObject,
  listR2Objects,
  type R2CallOptions,
  RateLimiter,
  systemClock
} from './r2-objects'

/**
 * Read-only health check of hosted listing media (serpcompany/best.serp.co#122). It lists every
 * listing logo and image row an environment's D1 holds (one SELECT through the release tooling's
 * Wrangler D1 target), lists the environment's bucket through the R2 API (1,000 objects per call,
 * on the uploader's shared rate limiter, `r2-objects.ts`), and HEADs a sample of the keys on the
 * media host. It reports:
 *
 * - `not_hosted`: a row with no key, rendered from its source URL (a hotlink) until repointed;
 * - `foreign_key`: a key that is not this listing's `listings/<slug>/<kind>/` key;
 * - `missing`: no object under the key, so the page shows the #86 tile;
 * - `bytes_mismatch`, `content_type_mismatch`, `not_an_image`, `cache_control_mismatch`,
 *   `md5_mismatch`: the object is not the one D1 (or its reviewed `d1/media` plan) recorded;
 * - `cdn_404`, `cdn_not_an_image`, `cdn_content_type`, `cdn_bytes`: the media host says the
 *   object is gone, or serves something other than what D1 recorded.
 *
 * A HEAD the media host would not answer for this client (a 403 or 429, usually Cloudflare's bot
 * protection challenging the CI runner, any other status, or no answer) is `unverifiable`: listed
 * in the summary, never a finding, since the bucket check already proved the object (#134).
 *
 * It writes nothing: no D1 statement but the SELECT, no R2 call but list, no HTTP method but HEAD
 * (`scripts/deploy-workflows.test.ts` holds it to that). `media-health.yml` runs it weekly for
 * production and files the report with `media-health-issue.ts`. Re-queueing affected listings
 * (`media_ingestions`) is left to the reviewed write paths: the admin edit or a manifest.
 */

export const MEDIA_HEALTH_SQL = `SELECT l.slug AS slug,
  CASE WHEN l.status = 'approved' AND l.is_active = 1 AND l.published_at IS NOT NULL THEN 1 ELSE 0 END AS live,
  m.kind AS kind, m.sort_order AS sort_order, m.url AS url, m.media_key AS media_key,
  m.content_type AS content_type, m.bytes AS bytes
FROM listing_media m JOIN listings l ON l.id = m.listing_id
WHERE m.kind IN ('logo', 'image')
ORDER BY l.slug, m.kind, m.sort_order`

/** Keys this site's listings use in the shared bucket. */
export const LISTING_MEDIA_PREFIX = `${MEDIA_SITE}/listings/`
/** Media-host HEADs per run: a sample, rotated weekly, not the whole catalog. */
export const DEFAULT_CDN_SAMPLE = 50
/** Names the check to the media host's logs and bot rules. */
export const MEDIA_HEALTH_USER_AGENT =
  'best-serp-co-media-health/1.0 (+https://github.com/serpcompany/best.serp.co; read-only weekly listing media check)'
/** At this share of unverifiable HEADs, the summary says the CDN sample proved little. */
export const UNVERIFIABLE_WARNING_SHARE = 0.2
const imageContentTypes = new Set(Object.values(IMAGE_CONTENT_TYPES))

export interface MediaRow {
  bytes: number | null
  contentType: string | null
  key: string | null
  kind: string
  live: boolean
  slug: string
  url: string
}

export interface MediaFinding {
  detail?: string
  key: string | null
  kind: string
  live: boolean
  problem: string
  slug: string
}

/** A HEAD the media host would not answer for this client: informational, never a finding. */
export interface UnverifiableHead {
  /** What answered instead: the status, `cf-mitigated`, a Cloudflare HTML page, or the error. */
  detail: string
  key: string
  kind: string
  slug: string
}

export interface MediaHealthReport {
  bucket: string
  cdnSampled: number
  cdnUnverifiable: UnverifiableHead[]
  checkedAt: string
  environment: RemoteEnvironment
  findings: MediaFinding[]
  hostedKeys: number
  listedObjects: number
  mediaBaseUrl: string
  rows: number
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** D1's rows, checked field by field: a malformed answer stops the check. */
export function parseMediaRows(rows: D1Row[]): MediaRow[] {
  return rows.map(row => {
    const slug = text(row.slug)
    const kind = text(row.kind)
    if (!slug || (kind !== 'logo' && kind !== 'image') || typeof row.url !== 'string') {
      throw new Error('D1 returned a malformed listing_media row.')
    }
    return {
      bytes: typeof row.bytes === 'number' ? row.bytes : null,
      contentType: text(row.content_type),
      key: text(row.media_key),
      kind,
      live: row.live === 1,
      slug,
      url: row.url
    }
  })
}

/** Each reviewed plan object's MD5 (R2's ETag of the same bytes), by key. */
export function plannedMd5s(directory = resolve('d1/media')): Map<string, string> {
  const md5s = new Map<string, string>()
  for (const file of readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()) {
    const plan = JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as {
      objects?: Array<{ key?: unknown; md5?: unknown }>
    }
    for (const object of plan.objects ?? []) {
      if (typeof object.key === 'string' && typeof object.md5 === 'string') {
        md5s.set(object.key, object.md5)
      }
    }
  }
  return md5s
}

/** What D1 references that the bucket does not hold, or holds differently. */
export function bucketFindings(
  rows: MediaRow[],
  listed: ReadonlyMap<string, ListedObject>,
  md5s: ReadonlyMap<string, string>
): MediaFinding[] {
  const findings: MediaFinding[] = []
  for (const row of rows) {
    const finding = (problem: string, detail?: string) =>
      findings.push({
        ...(detail ? { detail } : {}),
        key: row.key,
        kind: row.kind,
        live: row.live,
        problem,
        slug: row.slug
      })
    if (!row.key) {
      finding('not_hosted', row.url)
      continue
    }
    const parsed = parseMediaKey(row.key)
    if (parsed?.scope !== 'listings' || parsed.slug !== row.slug || parsed.kind !== row.kind) {
      finding('foreign_key')
      continue
    }
    const object = listed.get(row.key)
    if (!object) {
      finding('missing')
      continue
    }
    if (row.bytes !== null && object.size !== row.bytes) {
      finding('bytes_mismatch', `${object.size} != ${row.bytes}`)
    }
    if (!object.contentType || !imageContentTypes.has(object.contentType)) {
      finding('not_an_image', object.contentType ?? 'no content type')
    } else if (row.contentType && object.contentType !== row.contentType) {
      finding('content_type_mismatch', `${object.contentType} != ${row.contentType}`)
    }
    if (object.cacheControl !== null && object.cacheControl !== MEDIA_CACHE_CONTROL) {
      finding('cache_control_mismatch', object.cacheControl)
    }
    const md5 = md5s.get(row.key)
    if (md5 && object.etag !== md5) finding('md5_mismatch')
  }
  return findings
}

/**
 * Up to `size` hosted keys, spread evenly over the sorted list and rotated by `rotation` (the
 * ISO week), so successive weeks HEAD different keys.
 */
export function sampleKeys(keys: string[], size: number, rotation: number): string[] {
  const sorted = [...new Set(keys)].sort()
  if (sorted.length <= size) return sorted
  const step = sorted.length / size
  const offset = rotation % Math.max(1, Math.floor(step))
  return Array.from(
    { length: size },
    (_, index) => sorted[Math.floor(index * step) + offset] ?? ''
  ).filter(Boolean)
}

function isoWeek(date: Date): number {
  return Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000))
}

export type HeadResult =
  | { status: 'ok' }
  | { detail?: string; problem: string; status: 'finding' }
  | { detail: string; status: 'unverifiable' }

/** What a response that is not about the object says about itself: status and block signals. */
function blockDetail(response: Response): string {
  const mitigated = response.headers.get('cf-mitigated')
  const html = /^text\/html\b/iu.test(response.headers.get('content-type') ?? '')
  return [
    String(response.status),
    mitigated ? `cf-mitigated: ${mitigated}` : null,
    html && /cloudflare/iu.test(response.headers.get('server') ?? '')
      ? 'Cloudflare HTML page'
      : null
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * HEADs one key on the media host. Only an answer about the object is a finding: a 404, a type
 * that is not an image, or a type or size other than D1's. A block (403, 429, a challenge), any
 * other status, or no answer after three tries is unverifiable (#134).
 */
export async function headFinding(
  url: string,
  row: Pick<MediaRow, 'bytes' | 'contentType'>,
  fetcher: typeof fetch,
  options: R2CallOptions
): Promise<HeadResult> {
  const limiter = options.limiter ?? new RateLimiter(60, 60_000, 4)
  const clock = options.clock ?? systemClock
  let response: Response | null = null
  let failure = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await limiter.acquire()
    try {
      response = await fetcher(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/*;q=0.9,*/*;q=0.5',
          'User-Agent': MEDIA_HEALTH_USER_AGENT
        },
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      })
    } catch (error) {
      response = null
      failure = describeFetchError(error)
    }
    // Only a server error or no answer is worth another try; a block is not.
    if (response && response.status < 500) break
    if (attempt < 3) await clock.sleep(2000 * attempt)
  }
  if (!response) return { detail: `no answer: ${failure}`, status: 'unverifiable' }

  // A challenge (`cf-mitigated`) is never the object's answer, whatever its status.
  const challenged = response.headers.has('cf-mitigated')
  if (response.status === 404 && !challenged) return { problem: 'cdn_404', status: 'finding' }
  if (response.status !== 200 || challenged) {
    return { detail: blockDetail(response), status: 'unverifiable' }
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null
  if (!type || !imageContentTypes.has(type)) {
    return { detail: type ?? 'no content type', problem: 'cdn_not_an_image', status: 'finding' }
  }
  if (row.contentType && type !== row.contentType) {
    return {
      detail: `${type} != ${row.contentType}`,
      problem: 'cdn_content_type',
      status: 'finding'
    }
  }
  const length = response.headers.get('content-length')
  if (length !== null && row.bytes !== null && Number(length) !== row.bytes) {
    return { detail: `${length} != ${row.bytes}`, problem: 'cdn_bytes', status: 'finding' }
  }
  return { status: 'ok' }
}

export interface MediaHealthDependencies {
  fetch?: typeof fetch
  /** Reviewed plan MD5s by key; read from `d1/media` by default. */
  md5s?: ReadonlyMap<string, string>
  now?: () => Date
  /** The SELECT; Wrangler against the environment's remote D1 by default. */
  query?: (sql: string) => Promise<D1Row[]>
  r2?: R2CallOptions
  sample?: number
}

export async function checkMediaHealth(
  environment: RemoteEnvironment,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: MediaHealthDependencies = {}
): Promise<MediaHealthReport> {
  const fetcher = dependencies.fetch ?? fetch
  const now = (dependencies.now ?? (() => new Date()))()
  const { bucket, baseUrl } = project.remote[environment].media
  const query =
    dependencies.query ??
    (sql => wranglerD1(environment, { kind: 'remote' }, processRunner).query(sql))
  const rows = parseMediaRows(await query(MEDIA_HEALTH_SQL))
  const listed = await listR2Objects(bucket, LISTING_MEDIA_PREFIX, env, fetcher, dependencies.r2)
  const findings = bucketFindings(rows, listed, dependencies.md5s ?? plannedMd5s())

  const flagged = new Set(findings.map(finding => finding.key))
  const healthy = rows.filter(row => row.key && !flagged.has(row.key))
  const byKey = new Map(healthy.map(row => [row.key as string, row]))
  const sampled = sampleKeys(
    [...byKey.keys()],
    dependencies.sample ?? DEFAULT_CDN_SAMPLE,
    isoWeek(now)
  )
  // The media host is a CDN, not the API: its own gentle limiter (60 a minute).
  const cdnOptions: R2CallOptions = {
    ...dependencies.r2,
    limiter: dependencies.r2?.limiter ?? new RateLimiter(60, 60_000, 4)
  }
  const cdnUnverifiable: UnverifiableHead[] = []
  for (const key of sampled) {
    const row = byKey.get(key)
    if (!row) continue
    const result = await headFinding(`${baseUrl}/${key}`, row, fetcher, cdnOptions)
    if (result.status === 'finding') {
      findings.push({
        ...(result.detail ? { detail: result.detail } : {}),
        key,
        kind: row.kind,
        live: row.live,
        problem: result.problem,
        slug: row.slug
      })
    } else if (result.status === 'unverifiable') {
      cdnUnverifiable.push({ detail: result.detail, key, kind: row.kind, slug: row.slug })
    }
  }

  return {
    bucket,
    cdnSampled: sampled.length,
    cdnUnverifiable,
    checkedAt: now.toISOString(),
    environment,
    findings: findings.sort((a, b) =>
      `${a.slug} ${a.kind} ${a.problem}`.localeCompare(`${b.slug} ${b.kind} ${b.problem}`)
    ),
    hostedKeys: new Set(rows.flatMap(row => (row.key ? [row.key] : []))).size,
    listedObjects: listed.size,
    mediaBaseUrl: baseUrl,
    rows: rows.length
  }
}

/** The issue marker: one open health issue per environment. */
export function mediaHealthMarker(environment: RemoteEnvironment): string {
  return `<!-- best-serp-co-media-health:${environment} -->`
}

/** True when so many HEADs went unanswered that the CDN sample proves little this run. */
export function unverifiableIsHigh(report: MediaHealthReport): boolean {
  return (
    report.cdnSampled > 0 &&
    report.cdnUnverifiable.length / report.cdnSampled >= UNVERIFIABLE_WARNING_SHARE
  )
}

/** The informational note on HEADs the media host would not answer: never a finding. */
function unverifiableLines(report: MediaHealthReport): string[] {
  const unverifiable = report.cdnUnverifiable
  if (unverifiable.length === 0) return []
  const reasons = new Map<string, number>()
  for (const head of unverifiable) reasons.set(head.detail, (reasons.get(head.detail) ?? 0) + 1)
  return [
    `${unverifiable.length} of ${report.cdnSampled} HEADs were unverifiable (the media host blocked or did not answer this client: ${[
      ...reasons
    ]
      .sort()
      .map(([reason, count]) => `${reason} ×${count}`)
      .join(', ')}). Informational only: the bucket check covers those objects.`,
    ...(unverifiableIsHigh(report)
      ? [
          '',
          `**Warning:** ${Math.round((unverifiable.length / report.cdnSampled) * 100)}% of the CDN sample was unverifiable, so this run says little about ${report.mediaBaseUrl} itself.`
        ]
      : []),
    ''
  ]
}

/** Findings rows shown in a summary or issue; GitHub caps an issue body at 65,536 characters. */
const MAX_FINDING_ROWS = 300

export function mediaHealthMarkdown(report: MediaHealthReport): string {
  const counts = new Map<string, number>()
  for (const finding of report.findings) {
    counts.set(finding.problem, (counts.get(finding.problem) ?? 0) + 1)
  }
  const lines = [
    mediaHealthMarker(report.environment),
    `## Listing media health: ${report.environment}`,
    '',
    `Checked ${report.checkedAt} by \`pnpm media:health -- ${report.environment}\` (docs/MEDIA_HEALTH.md): ${report.rows} logo and image rows, ${report.hostedKeys} hosted keys, ${report.listedObjects} objects in \`${report.bucket}\`, ${report.cdnSampled} HEADs on ${report.mediaBaseUrl}.`,
    '',
    ...unverifiableLines(report)
  ]
  if (report.findings.length === 0) {
    lines.push('No missing or mismatched objects.')
    return `${lines.join('\n')}\n`
  }
  lines.push(
    `**${report.findings.length} finding(s):** ${[...counts]
      .sort()
      .map(([problem, count]) => `\`${problem}\` ${count}`)
      .join(', ')}`,
    '',
    'A listing with a missing or broken object shows the fallback tile. Re-host it from the admin listing edit (a new logo URL), or with a reviewed media plan and manifest.',
    '',
    '| Listing | Live | Kind | Problem | Key or source |',
    '| --- | --- | --- | --- | --- |'
  )
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ')
  for (const finding of report.findings.slice(0, MAX_FINDING_ROWS)) {
    lines.push(
      `| \`${cell(finding.slug)}\` | ${finding.live ? 'yes' : 'no'} | ${finding.kind} | \`${finding.problem}\`${finding.detail && finding.key ? ` (${cell(finding.detail)})` : ''} | ${cell(finding.key ?? finding.detail ?? '')} |`
    )
  }
  if (report.findings.length > MAX_FINDING_ROWS) {
    lines.push('', `… and ${report.findings.length - MAX_FINDING_ROWS} more in the run's report.`)
  }
  return `${lines.join('\n')}\n`
}

export interface MediaHealthArguments {
  environment: RemoteEnvironment
  report?: string
  sample?: number
}

export function parseMediaHealthArguments(argv: string[]): MediaHealthArguments {
  const args = argv.filter(value => value !== '--')
  const usage =
    'Usage: pnpm media:health -- <staging|production> [--report <file.json>] [--sample <n>]'
  const [environment, ...rest] = args
  if (environment !== 'staging' && environment !== 'production') throw new Error(usage)
  const parsed: MediaHealthArguments = { environment }
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1]
    if (rest[index] === '--report' && value) parsed.report = value
    else if (rest[index] === '--sample' && value && /^\d{1,4}$/u.test(value)) {
      parsed.sample = Number(value)
    } else throw new Error(usage)
  }
  return parsed
}

async function main(): Promise<void> {
  const args = parseMediaHealthArguments(process.argv.slice(2))
  validateRemoteConfig(args.environment)
  const report = await checkMediaHealth(args.environment, process.env, {
    ...(args.sample === undefined ? {} : { sample: args.sample })
  })
  if (args.report) writeFileSync(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, mediaHealthMarkdown(report))
  }
  const { cdnUnverifiable, findings, ...summary } = report
  console.log(
    JSON.stringify(
      { ...summary, cdnUnverifiable: cdnUnverifiable.length, findings: findings.length },
      null,
      2
    )
  )
  if (unverifiableIsHigh(report)) {
    // A warning, never a failure: the bucket check is the evidence (#134).
    console.log(
      `::warning title=CDN sample unverifiable::${cdnUnverifiable.length} of ${report.cdnSampled} HEADs on ${report.mediaBaseUrl} were blocked or unanswered; see the job summary.`
    )
  }
  for (const finding of findings.slice(0, 50)) {
    console.error(`${finding.problem} ${finding.slug} ${finding.kind} ${finding.key ?? ''}`)
  }
  if (findings.length > 0) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
