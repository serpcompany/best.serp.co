/**
 * Post-deploy HTTP gates for the staging and production Workers.
 *
 *   pnpm tsx scripts/d1-preview-http-gates.ts <staging|production> <clean-https-origin> [output]
 *
 * Every request sends the smoke-test header, so the production Worker's `*.workers.dev` host
 * answers it instead of redirecting to best.serp.co (#42 decision e).
 *
 * When the deploy's Worker version is known, the gates first wait (at most 60 s) until that
 * version answers, then require it on every response, so they never pass or fail against the
 * previous deployment while the edge still serves it. The version comes from
 * `EXPECTED_WORKER_VERSION`, or from the `deploy` entry Wrangler writes to
 * `WRANGLER_OUTPUT_FILE_PATH` when the deploy step ran with that variable set.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  SMOKE_TEST_HEADER,
  WORKER_VERSION_HEADER
} from '../apps/web/lib/environment/site-environment'
import {
  metaRobotsBlocksIndexing,
  parseRobotsTxt,
  robotsTxtAllows,
  robotsTxtBlockedPath,
  xRobotsTagBlocksIndexing
} from './crawl-policy'
import { project } from './project'
import { categoryRoute, listingRoute } from './site-routes'

export type HttpGateMode = 'staging' | 'production'
const defaultRequestTimeoutMs = 15_000
const maxVersionWaitMs = 60_000
const defaultVersionPollIntervalMs = 2_000
/** Consecutive probes the expected version must answer before the gates start. */
const versionConfirmations = 3
const maxBodyProbeBytes = 4_096
// Enough for robots.txt and for the <head> of the home page (its robots meta sits near 6 KB).
const maxTextProbeBytes = 131_072
// The whole home page (about 570 KB): Google Tag Manager's <noscript> follows <body>, and its
// script is in the payload near the end.
const maxDocumentProbeBytes = 4 * 1_048_576
const googleTagManagerMarker = 'googletagmanager.com'
const workerVersionPattern = /^[A-Za-z0-9-]{1,64}$/u

export interface HttpGateOptions {
  /** The deployed Worker version; gates wait for it and require it on every response. */
  expectedVersion?: string
  parityReportPath?: string
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
  versionPollIntervalMs?: number
  /** Bound on waiting for `expectedVersion` (at most 60 s). */
  versionWaitMs?: number
  /** Wrangler config whose production `CANONICAL_HOST_REDIRECT` decides the host-redirect gate. */
  wranglerConfigPath?: string
}

interface GateTarget {
  baseUrl: URL
  expectedVersion?: string
  mode: HttpGateMode
  timeoutMs: number
}

function parseMode(value: string): HttpGateMode {
  if (value === 'staging' || value === 'production') return value
  throw new Error('HTTP gate mode must be exactly staging or production.')
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
  if (mode === 'production' && baseUrl.hostname !== project.domain)
    throw new Error(`Production gates require the exact https://${project.domain} origin.`)
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

async function boundedRequest<T>(
  url: URL,
  timeoutMs: number,
  inspect: (response: Response) => Promise<T>,
  smoke = true
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
        headers: smoke ? { [SMOKE_TEST_HEADER]: '1' } : {},
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

/** A gate request: bounded, and answered by the expected Worker version when one is known. */
function boundedFetch<T>(
  target: GateTarget,
  url: URL,
  inspect: (response: Response) => Promise<T>,
  smoke = true
): Promise<T> {
  return boundedRequest(
    url,
    target.timeoutMs,
    async response => {
      const version = response.headers.get(WORKER_VERSION_HEADER)
      if (target.expectedVersion && version !== target.expectedVersion) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(
          `${target.mode} route ${url.pathname}${url.search} was answered by Worker version ${version ?? '(none)'}, not the deployed ${target.expectedVersion}.`
        )
      }
      return inspect(response)
    },
    smoke
  )
}

const realSleep = (milliseconds: number) =>
  new Promise<void>(done => {
    setTimeout(done, milliseconds)
  })

/**
 * Waits until `expectedVersion` answers `versionConfirmations` probes in a row, for at most
 * `waitMs`. Right after `wrangler deploy` the edge can still run the previous version for a
 * few seconds (Deploy Staging once gated it about 4 s after the deploy).
 */
export async function waitForWorkerVersion(
  baseUrl: URL,
  expectedVersion: string,
  options: {
    intervalMs?: number
    sleep?: (milliseconds: number) => Promise<void>
    timeoutMs?: number
    waitMs?: number
  } = {}
): Promise<number> {
  const waitMs = options.waitMs ?? maxVersionWaitMs
  const intervalMs = options.intervalMs ?? defaultVersionPollIntervalMs
  const sleep = options.sleep ?? realSleep
  const timeoutMs = Math.min(options.timeoutMs ?? defaultRequestTimeoutMs, waitMs)
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > maxVersionWaitMs)
    throw new Error('Worker version wait must be a positive integer of at most 60 seconds.')
  const probe = routeUrl(baseUrl, '/robots.txt')
  let elapsed = 0
  let confirmed = 0
  let observed = '(no answer)'
  let probes = 0
  while (true) {
    probes += 1
    const started = Date.now()
    observed = await boundedRequest(probe, timeoutMs, async response => {
      await response.body?.cancel().catch(() => undefined)
      return response.headers.get(WORKER_VERSION_HEADER) ?? '(none)'
    }).catch((error: unknown) => `(${error instanceof Error ? error.message : String(error)})`)
    confirmed = observed === expectedVersion ? confirmed + 1 : 0
    if (confirmed >= versionConfirmations) return probes
    elapsed += Math.max(Date.now() - started, 0) + intervalMs
    if (elapsed > waitMs) break
    await sleep(intervalMs)
  }
  throw new Error(
    `Worker version ${expectedVersion} did not answer ${baseUrl.origin} within ${waitMs / 1000} s (last answer: ${observed}); the previous deployment may still be serving.`
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
export function expectedWorkerVersionFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
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

async function expectRoute(target: GateTarget, path: string): Promise<void> {
  await boundedFetch(target, routeUrl(target.baseUrl, path), async response => {
    if (response.status < 200 || response.status >= 300)
      throw new Error(`${target.mode} route ${path} returned ${response.status}.`)
    await requireNonemptyBody(response, `${target.mode} route ${path}`)
  })
}

/**
 * URL trailing-slash standard (serp docs/engineering/standards/url-trailing-slash.md): a page
 * URL without its slash and a file URL with one answer exactly one 308 to the canonical form,
 * and /api is served as requested.
 */
async function expectTrailingSlashPolicy(target: GateTarget, searchQuery: string): Promise<void> {
  const { baseUrl, mode } = target
  const expectPermanentRedirect = (path: string, expectedPath: string) =>
    boundedFetch(target, routeUrl(baseUrl, path), async response => {
      await response.body?.cancel().catch(() => undefined)
      const location = response.headers.get('location')
      const observed = location ? new URL(location, baseUrl) : undefined
      const expected = routeUrl(baseUrl, expectedPath)
      if (response.status !== 308 || observed?.href !== expected.href)
        throw new Error(
          `${mode} route ${path} returned ${response.status} ${location ?? ''}, not a 308 to ${expectedPath}.`
        )
    })
  await Promise.all([
    expectPermanentRedirect('/about', '/about/'),
    expectPermanentRedirect('/robots.txt/', '/robots.txt'),
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
): Promise<{ head: string; loadsGoogleTagManager: boolean }> {
  const document = await readBoundedText(response, label, {
    maxBytes: maxDocumentProbeBytes,
    stopAt: /googletagmanager\.com/iu
  })
  return {
    head: document,
    loadsGoogleTagManager: document.toLowerCase().includes(googleTagManagerMarker)
  }
}

/**
 * Crawl and analytics policy per environment (serp standards/environment-configuration.md).
 *
 * - Staging (and any non-production origin): `X-Robots-Tag` noindex on `/`, robots.txt and
 *   the sitemap index; robots.txt disallows Google and `*`; no Google Tag Manager; and `/`
 *   without the smoke header is not redirected away (staging never redirects, and the
 *   production review origin must not redirect before the cutover).
 * - Production: no noindex on `/`, robots.txt or the sitemap index; robots.txt lets Google and
 *   `*` crawl and lists the sitemap index; Google Tag Manager loads. A noindex reaching
 *   best.serp.co would deindex the site.
 */
async function expectCrawlPolicy(target: GateTarget, contentPath: string): Promise<void> {
  const { baseUrl, mode } = target
  if (mode === 'staging') {
    for (const path of ['/', '/sitemap-index.xml', '/robots.txt']) {
      await boundedFetch(target, routeUrl(baseUrl, path), async response => {
        if (!xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag'))) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`staging route ${path} sent no noindex in its X-Robots-Tag header.`)
        }
        if (path === '/' && (await readDocument(response, 'staging route /')).loadsGoogleTagManager)
          throw new Error('staging route / loads Google Tag Manager.')
        if (path === '/robots.txt') {
          const groups = parseRobotsTxt(await readBoundedText(response, 'staging robots.txt'))
          const crawlable = ['*', 'googlebot'].find(agent => robotsTxtAllows(groups, agent, '/'))
          if (crawlable) throw new Error(`staging robots.txt lets user-agent ${crawlable} crawl /.`)
        }
        await response.body?.cancel().catch(() => undefined)
      })
    }
    await boundedFetch(
      target,
      routeUrl(baseUrl, '/'),
      async response => {
        await response.body?.cancel().catch(() => undefined)
        if (response.status !== 200)
          throw new Error(
            `staging route / without the smoke-test header returned ${response.status} ${response.headers.get('location') ?? ''}; this origin must not redirect.`
          )
      },
      false
    )
    return
  }
  await boundedFetch(target, routeUrl(baseUrl, '/'), async response => {
    const header = xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag'))
    const document = await readDocument(response, 'production route /')
    if (header || metaRobotsBlocksIndexing(document.head))
      throw new Error(
        `production route / sent noindex in its ${header ? 'X-Robots-Tag header' : 'robots meta'}.`
      )
    if (!document.loadsGoogleTagManager)
      throw new Error('production route / does not load Google Tag Manager.')
  })
  const sitemapIndex = routeUrl(baseUrl, '/sitemap-index.xml')
  await boundedFetch(target, sitemapIndex, async response => {
    await response.body?.cancel().catch(() => undefined)
    if (xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag')))
      throw new Error('production route /sitemap-index.xml sent X-Robots-Tag noindex.')
  })
  await boundedFetch(target, routeUrl(baseUrl, '/robots.txt'), async response => {
    if (response.status !== 200)
      throw new Error(`production route /robots.txt returned ${response.status}.`)
    if (xRobotsTagBlocksIndexing(response.headers.get('x-robots-tag')))
      throw new Error('production route /robots.txt sent X-Robots-Tag noindex.')
    const robots = await readBoundedText(response, 'production route /robots.txt')
    const listsSitemapIndex = robots
      .split(/\r?\n/u)
      .some(line => /^\s*sitemap\s*:\s*(\S+)\s*$/iu.exec(line)?.[1] === sitemapIndex.href)
    if (!listsSitemapIndex)
      throw new Error(`production robots.txt does not list "Sitemap: ${sitemapIndex.href}".`)
    const blocked = robotsTxtBlockedPath(robots, ['/', contentPath])
    if (blocked)
      throw new Error(
        `production robots.txt blocks ${blocked.path} for user-agent ${blocked.agent}.`
      )
  })
}

/** Whether the checked-in production config turns the canonical-host redirect on. */
export function canonicalHostRedirectConfigured(
  configPath: string = project.wranglerConfigPath
): boolean {
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as {
    env?: { production?: { vars?: Record<string, string | undefined> } }
  }
  const value = config.env?.production?.vars?.CANONICAL_HOST_REDIRECT
  if (value !== 'on' && value !== 'off')
    throw new Error(`${configPath} env.production.vars.CANONICAL_HOST_REDIRECT must be on or off.`)
  return value === 'on'
}

/**
 * With `CANONICAL_HOST_REDIRECT=on`, the production platform host answers a request without
 * the smoke-test header with one 308 to the same canonical URL on best.serp.co, and serves a
 * request that carries it.
 */
async function expectCanonicalHostRedirect(target: GateTarget): Promise<void> {
  const platform = new URL(project.remote.production.reviewOrigin)
  const platformTarget: GateTarget = { ...target, baseUrl: platform }
  await boundedFetch(
    platformTarget,
    routeUrl(platform, '/about?gate=canonical-host'),
    async response => {
      await response.body?.cancel().catch(() => undefined)
      const expected = `${target.baseUrl.origin}/about/?gate=canonical-host`
      const location = response.headers.get('location')
      if (response.status !== 308 || location !== expected)
        throw new Error(
          `production platform host ${platform.host}/about returned ${response.status} ${location ?? ''}, not a 308 to ${expected}.`
        )
    },
    false
  )
  await boundedFetch(platformTarget, routeUrl(platform, '/'), async response => {
    await response.body?.cancel().catch(() => undefined)
    if (response.status !== 200)
      throw new Error(
        `production platform host ${platform.host}/ with the smoke-test header returned ${response.status}.`
      )
  })
}

export async function runHttpGates(
  modeValue: string,
  baseUrlValue: string,
  options: HttpGateOptions = {}
): Promise<void> {
  const mode = parseMode(modeValue)
  const baseUrl = validateBaseUrl(mode, baseUrlValue)
  const parityReportPath = options.parityReportPath ?? project.artifact.parityReportPath
  const report = parse(readFileSync(resolve(parityReportPath), 'utf8')) as {
    parity: { categories: Array<{ slug: string }>; exactSlugSet: string[] }
  }
  const listingSlug = report.parity.exactSlugSet[0]
  const categorySlug = report.parity.categories[0]?.slug
  if (!listingSlug || !categorySlug) throw new Error('Reviewed parity samples are empty.')
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultRequestTimeoutMs)
    throw new Error('HTTP gate timeout must be a positive integer within the protected bound.')
  if (options.expectedVersion !== undefined && !workerVersionPattern.test(options.expectedVersion))
    throw new Error('The expected Worker version is not a Worker version id.')
  const redirectHost =
    mode === 'production' && canonicalHostRedirectConfigured(options.wranglerConfigPath)
  const target: GateTarget = { baseUrl, expectedVersion: options.expectedVersion, mode, timeoutMs }
  if (target.expectedVersion) {
    const probes = await waitForWorkerVersion(baseUrl, target.expectedVersion, {
      intervalMs: options.versionPollIntervalMs,
      sleep: options.sleep,
      timeoutMs,
      waitMs: options.versionWaitMs
    })
    console.info(`Worker version ${target.expectedVersion} answered ${probes} probe(s).`)
  }
  await withTrailingSlashPolicy(target, listingSlug, [
    expectRoute(target, '/'),
    expectRoute(target, categoryRoute(categorySlug)),
    expectRoute(target, listingRoute(listingSlug)),
    expectRoute(target, `/api/search?q=${encodeURIComponent(listingSlug)}`),
    expectRoute(target, '/rss.xml'),
    expectRoute(target, '/sitemap-index.xml'),
    expectLegacyRedirect(target, `/${listingSlug}/`, listingRoute(listingSlug)),
    expectRoute(target, '/submit/')
  ])
  await expectCrawlPolicy(target, listingRoute(listingSlug))
  if (redirectHost) await expectCanonicalHostRedirect(target)
}

export async function runStagingHttpGates(baseUrlValue: string): Promise<void> {
  return runHttpGates('staging', baseUrlValue)
}

async function main(): Promise<void> {
  const [modeValue, baseUrlValue, output] = process.argv.slice(2)
  if (!modeValue || !baseUrlValue)
    throw new Error(
      'Usage: d1-preview-http-gates.ts <staging|production> <clean-https-origin> [output]'
    )
  const expectedVersion = expectedWorkerVersionFromEnvironment(process.env)
  if (!expectedVersion)
    console.info(
      'No expected Worker version (EXPECTED_WORKER_VERSION or WRANGLER_OUTPUT_FILE_PATH): gating whichever version answers.'
    )
  await runHttpGates(modeValue, baseUrlValue, { expectedVersion })
  if (output)
    writeFileSync(
      resolve(output),
      `${JSON.stringify({ home: true, category: true, detail: true, search: true, rss: true, sitemap: true, legacyRedirect: true, submit: true, workerVersion: expectedVersion ?? null })}\n`
    )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
