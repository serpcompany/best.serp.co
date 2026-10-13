/**
 * Post-deploy HTTP gates for the staging and production Workers, plus a manual check of the
 * public site.
 *
 *   pnpm tsx scripts/d1-preview-http-gates.ts <staging|production|public> <https-origin> [output]
 *
 * - `staging <origin>`: the staging Worker. Given `https://staging.best.serp.co`, its canonical
 *   host (#323), it gates through the staging workers.dev origin with the smoke-test header, as
 *   production does, and with staging's `CANONICAL_HOST_REDIRECT=on` requires that host to answer
 *   one 308 to staging.best.serp.co without the header. Any other origin is gated as given.
 *   `deploy-production.yml` also runs it on the production workers.dev origin while best.serp.co
 *   is still GitHub Pages; that branch is the step-order guard for the canonical-host switch (an
 *   early flip fails its "`/` is not redirected" check).
 * - `production <origin>`: the production Worker. The origin may be `https://best.serp.co` or
 *   the production workers.dev origin. Routes, versions, and the workers.dev policy are gated
 *   through the workers.dev origin with the smoke-test header. best.serp.co's public policy
 *   (indexable, robots.txt lists the sitemap index, Google Tag Manager loads) is then checked
 *   on best.serp.co itself, without the header: strictly whenever the Worker answers, and
 *   skipped with a `::warning::` only for `serp.co` zone protection (a `cf-mitigated`
 *   challenge, or a 403 or 429 without Worker headers) and for GitHub Pages before the cutover
 *   (`notAnsweredByWorker`). Zone protection therefore never fails a deploy (serp
 *   standards/environment-configuration.md); a 503 without Worker headers or no answer does.
 * - `public https://best.serp.co`: the same best.serp.co checks, run by hand at cutover, with
 *   no skipping.
 *
 * Every request sends the smoke-test header, so a Worker's `*.workers.dev` host answers it
 * instead of redirecting to its canonical host (#42 decision e, #323); the redirect itself is
 * checked with one request without it.
 *
 * When the deploy's Worker version is known, the gates first wait until the Worker is ready:
 * that version answers `/robots.txt` with a 200 in under 2 s three times in a row, within
 * 3 minutes (`waitForWorkerReadiness`, #417). They then require it on every response, retrying
 * a response from another version for up to 60 s. They therefore never pass or fail against the
 * previous deployment while the edge still serves it; they assume a deploy to 100% of traffic
 * (`wrangler deploy`), not a gradual split. The version comes from `EXPECTED_WORKER_VERSION`,
 * or from the `deploy` entry Wrangler writes to `WRANGLER_OUTPUT_FILE_PATH` when the deploy
 * step ran with that variable set.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  type AccessEnv,
  accessConfig,
  accessRequired
} from '../apps/web/src/lib/auth/cloudflare-access'
import {
  SITE_ENVIRONMENT_HEADER,
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../apps/web/src/lib/environment/site-environment'
import {
  metaRobotsBlocksIndexing,
  parseRobotsTxt,
  robotsTxtAllows,
  robotsTxtBlockedPath,
  xRobotsTagBlocksIndexing
} from './crawl-policy'
import { project, type RemoteEnvironment } from './project'
import { bestRoute, categoryRoute, listingRoute, tagRoute } from './site-routes'

export type HttpGateMode = 'staging' | 'production' | 'public'
const defaultRequestTimeoutMs = 15_000
const maxVersionWaitMs = 60_000
const defaultVersionPollIntervalMs = 2_000
/** Consecutive ready answers the Worker must give before the gates start. */
const versionConfirmations = 3
/** The longest the gates, and the staging smoke, wait for the deployed Worker to be ready. */
const maxReadinessWaitMs = 180_000
/** A ready answer takes less than this (#417). */
const defaultReadyLatencyMs = 2_000
const maxBodyProbeBytes = 4_096
// Enough for robots.txt and for the <head> of the home page (its robots meta sits near 6 KB).
const maxTextProbeBytes = 131_072
// The whole home page (about 570 KB): Google Tag Manager's <noscript> follows <body>, and its
// script is in the payload near the end.
const maxDocumentProbeBytes = 4 * 1_048_576
const googleTagManagerMarker = 'googletagmanager.com'
/** The Cloudflare Web Analytics beacon's host (#170), which non-production must not load. */
const webAnalyticsMarker = 'cloudflareinsights.com'
const workerVersionPattern = /^[A-Za-z0-9-]{1,64}$/u
/** The production Worker's platform host: where CI reaches it, with the smoke-test header. */
const productionPlatformOrigin = new URL(project.remote.production.reviewOrigin)
const canonicalOrigin = new URL(project.publicUrl)
/** Staging's canonical host (#323) and the platform host CI gates it through, as production. */
const stagingCanonicalOrigin = new URL(project.remote.staging.origin)
const stagingPlatformOrigin = new URL(project.remote.staging.reviewOrigin)

/** Time source for the version budget; tests pass a virtual clock. */
export interface GateClock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

const realClock: GateClock = {
  now: () => Date.now(),
  sleep: milliseconds =>
    new Promise<void>(done => {
      setTimeout(done, milliseconds)
    })
}

export interface HttpGateOptions {
  clock?: GateClock
  /** The deployed Worker version; gates wait for it and require it on every response. */
  expectedVersion?: string
  /** Where the readiness wait logs each probe; `console.info` by default. */
  log?: (line: string) => void
  /** The reviewed manifests whose retired pages the gates never sample (#260, #350). */
  publicationsDirectory?: string
  /** Budget for the deployed Worker to be ready before the gates start (≤ 180 s). */
  readinessWaitMs?: number
  /** The listing and taxonomy pages the gates request; `httpGateSamples` by default. */
  samples?: HttpGateSamples
  timeoutMs?: number
  versionPollIntervalMs?: number
  /** Once the Worker is ready, the budget for retrying an answer from another version (≤ 60 s). */
  versionWaitMs?: number
  /** Wrangler config whose `CANONICAL_HOST_REDIRECT` per environment decides the host-redirect gate. */
  wranglerConfigPath?: string
}

/** The deployed version every response must come from, and the time left to wait for it. */
interface VersionPin {
  budgetMs: number
  clock: GateClock
  deadline: number
  expected: string
  intervalMs: number
}

interface GateTarget {
  baseUrl: URL
  /** How failures name the request; defaults to `<mode> route`. */
  label?: string
  mode: HttpGateMode
  timeoutMs: number
  version?: VersionPin
}

function parseMode(value: string): HttpGateMode {
  if (value === 'staging' || value === 'production' || value === 'public') return value
  throw new Error('HTTP gate mode must be exactly staging, production, or public.')
}

function validateBaseUrl(mode: HttpGateMode, value: string): URL {
  const baseUrl = new URL(value)
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error(
      `${mode} gates require a clean HTTPS origin with no credentials, port, path, query, or hash.`
    )
  if (
    mode === 'production' &&
    baseUrl.hostname !== project.domain &&
    baseUrl.origin !== productionPlatformOrigin.origin
  )
    throw new Error(
      `Production gates require https://${project.domain} or ${productionPlatformOrigin.origin}; either way they gate through ${productionPlatformOrigin.origin}.`
    )
  if (mode === 'public' && baseUrl.hostname !== project.domain)
    throw new Error(`The public check requires the exact https://${project.domain} origin.`)
  if (mode === 'staging' && baseUrl.hostname === project.domain)
    throw new Error('Staging gates reject the Production hostname.')
  return baseUrl
}

function routeUrl(baseUrl: URL, path: string): URL {
  const url = new URL(path, baseUrl)
  if (url.origin !== baseUrl.origin || url.username || url.password || url.hash)
    throw new Error(`HTTP gate route ${path} escaped the configured origin.`)
  return url
}

/** A gate request other than a plain GET. */
interface GateRequest {
  body: string
  headers: Record<string, string>
  method: 'POST'
}

async function boundedRequest<T>(
  url: URL,
  timeoutMs: number,
  inspect: (response: Response) => Promise<T>,
  smoke = true,
  request?: GateRequest
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('HTTP gate request exceeded its bounded deadline.'))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      fetch(url, {
        ...(request && { body: request.body, method: request.method }),
        headers: { ...request?.headers, ...(smoke ? { [SMOKE_TEST_HEADER]: '1' } : {}) },
        redirect: 'manual',
        signal: controller.signal
      }).then(inspect),
      deadline
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
  }
}

/** Why a response clearly did not come from the Worker. */
export interface NotTheWorker {
  githubPages: boolean
  reason: string
}

/**
 * A best.serp.co response the gates skip, or null when they enforce it. Only two kinds are
 * skipped, and only without the Worker's headers (`x-worker-version`, `x-site-environment`):
 * - `serp.co` zone protection: a Cloudflare challenge (`cf-mitigated`), or a 403 block or 429
 *   rate limit;
 * - GitHub Pages (`server: GitHub.com`), before the cutover.
 * Anything else is enforced, so it fails unless the production Worker answered correctly: a
 * 503 without Worker headers (for example, Cloudflare error 1102, a Worker over its resource
 * limits), any other status, and no answer at all (a timeout, a detached Custom Domain, missing
 * DNS).
 */
export function notAnsweredByWorker(response: Response): NotTheWorker | null {
  const headers = response.headers
  if (headers.has(WORKER_VERSION_HEADER) || headers.has(SITE_ENVIRONMENT_HEADER)) return null
  const server = headers.get('server') ?? '(none)'
  const mitigated = headers.get('cf-mitigated')
  if (mitigated)
    return {
      githubPages: false,
      reason: `a Cloudflare ${mitigated} (cf-mitigated: ${mitigated}, status ${response.status})`
    }
  if (response.status === 403 || response.status === 429)
    return {
      githubPages: false,
      reason: `a ${response.status} without Worker headers (server: ${server}), zone protection`
    }
  if (server.trim().toLowerCase() === 'github.com')
    return {
      githubPages: true,
      reason: `GitHub Pages (server: ${server}, status ${response.status}), before the cutover`
    }
  return null
}

type GateAnswer<T> = { kind: 'answered'; value: T } | ({ kind: 'skipped' } & NotTheWorker)

type Attempt<T> =
  | GateAnswer<T>
  | { kind: 'failed'; error: unknown }
  | { kind: 'stale'; version: string }

/**
 * A gate request: bounded, and answered by the expected Worker version when one is known. An
 * answer from another version (an isolate still running the previous deployment) is retried
 * until the version budget runs out, then fails closed. With `skipNonWorker`, an answer
 * `notAnsweredByWorker` classifies (zone protection, GitHub Pages) comes back `skipped`; no
 * answer at all still fails.
 */
async function pinnedFetch<T>(
  target: GateTarget,
  url: URL,
  inspect: (response: Response) => Promise<T>,
  options: { request?: GateRequest; skipNonWorker?: boolean; smoke?: boolean } = {}
): Promise<GateAnswer<T>> {
  const pin = target.version
  for (let attempt = 1; ; attempt += 1) {
    let outcome: Attempt<T>
    try {
      outcome = await boundedRequest<Attempt<T>>(
        url,
        target.timeoutMs,
        async response => {
          const notWorker = options.skipNonWorker ? notAnsweredByWorker(response) : null
          if (notWorker) {
            await response.body?.cancel().catch(() => undefined)
            return { kind: 'skipped', ...notWorker }
          }
          const version = response.headers.get(WORKER_VERSION_HEADER)
          if (pin && version !== pin.expected) {
            await response.body?.cancel().catch(() => undefined)
            return { kind: 'stale', version: version ?? '(none)' }
          }
          try {
            return { kind: 'answered', value: await inspect(response) }
          } catch (error) {
            return { kind: 'failed', error }
          }
        },
        options.smoke ?? true,
        options.request
      )
    } catch (error) {
      // No answer is never skipped: zone protection answers, with a challenge or a block.
      if (!options.skipNonWorker) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${target.label ?? `${target.mode} route`} ${url.pathname}${url.search} got no answer (${message}).`
      )
    }
    if (outcome.kind === 'failed') throw outcome.error
    if (outcome.kind !== 'stale') return outcome
    if (!pin || pin.clock.now() + pin.intervalMs > pin.deadline)
      throw new Error(
        `${target.label ?? `${target.mode} route`} ${url.pathname}${url.search} was answered by Worker version ${outcome.version}, not the deployed ${pin?.expected}, on all ${attempt} attempt(s) before the ${(pin?.budgetMs ?? 0) / 1000} s version budget ran out.`
      )
    await pin.clock.sleep(pin.intervalMs)
  }
}

/** A gate request that must be answered (see `pinnedFetch`). */
async function boundedFetch<T>(
  target: GateTarget,
  url: URL,
  inspect: (response: Response) => Promise<T>,
  smoke = true,
  request?: GateRequest
): Promise<T> {
  const answer = await pinnedFetch(target, url, inspect, { request, smoke })
  if (answer.kind === 'skipped') throw new Error(`${url.href} was not answered: ${answer.reason}.`)
  return answer.value
}

/**
 * How to wait for a deployed Worker to be ready (`waitForWorkerReadiness`). Every field has a
 * default: three ready answers in a row, 2 s apart, each under 2 s, within 180 s.
 */
export interface ReadinessOptions {
  clock?: GateClock
  /** Ready answers needed in a row. */
  confirmations?: number
  intervalMs?: number
  /** Where each probe is logged; `console.info` by default. */
  log?: (line: string) => void
  /** A ready answer takes less than this. */
  maxLatencyMs?: number
  /** The bound on one probe (15 s by default), cut to the time left before the deadline. */
  timeoutMs?: number
  /** The whole wait (≤ 180 s). */
  waitMs?: number
}

const seconds = (milliseconds: number) => (milliseconds / 1000).toFixed(1)

/**
 * Waits until the Worker on `baseUrl` is ready: `confirmations` probes of `/robots.txt` in a
 * row (with the smoke-test header) answered 200 by `expectedVersion` in under `maxLatencyMs`,
 * within `waitMs`. Every probe's status, version and time is logged. Right after `wrangler
 * deploy` the edge can still run the previous version for a few seconds (Deploy Staging once
 * gated it about 4 s after the deploy), and fresh isolates load the Worker; and the staging
 * smoke stalled for minutes behind slow answers on some runners' paths to Cloudflare (#417).
 * So a slow answer is not ready either, and a wait that never sees one fails with the longest
 * ready run and the slowest answer rather than letting a suite time out behind it.
 */
export async function waitForWorkerReadiness(
  baseUrl: URL,
  expectedVersion: string,
  options: ReadinessOptions = {}
): Promise<{ probes: number }> {
  const waitMs = options.waitMs ?? maxReadinessWaitMs
  const intervalMs = options.intervalMs ?? defaultVersionPollIntervalMs
  const confirmations = options.confirmations ?? versionConfirmations
  const maxLatencyMs = options.maxLatencyMs ?? defaultReadyLatencyMs
  const clock = options.clock ?? realClock
  const log = options.log ?? ((line: string) => console.info(line))
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > maxReadinessWaitMs)
    throw new Error('Worker readiness wait must be a positive integer of at most 180 seconds.')
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new Error('Worker readiness needs a positive whole number of answers in a row.')
  if (!Number.isSafeInteger(maxLatencyMs) || maxLatencyMs < 1)
    throw new Error('Worker readiness latency must be a positive integer of milliseconds.')
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs
  const started = clock.now()
  const deadline = started + waitMs
  const probe = routeUrl(baseUrl, '/robots.txt')
  let inARow = 0
  let longestRun = 0
  let last = '(no probe)'
  let slowestMs = 0
  let probes = 0
  // The wait never outlasts its budget (#418 review): each probe gets only the time left before
  // the deadline, and an answer that lands after it doesn't count, however fast it was.
  while (deadline - clock.now() > 0) {
    probes += 1
    const sent = clock.now()
    const answer = await boundedRequest(
      probe,
      Math.min(timeoutMs, deadline - sent),
      async response => {
        await response.body?.cancel().catch(() => undefined)
        return {
          status: response.status,
          version: response.headers.get(WORKER_VERSION_HEADER) ?? '(none)'
        }
      }
    ).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error)
    }))
    const answered = clock.now()
    const latencyMs = answered - sent
    const late = answered > deadline
    slowestMs = Math.max(slowestMs, latencyMs)
    const ready =
      !late &&
      'status' in answer &&
      answer.status === 200 &&
      answer.version === expectedVersion &&
      latencyMs < maxLatencyMs
    inARow = ready ? inARow + 1 : 0
    longestRun = Math.max(longestRun, inARow)
    last = `${
      'status' in answer
        ? `${answer.status} from ${answer.version === expectedVersion ? 'the deployed version' : `version ${answer.version}`} in ${latencyMs} ms`
        : `no answer in ${latencyMs} ms (${answer.error})`
    }${late ? ' (after the deadline)' : ''}`
    log(
      `Readiness probe ${probes} at +${seconds(sent - started)} s: ${last}, ${ready ? `ready (${inARow}/${confirmations} in a row)` : 'not ready'}.`
    )
    if (inARow >= confirmations) {
      log(
        `Worker version ${expectedVersion} is ready on ${baseUrl.origin}: ${confirmations} answers in a row under ${maxLatencyMs} ms, after ${probes} probe(s) in ${seconds(clock.now() - started)} s (slowest ${slowestMs} ms).`
      )
      return { probes }
    }
    // A probe sent at the deadline would have no time left to answer.
    if (clock.now() + intervalMs >= deadline) break
    await clock.sleep(intervalMs)
  }
  throw new Error(
    `Worker version ${expectedVersion} was not ready on ${baseUrl.origin} within ${waitMs / 1000} s: ${longestRun} of the ${confirmations} answers in a row it needs (200 from that version in under ${maxLatencyMs} ms) over ${probes} probe(s); the last was ${last}, the slowest took ${slowestMs} ms. The previous deployment may still be serving, or this runner's path to Cloudflare is slow (docs/ci.md#staging-smoke-readiness).`
  )
}

/**
 * The version id of the last `deploy` entry in Wrangler's output file
 * (`WRANGLER_OUTPUT_FILE_PATH`, newline-delimited JSON).
 */
export function deployedWorkerVersion(ndjson: string, source = 'Wrangler output'): string {
  let version: string | undefined
  for (const line of ndjson.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      throw new Error(`${source} has a line that is not JSON.`)
    }
    const record = entry as { type?: unknown; version_id?: unknown }
    if (record.type === 'deploy' && typeof record.version_id === 'string')
      version = record.version_id
  }
  if (!version) throw new Error(`${source} has no Wrangler deploy entry with a version_id.`)
  if (!workerVersionPattern.test(version))
    throw new Error(`${source} names an invalid Worker version id.`)
  return version
}

/** The expected Worker version from the environment, or undefined when none is configured. */
export function expectedWorkerVersionFromEnvironment(
  env: Partial<NodeJS.ProcessEnv>
): string | undefined {
  const explicit = env.EXPECTED_WORKER_VERSION?.trim()
  if (explicit) {
    if (!workerVersionPattern.test(explicit))
      throw new Error('EXPECTED_WORKER_VERSION is not a Worker version id.')
    return explicit
  }
  const outputPath = env.WRANGLER_OUTPUT_FILE_PATH?.trim()
  if (!outputPath) return undefined
  let ndjson: string
  try {
    ndjson = readFileSync(resolve(outputPath), 'utf8')
  } catch {
    throw new Error(
      `WRANGLER_OUTPUT_FILE_PATH (${outputPath}) is unreadable; run the deploy with it set.`
    )
  }
  return deployedWorkerVersion(ndjson, `WRANGLER_OUTPUT_FILE_PATH (${outputPath})`)
}

async function requireNonemptyBody(response: Response, label: string): Promise<void> {
  if (!response.body) throw new Error(`${label} returned an empty body.`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let observed = 0
  try {
    while (observed < maxBodyProbeBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const bounded = value.subarray(0, maxBodyProbeBytes - observed)
      observed += bounded.byteLength
      if (decoder.decode(bounded, { stream: true }).trim()) return
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error(`${label} returned no content in its bounded body probe.`)
}

/**
 * Appended when a sample page (`httpGateSamples`) answers otherwise than expected: its likeliest
 * cause is an admin's change to that page (#405), not the deploy, and the fix is another sample.
 */
export const SAMPLE_FAILURE_HINT =
  'It is an HTTP gate sample (httpGateSamples in scripts/d1-preview-http-gates.ts): most likely it was renamed, retired or unpublished in /admin (#405). Name another page that is live on both staging and production there.'

/** A route's failure message, with `SAMPLE_FAILURE_HINT` for a sample page. */
function routeFailure(message: string, sample: boolean): Error {
  return new Error(sample ? `${message} ${SAMPLE_FAILURE_HINT}` : message)
}

async function expectRoute(
  target: GateTarget,
  path: string,
  { sample = false }: { sample?: boolean } = {}
): Promise<void> {
  await boundedFetch(target, routeUrl(target.baseUrl, path), async response => {
    if (response.status < 200 || response.status >= 300)
      throw routeFailure(`${target.mode} route ${path} returned ${response.status}.`, sample)
    await requireNonemptyBody(response, `${target.mode} route ${path}`)
  })
}

/**
 * The admin lock (serpcompany/best.serp.co#60, docs/accounts.md): an anonymous request for
 * `/admin/` or `/api/admin` must get exactly the answer the environment's checked-in vars
 * imply. Where Access is required (always in production; on staging with
 * `CF_ACCESS_REQUIRED=on`) that is 403 when the team domain and AUD tag are valid (the platform
 * host never carries an Access JWT) and 503 when they are not; without Access it is 401 (no
 * session). Any other answer, including a 503 from a production Worker whose Access vars are
 * set, means the lock is misconfigured and fails the deploy.
 */
export function expectedAdminLockStatus(vars: AccessEnv): 401 | 403 | 503 {
  if (!accessRequired(vars)) return 401
  return accessConfig(vars) ? 403 : 503
}

export interface AdminLockStatuses {
  production: 401 | 403 | 503
  staging: 401 | 403 | 503
}

/** The expected admin-lock answer of each deployed environment, from `wrangler.jsonc`. */
export function adminLockStatusesFromConfig(
  configPath: string = project.wranglerConfigPath
): AdminLockStatuses {
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as {
    env?: Record<'production' | 'staging', { vars?: Record<string, string> } | undefined>
  }
  return {
    production: expectedAdminLockStatus({
      ...config.env?.production?.vars,
      SITE_ENVIRONMENT: 'production'
    }),
    staging: expectedAdminLockStatus({ ...config.env?.staging?.vars, SITE_ENVIRONMENT: 'staging' })
  }
}

/** The answers an admin path may give on this target: exact for a known environment. */
export function allowedAdminLockStatuses(
  environment: string | null,
  statuses: AdminLockStatuses
): readonly number[] {
  if (environment === 'production') return [statuses.production]
  if (environment === 'staging') return [statuses.staging]
  return [401, 403, 503]
}

async function expectAdminLock(target: GateTarget, statuses: AdminLockStatuses): Promise<void> {
  const allowed = allowedAdminLockStatuses(expectedSiteEnvironment(target), statuses)
  for (const path of ['/admin/', '/api/admin']) {
    await boundedFetch(target, routeUrl(target.baseUrl, path), async response => {
      await response.body?.cancel().catch(() => undefined)
      if (!allowed.includes(response.status))
        throw new Error(
          `${target.mode} admin route ${path} returned ${response.status}, not ${allowed.join(' or ')}; the admin lock does not match wrangler.jsonc.`
        )
    })
  }
}

/**
 * Better Auth smoke tests (serp docs/engineering/standards/web-stack/better-auth.md,
 * Verification): the session endpoint answers 200 without a redirect, and a sign-in request
 * with bad input answers 4xx, never 3xx. The bad input is an empty email: the site's
 * send-code hook returns before its rate limits for it, so every run gets Better Auth's own
 * 400 `INVALID_EMAIL` (a fixed invalid address would be answered 200 once repeated runs use up
 * its per-address limit), and no code is ever sent. Exactly that answer is
 * required, so a CSRF 403, a 404, or a 429 can't pass for validation.
 */
async function expectAuthEndpoints(target: GateTarget): Promise<void> {
  const { baseUrl, mode } = target
  await boundedFetch(target, routeUrl(baseUrl, '/api/auth/get-session'), async response => {
    await response.body?.cancel().catch(() => undefined)
    if (response.status !== 200)
      throw new Error(`${mode} GET /api/auth/get-session returned ${response.status}, not 200.`)
  })
  const origin = trustedAuthOrigin(target)
  await boundedFetch(
    target,
    routeUrl(baseUrl, '/api/auth/email-otp/send-verification-otp'),
    async response => {
      const text = await response.text()
      let code: unknown
      try {
        code = (JSON.parse(text) as { code?: unknown }).code
      } catch {
        code = undefined
      }
      if (response.status !== 400 || code !== 'INVALID_EMAIL')
        throw new Error(
          `${mode} sign-in POST with an empty email returned ${[response.status, code].filter(Boolean).join(' ')}, not 400 INVALID_EMAIL.`
        )
    },
    true,
    {
      body: JSON.stringify({ email: '', type: 'sign-in' }),
      headers: { 'content-type': 'application/json', origin },
      method: 'POST'
    }
  )
}

/**
 * The origin the bad sign-in comes from: the canonical host Better Auth trusts when the gates go
 * through a platform host for it (best.serp.co for production, staging.best.serp.co for staging's
 * platform host, #323), else the gated origin itself.
 */
function trustedAuthOrigin({ baseUrl, mode }: GateTarget): string {
  if (mode === 'production') return canonicalOrigin.origin
  if (mode === 'staging' && baseUrl.origin === stagingPlatformOrigin.origin)
    return stagingCanonicalOrigin.origin
  return baseUrl.origin
}

/** `path` answers exactly one 308 to `expectedPath` on the same origin, query string included. */
async function expectPermanentRedirect(
  target: GateTarget,
  path: string,
  expectedPath: string,
  { sample = false }: { sample?: boolean } = {}
): Promise<void> {
  const { baseUrl, mode } = target
  await boundedFetch(target, routeUrl(baseUrl, path), async response => {
    await response.body?.cancel().catch(() => undefined)
    const location = response.headers.get('location')
    const observed = location ? new URL(location, baseUrl) : undefined
    const expected = routeUrl(baseUrl, expectedPath)
    if (response.status !== 308 || observed?.href !== expected.href)
      throw routeFailure(
        `${mode} route ${path} returned ${response.status} ${location ?? ''}, not a 308 to ${expectedPath}.`,
        sample
      )
  })
}

/**
 * URL trailing-slash standard (serp docs/engineering/standards/url-trailing-slash.md): a page
 * URL without its slash and a file URL with one answer exactly one 308 to the canonical form,
 * and /api is served as requested.
 */
async function expectTrailingSlashPolicy(target: GateTarget, searchQuery: string): Promise<void> {
  await Promise.all([
    expectPermanentRedirect(target, '/about', '/about/'),
    expectPermanentRedirect(target, '/robots.txt/', '/robots.txt'),
    expectRoute(target, `/api/search/?q=${encodeURIComponent(searchQuery)}`)
  ])
}

/**
 * Awaits the route contracts with the trailing-slash checks running alongside them; a route
 * contract failure is reported first.
 */
async function withTrailingSlashPolicy(
  target: GateTarget,
  searchQuery: string,
  routeContracts: Promise<void>[]
): Promise<void> {
  const trailingSlash = expectTrailingSlashPolicy(target, searchQuery)
  trailingSlash.catch(() => undefined)
  await Promise.all(routeContracts)
  await trailingSlash
}

async function expectLegacyRedirect(
  target: GateTarget,
  legacyPath: string,
  expectedPath: string
): Promise<void> {
  const { baseUrl, mode } = target
  await boundedFetch(target, routeUrl(baseUrl, legacyPath), async response => {
    if (![301, 302, 303, 307, 308].includes(response.status))
      throw new Error(
        `${mode} legacy route ${legacyPath} returned ${response.status}, not a redirect.`
      )
    await response.body?.cancel().catch(() => undefined)
    const location = response.headers.get('location')
    const expected = routeUrl(baseUrl, expectedPath)
    const observed = location ? new URL(location, baseUrl) : undefined
    if (
      !observed ||
      observed.origin !== expected.origin ||
      observed.pathname !== expected.pathname ||
      observed.search !== expected.search ||
      observed.hash !== expected.hash ||
      observed.username ||
      observed.password
    )
      throw new Error(`${mode} legacy route ${legacyPath} did not redirect to ${expectedPath}.`)
  })
}

async function readBoundedText(
  response: Response,
  label: string,
  options: { maxBytes?: number; stopAt?: RegExp } = {}
): Promise<string> {
  if (!response.body) throw new Error(`${label} returned an empty body.`)
  const maxBytes = options.maxBytes ?? maxTextProbeBytes
  const stopAt = options.stopAt ?? /<\/head>/iu
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let observed = 0
  let text = ''
  try {
    while (observed < maxBytes && !stopAt.test(text)) {
      const { done, value } = await reader.read()
      if (done) break
      const bounded = value.subarray(0, maxBytes - observed)
      observed += bounded.byteLength
      text += decoder.decode(bounded, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text + decoder.decode()
}

/**
 * The document up to its Google Tag Manager reference (the `<noscript>` frame right after
 * `<body>`), or all of it (bounded) when there is none, so the `<head>` is always included.
 */
async function readDocument(
  response: Response,
  label: string
): Promise<{ head: string; loadsGoogleTagManager: boolean; loadsWebAnalytics: boolean }> {
  const document = await readBoundedText(response, label, {
    maxBytes: maxDocumentProbeBytes,
    stopAt: /googletagmanager\.com/iu
  })
  return {
    head: document,
    loadsGoogleTagManager: document.toLowerCase().includes(googleTagManagerMarker),
    // Read in full whenever Google Tag Manager is absent, so the beacon before `</body>` is seen.
    loadsWebAnalytics: document.toLowerCase().includes(webAnalyticsMarker)
  }
}

/** The `SITE_ENVIRONMENT` a deployment must report, or null when the origin does not say. */
function expectedSiteEnvironment(target: GateTarget): string | null {
  if (target.mode === 'production') return 'production'
  if (target.baseUrl.origin === productionPlatformOrigin.origin) return 'production'
  if (target.baseUrl.origin === stagingPlatformOrigin.origin) return 'staging'
  return null
}

/**
 * Crawl and analytics policy of a workers.dev origin, which is never the public site (serp
 * standards/environment-configuration.md): `X-Robots-Tag` noindex on `/`, robots.txt and the
 * sitemap index; robots.txt disallows Google and `*`; no Google Tag Manager. The Worker also
 * reports the `SITE_ENVIRONMENT` it was deployed with, which proves through this host that the
 * production Worker would serve best.serp.co as production.
 *
 * Page markup does not depend on the host, so `/` and a listing page must also carry no robots
 * meta noindex here: that keeps a page-level noindex out of best.serp.co even when every
 * best.serp.co probe meets zone protection.
 */
async function expectNonProductionPolicy(target: GateTarget, listingPath: string): Promise<void> {
  const { baseUrl, mode } = target
  const environment = expectedSiteEnvironment(target)
  for (const path of ['/', '/sitemap-index.xml', '/robots.txt']) {
    await boundedFetch(target, routeUrl(baseUrl, path), async response => {
      if (!xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag'))) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`${mode} route ${path} sent no noindex in its X-Robots-Tag header.`)
      }
      const reported = response.headers.get(SITE_ENVIRONMENT_HEADER)
      if (path === '/' && environment && reported !== environment) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(
          `${mode} Worker at ${baseUrl.origin} reports SITE_ENVIRONMENT ${reported ?? '(none)'}, not ${environment}.`
        )
      }
      if (path === '/') {
        const document = await readDocument(response, `${mode} route /`)
        if (document.loadsGoogleTagManager)
          throw new Error(`${mode} route / loads Google Tag Manager.`)
        if (document.loadsWebAnalytics)
          throw new Error(`${mode} route / loads the Cloudflare Web Analytics beacon.`)
        if (metaRobotsBlocksIndexing(document.head))
          throw new Error(`${mode} route / sent noindex in its robots meta, on every host.`)
      }
      if (path === '/robots.txt') {
        const groups = parseRobotsTxt(await readBoundedText(response, `${mode} robots.txt`))
        const crawlable = ['*', 'googlebot'].find(agent => robotsTxtAllows(groups, agent, '/'))
        if (crawlable) throw new Error(`${mode} robots.txt lets user-agent ${crawlable} crawl /.`)
      }
      await response.body?.cancel().catch(() => undefined)
    })
  }
  await boundedFetch(target, routeUrl(baseUrl, listingPath), async response => {
    if (metaRobotsBlocksIndexing(await readBoundedText(response, `${mode} route ${listingPath}`)))
      throw new Error(
        `${mode} route ${listingPath} sent noindex in its robots meta, on every host.`
      )
  })
}

/** Whether the checked-in config turns an environment's canonical-host redirect on. */
export function canonicalHostRedirectConfigured(
  configPath: string = project.wranglerConfigPath,
  environment: RemoteEnvironment = 'production'
): boolean {
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as {
    env?: Partial<Record<RemoteEnvironment, { vars?: Record<string, string | undefined> }>>
  }
  const value = config.env?.[environment]?.vars?.CANONICAL_HOST_REDIRECT
  if (value !== 'on' && value !== 'off')
    throw new Error(
      `${configPath} env.${environment}.vars.CANONICAL_HOST_REDIRECT must be on or off.`
    )
  return value === 'on'
}

/**
 * The canonical origin the gated platform host must answer with one 308 without the smoke-test
 * header, or null when it must serve the request: best.serp.co for production with its
 * checked-in switch on, staging.best.serp.co for staging's platform host with staging's switch
 * on (#323). Any other staging origin, such as the production platform host before the cutover,
 * must not redirect.
 */
export function canonicalHostRedirectTarget(
  mode: HttpGateMode,
  gated: URL,
  configPath?: string
): URL | null {
  if (mode === 'production')
    return canonicalHostRedirectConfigured(configPath) ? canonicalOrigin : null
  if (mode === 'staging' && gated.origin === stagingPlatformOrigin.origin)
    return canonicalHostRedirectConfigured(configPath, 'staging') ? stagingCanonicalOrigin : null
  return null
}

/**
 * The host redirect, checked with the one request that omits the smoke-test header. With a
 * `redirectTo` origin (`canonicalHostRedirectTarget`), `/about?gate=canonical-host` answers one
 * 308 to the same canonical URL there; the canonical host itself is not requested. Otherwise
 * `/` is served (an origin without the switch, and the production workers.dev origin before
 * the switch is on, must not redirect). Like every gate request, an answer from the previous
 * Worker version is retried within the version budget.
 */
async function expectHostRedirectPolicy(target: GateTarget, redirectTo: URL | null): Promise<void> {
  const { baseUrl, mode } = target
  if (!redirectTo) {
    await boundedFetch(
      target,
      routeUrl(baseUrl, '/'),
      async response => {
        await response.body?.cancel().catch(() => undefined)
        if (response.status !== 200)
          throw new Error(
            `${mode} route / without the smoke-test header returned ${response.status} ${response.headers.get('location') ?? ''}; this origin must not redirect.`
          )
      },
      false
    )
    return
  }
  await boundedFetch(
    target,
    routeUrl(baseUrl, '/about?gate=canonical-host'),
    async response => {
      await response.body?.cancel().catch(() => undefined)
      const expected = `${redirectTo.origin}/about/?gate=canonical-host`
      const location = response.headers.get('location')
      if (response.status !== 308 || location !== expected)
        throw new Error(
          `${mode} platform host ${baseUrl.host}/about without the smoke-test header returned ${response.status} ${location ?? ''}, not a 308 to ${expected}.`
        )
    },
    false
  )
}

/**
 * best.serp.co's public policy (#44, E-4), requested on best.serp.co itself without the
 * smoke-test header, as visitors and crawlers see it: answered by the production Worker
 * (`x-site-environment: production`); no noindex on `/`, robots.txt or the sitemap index;
 * robots.txt lets Google and `*` crawl and lists the sitemap index; Google Tag Manager loads;
 * and no answer asks for a password (`WWW-Authenticate`: only staging has one, #359). A noindex
 * reaching best.serp.co would deindex the site.
 *
 * Every answer from the Worker is enforced. With `skipNonWorker` (production gates), zone
 * protection and GitHub Pages (`notAnsweredByWorker`) are skipped with a `::warning::`, so
 * `serp.co` zone protection never fails a deploy; GitHub Pages still fails it while
 * `CANONICAL_HOST_REDIRECT` is on, since the workers.dev host would then send visitors there.
 * Without it (`public` mode, run by hand), every check must pass.
 */
async function expectPublicPolicy(
  target: GateTarget,
  contentPath: string,
  options: { redirectOn: boolean; skipNonWorker: boolean }
): Promise<void> {
  const site: GateTarget = { ...target, baseUrl: canonicalOrigin, label: 'best.serp.co route' }
  const check = async (path: string, inspect: (response: Response) => Promise<void>) => {
    const answer = await pinnedFetch(
      site,
      routeUrl(canonicalOrigin, path),
      async response => {
        const environment = response.headers.get(SITE_ENVIRONMENT_HEADER)
        if (environment !== 'production') {
          await response.body?.cancel().catch(() => undefined)
          const mitigated = response.headers.get('cf-mitigated')
          throw new Error(
            `best.serp.co route ${path} was not answered by the production Worker (x-site-environment ${environment ?? '(none)'}, status ${response.status}, server ${response.headers.get('server') ?? '(none)'}${mitigated ? `, cf-mitigated ${mitigated}` : ''}).`
          )
        }
        if (response.headers.has('www-authenticate')) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`best.serp.co route ${path} asked for a password (WWW-Authenticate).`)
        }
        await inspect(response)
      },
      { skipNonWorker: options.skipNonWorker, smoke: false }
    )
    if (answer.kind === 'answered') return
    if (options.redirectOn && answer.githubPages)
      throw new Error(
        `CANONICAL_HOST_REDIRECT is on, but best.serp.co${path} is still ${answer.reason}: the production workers.dev host would send visitors there. Finish the cutover or turn the switch off.`
      )
    console.log(
      `::warning title=best.serp.co check skipped::best.serp.co${path} was not answered by the Worker but by ${answer.reason}; its crawl and analytics check was skipped. Check it by hand (docs/deploy-runbook.md#after-a-deploy).`
    )
  }
  await check('/', async response => {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`best.serp.co route / returned ${response.status}.`)
    }
    const header = xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag'))
    const document = await readDocument(response, 'best.serp.co route /')
    if (header || metaRobotsBlocksIndexing(document.head))
      throw new Error(
        `best.serp.co route / sent noindex in its ${header ? 'X-Robots-Tag header' : 'robots meta'}.`
      )
    if (!document.loadsGoogleTagManager)
      throw new Error('best.serp.co route / does not load Google Tag Manager.')
  })
  const sitemapIndex = routeUrl(canonicalOrigin, '/sitemap-index.xml')
  await check('/sitemap-index.xml', async response => {
    await response.body?.cancel().catch(() => undefined)
    if (xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag')))
      throw new Error('best.serp.co route /sitemap-index.xml sent X-Robots-Tag noindex.')
  })
  await check('/robots.txt', async response => {
    if (response.status !== 200)
      throw new Error(`best.serp.co route /robots.txt returned ${response.status}.`)
    if (xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag')))
      throw new Error('best.serp.co route /robots.txt sent X-Robots-Tag noindex.')
    const robots = await readBoundedText(response, 'best.serp.co route /robots.txt')
    const listsSitemapIndex = robots
      .split(/\r?\n/u)
      .some(line => /^\s*sitemap\s*:\s*(\S+)\s*$/iu.exec(line)?.[1] === sitemapIndex.href)
    if (!listsSitemapIndex)
      throw new Error(`best.serp.co robots.txt does not list "Sitemap: ${sitemapIndex.href}".`)
    const blocked = robotsTxtBlockedPath(robots, ['/', contentPath])
    if (blocked)
      throw new Error(
        `best.serp.co robots.txt blocks ${blocked.path} for user-agent ${blocked.agent}.`
      )
  })
}

/**
 * The origin the gates request: production always goes through its platform host, and staging
 * given its canonical host goes through its own (#323).
 */
export function gateOrigin(mode: HttpGateMode, baseUrl: URL): URL {
  if (mode === 'production') return productionPlatformOrigin
  if (mode === 'staging' && baseUrl.origin === stagingCanonicalOrigin.origin)
    return stagingPlatformOrigin
  return baseUrl
}

export async function runHttpGates(
  modeValue: string,
  baseUrlValue: string,
  options: HttpGateOptions = {}
): Promise<void> {
  const mode = parseMode(modeValue)
  const baseUrl = gateOrigin(mode, validateBaseUrl(mode, baseUrlValue))
  const samples = options.samples ?? httpGateSamples
  const listingSlug = samples.listing
  const { bestPage, category, movedCategory, tag } = liveSamples(
    samples,
    taxonomyChanges(options.publicationsDirectory ?? 'd1/publications')
  )
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultRequestTimeoutMs)
    throw new Error('HTTP gate timeout must be a positive integer within the protected bound.')
  if (options.expectedVersion !== undefined && !workerVersionPattern.test(options.expectedVersion))
    throw new Error('The expected Worker version is not a Worker version id.')
  const redirectTo = canonicalHostRedirectTarget(mode, baseUrl, options.wranglerConfigPath)
  const target: GateTarget = { baseUrl, mode, timeoutMs }
  if (options.expectedVersion) {
    const clock = options.clock ?? realClock
    const intervalMs = options.versionPollIntervalMs ?? defaultVersionPollIntervalMs
    const budgetMs = options.versionWaitMs ?? maxVersionWaitMs
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > maxVersionWaitMs)
      throw new Error('Worker version budget must be a positive integer of at most 60 seconds.')
    await waitForWorkerReadiness(baseUrl, options.expectedVersion, {
      clock,
      intervalMs,
      log: options.log,
      timeoutMs,
      waitMs: options.readinessWaitMs
    })
    target.version = {
      budgetMs,
      clock,
      deadline: clock.now() + budgetMs,
      expected: options.expectedVersion,
      intervalMs
    }
  }
  if (mode === 'public') {
    await expectPublicPolicy(target, listingRoute(listingSlug), {
      redirectOn: false,
      skipNonWorker: false
    })
    return
  }
  await withTrailingSlashPolicy(target, listingSlug, [
    expectRoute(target, '/'),
    // The samples: fixed pages, so a routing regression on a known page fails the deploy.
    expectRoute(target, categoryRoute(category), { sample: true }),
    expectRoute(target, tagRoute(tag), { sample: true }),
    expectRoute(target, bestRoute(bestPage), { sample: true }),
    expectPermanentRedirect(
      target,
      categoryRoute(movedCategory.category),
      movedTargetRoute(movedCategory.to),
      { sample: true }
    ),
    expectRoute(target, listingRoute(listingSlug), { sample: true }),
    expectRoute(target, `/api/search?q=${encodeURIComponent(listingSlug)}`),
    expectRoute(target, '/rss.xml'),
    expectRoute(target, '/sitemap-index.xml'),
    expectLegacyRedirect(target, `/${listingSlug}/`, listingRoute(listingSlug)),
    expectRoute(target, '/submit/'),
    expectAdminLock(target, adminLockStatusesFromConfig(options.wranglerConfigPath)),
    expectAuthEndpoints(target)
  ])
  await expectNonProductionPolicy(target, listingRoute(listingSlug))
  await expectHostRedirectPolicy(target, redirectTo)
  if (mode === 'production')
    await expectPublicPolicy(target, listingRoute(listingSlug), {
      redirectOn: redirectTo !== null,
      skipNonWorker: true
    })
}

/**
 * The live pages the gates request on a deployed Worker. They are real catalog rows, because the
 * gates run against staging's and production's data.
 * - The listing is the v1 import's first one (#315).
 * - The category is that listing's own, `video-downloaders`, with 63 live listings on staging
 *   and production on 2026-10-10 (#320). An empty category answers 404, so the gates no longer
 *   sample `ai-advertising-tools`, which one unpublish would have emptied; and while the listing
 *   the gates already require is filed under this one, it can't be empty.
 * - The taxonomy's samples (#341 design 4.5, #350), live on both environments since its
 *   publication (2026-10-11): the `ai-chatbots` tag (171 listings on 2026-10-12), the
 *   `ai-chatbot` best page ranking it, and `ai-copywriting`, a narrow category the taxonomy
 *   retired, whose URL answers one 308 to its best page.
 *
 * A committed manifest that unpublishes or renames the listing, takes the category off it,
 * retires every sample category, tag or best page, or moves every moved category elsewhere fails
 * `d1-preview-http-gates.test.ts`; name another live one then. An admin's rename or retirement
 * in `/admin` (#405) is no manifest: the next deploy's gates fail on it instead, with
 * `SAMPLE_FAILURE_HINT`, so `docs/urls.md` asks admins not to change these pages before a merged
 * PR moves the samples.
 */
export interface HttpGateSamples {
  /** Best pages, in order of preference: the first one no reviewed manifest retires. */
  bestPages: readonly string[]
  /** In order of preference: the gates request the first one no reviewed manifest retires. */
  categories: readonly string[]
  listing: string
  /** Retired categories' URLs and their 308s, in order of preference (`liveSamples`). */
  movedCategories: readonly MovedCategorySample[]
  /** Tags, in order of preference: the first one no reviewed manifest retires. */
  tags: readonly string[]
}

/** A retired category whose URL answers one 308 to the tag or best page that took it over. */
export interface MovedCategorySample {
  category: string
  to: { kind: 'best' | 'tag'; slug: string }
}

export const httpGateSamples: HttpGateSamples = {
  bestPages: ['ai-chatbot'],
  categories: ['video-downloaders'],
  listing: '123movies-downloader',
  movedCategories: [{ category: 'ai-copywriting', to: { kind: 'best', slug: 'ai-copywriting' } }],
  tags: ['ai-chatbots']
}

/** The page a moved category's 308 names. */
function movedTargetRoute(target: MovedCategorySample['to']): string {
  return target.kind === 'best' ? bestRoute(target.slug) : tagRoute(target.slug)
}

/** A taxonomy redirect target as manifests write it, as one comparable key. */
function redirectTargetKey(target: { kind?: unknown; slug?: unknown }): string {
  return `${String(target.kind)}:${typeof target.slug === 'string' ? target.slug : ''}`
}

/**
 * What the reviewed manifests do to taxonomy pages the gates could sample. Read in no particular
 * order, so it is conservative: a page any manifest retires is never sampled, even one a later
 * manifest might bring back.
 */
export interface TaxonomyChanges {
  /** Best pages a manifest retires (`best-page-unpublish`). */
  retiredBestPages: Set<string>
  /** Categories a manifest retires (`category-unpublish`, #260: Adult, the import's first one). */
  retiredCategories: Set<string>
  /** Tags a manifest retires (`tag-unpublish`). */
  retiredTags: Set<string>
  /** Categories a manifest makes active again (`category-update`), whose pages may render. */
  updatedCategories: Set<string>
  /** Every target a manifest points each category URL at (`taxonomy-redirect-set`). */
  categoryRedirects: Map<string, Set<string>>
}

interface ManifestOperation {
  action?: unknown
  category?: { slug?: unknown }
  from?: { kind?: unknown; slug?: unknown }
  slug?: unknown
  to?: { kind?: unknown; slug?: unknown }
}

/** The manifest operations that retire or move a page the gates could sample (`taxonomyChanges`). */
export const SAMPLE_CHANGING_ACTIONS: readonly string[] = [
  'best-page-unpublish',
  'category-unpublish',
  'category-update',
  'tag-unpublish',
  'taxonomy-redirect-set'
]

/**
 * Whether a manifest's text may hold one of `actions`: one that never names an action can't hold
 * it, so it needn't be parsed. That skips the large listing batches (most of `d1/publications`'
 * 5 MB of YAML), which hold none of the operations the gates read.
 */
export function manifestMayHold(text: string, actions: readonly string[]): boolean {
  return actions.some(action => text.includes(action))
}

/** What these parsed manifests do to the pages the gates could sample (`taxonomyChanges`). */
export function taxonomyChangesOf(manifests: readonly unknown[]): TaxonomyChanges {
  const changes: TaxonomyChanges = {
    categoryRedirects: new Map(),
    retiredBestPages: new Set(),
    retiredCategories: new Set(),
    retiredTags: new Set(),
    updatedCategories: new Set()
  }
  const retiring = new Map([
    ['best-page-unpublish', changes.retiredBestPages],
    ['category-unpublish', changes.retiredCategories],
    ['tag-unpublish', changes.retiredTags]
  ])
  for (const manifest of manifests as Array<{ operations?: ManifestOperation[] } | null>) {
    for (const operation of manifest?.operations ?? []) {
      const action = String(operation.action)
      if (typeof operation.slug === 'string') retiring.get(action)?.add(operation.slug)
      if (action === 'category-update' && typeof operation.category?.slug === 'string')
        changes.updatedCategories.add(operation.category.slug)
      const from = operation.from
      if (
        action === 'taxonomy-redirect-set' &&
        from?.kind === 'category' &&
        typeof from.slug === 'string' &&
        operation.to
      ) {
        const targets = changes.categoryRedirects.get(from.slug) ?? new Set<string>()
        targets.add(redirectTargetKey(operation.to))
        changes.categoryRedirects.set(from.slug, targets)
      }
    }
  }
  return changes
}

/**
 * Reads the reviewed manifests for the pages they retire or move (#260, #350). A retired page
 * answers 404 or a 308 once its manifest is published, so the gates sample the first page no
 * manifest retires, which answers the same before and after. Only manifests that name one of
 * `SAMPLE_CHANGING_ACTIONS` are parsed (`manifestMayHold`).
 */
export function taxonomyChanges(directory: string): TaxonomyChanges {
  const manifests: unknown[] = []
  for (const file of readdirSync(resolve(directory)).filter(name => /\.ya?ml$/u.test(name))) {
    const text = readFileSync(resolve(directory, file), 'utf8')
    if (manifestMayHold(text, SAMPLE_CHANGING_ACTIONS)) manifests.push(parse(text))
  }
  return taxonomyChangesOf(manifests)
}

/**
 * Whether a moved category still answers its 308 after every reviewed manifest: no manifest
 * points its URL anywhere else, makes it active again, or retires its target (which re-points
 * the redirects aimed at it).
 */
function movedCategoryHolds(moved: MovedCategorySample, changes: TaxonomyChanges): boolean {
  const target = redirectTargetKey(moved.to)
  const retiredTargets = moved.to.kind === 'best' ? changes.retiredBestPages : changes.retiredTags
  return (
    !changes.updatedCategories.has(moved.category) &&
    !retiredTargets.has(moved.to.slug) &&
    [...(changes.categoryRedirects.get(moved.category) ?? [])].every(key => key === target)
  )
}

/** The first sample of each kind the reviewed manifests leave live (`taxonomyChanges`). */
export function liveSamples(
  samples: HttpGateSamples,
  changes: TaxonomyChanges
): { bestPage: string; category: string; movedCategory: MovedCategorySample; tag: string } {
  const first = <T>(kind: string, candidates: readonly T[], live: (candidate: T) => boolean) => {
    const found = candidates.find(live)
    if (found === undefined)
      throw new Error(
        `Reviewed manifests retire or move every HTTP gate sample ${kind}; add a live one to httpGateSamples.`
      )
    return found
  }
  return {
    bestPage: first('best page', samples.bestPages, slug => !changes.retiredBestPages.has(slug)),
    category: first('category', samples.categories, slug => !changes.retiredCategories.has(slug)),
    movedCategory: first('moved category', samples.movedCategories, moved =>
      movedCategoryHolds(moved, changes)
    ),
    tag: first('tag', samples.tags, slug => !changes.retiredTags.has(slug))
  }
}

export async function runStagingHttpGates(baseUrlValue: string): Promise<void> {
  return runHttpGates('staging', baseUrlValue)
}

async function main(): Promise<void> {
  const [modeValue, baseUrlValue, output] = process.argv.slice(2)
  if (!modeValue || !baseUrlValue)
    throw new Error(
      'Usage: d1-preview-http-gates.ts <staging|production|public> <clean-https-origin> [output]'
    )
  const expectedVersion = expectedWorkerVersionFromEnvironment(process.env)
  if (!expectedVersion)
    console.info(
      'No expected Worker version (EXPECTED_WORKER_VERSION or WRANGLER_OUTPUT_FILE_PATH): gating whichever version answers.'
    )
  if (modeValue === 'production')
    console.info(
      `Gating the production Worker through ${productionPlatformOrigin.origin} with the smoke-test header, then best.serp.co's crawl and analytics policy (enforced when the Worker answers; zone challenges are skipped with a warning).`
    )
  await runHttpGates(modeValue, baseUrlValue, { expectedVersion })
  if (output)
    writeFileSync(
      resolve(output),
      `${JSON.stringify({ home: true, category: true, tag: true, bestPage: true, movedCategory: true, detail: true, search: true, rss: true, sitemap: true, legacyRedirect: true, submit: true, workerVersion: expectedVersion ?? null })}\n`
    )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
