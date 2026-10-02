import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { project } from './project'
import { categoryRoute, listingRoute } from './site-routes'

export type HttpGateMode = 'staging' | 'production'
const defaultRequestTimeoutMs = 15_000
const maxBodyProbeBytes = 4_096

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

async function boundedFetch<T>(
  url: URL,
  timeoutMs: number,
  inspect: (response: Response) => Promise<T>
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
      fetch(url, { redirect: 'manual', signal: controller.signal }).then(inspect),
      deadline
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
  }
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

async function expectRoute(
  mode: HttpGateMode,
  baseUrl: URL,
  path: string,
  timeoutMs: number
): Promise<void> {
  await boundedFetch(routeUrl(baseUrl, path), timeoutMs, async response => {
    if (response.status < 200 || response.status >= 300)
      throw new Error(`${mode} route ${path} returned ${response.status}.`)
    await requireNonemptyBody(response, `${mode} route ${path}`)
  })
}

/**
 * URL trailing-slash standard (serp docs/engineering/standards/url-trailing-slash.md): a page
 * URL without its slash and a file URL with one answer exactly one 308 to the canonical form,
 * and /api is served as requested.
 */
async function expectTrailingSlashPolicy(
  mode: HttpGateMode,
  baseUrl: URL,
  searchQuery: string,
  timeoutMs: number
): Promise<void> {
  const expectPermanentRedirect = (path: string, expectedPath: string) =>
    boundedFetch(routeUrl(baseUrl, path), timeoutMs, async response => {
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
    expectRoute(mode, baseUrl, `/api/search/?q=${encodeURIComponent(searchQuery)}`, timeoutMs)
  ])
}

/**
 * Awaits the route contracts with the trailing-slash checks running alongside them; a route
 * contract failure is reported first.
 */
async function withTrailingSlashPolicy(
  mode: HttpGateMode,
  baseUrl: URL,
  searchQuery: string,
  timeoutMs: number,
  routeContracts: Promise<void>[]
): Promise<void> {
  const trailingSlash = expectTrailingSlashPolicy(mode, baseUrl, searchQuery, timeoutMs)
  trailingSlash.catch(() => undefined)
  await Promise.all(routeContracts)
  await trailingSlash
}

async function expectLegacyRedirect(
  mode: HttpGateMode,
  baseUrl: URL,
  legacyPath: string,
  expectedPath: string,
  timeoutMs: number
): Promise<void> {
  await boundedFetch(routeUrl(baseUrl, legacyPath), timeoutMs, async response => {
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

export async function runHttpGates(
  modeValue: string,
  baseUrlValue: string,
  options: { parityReportPath?: string; timeoutMs?: number } = {}
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
  await withTrailingSlashPolicy(mode, baseUrl, listingSlug, timeoutMs, [
    expectRoute(mode, baseUrl, '/', timeoutMs),
    expectRoute(mode, baseUrl, categoryRoute(categorySlug), timeoutMs),
    expectRoute(mode, baseUrl, listingRoute(listingSlug), timeoutMs),
    expectRoute(mode, baseUrl, `/api/search?q=${encodeURIComponent(listingSlug)}`, timeoutMs),
    expectRoute(mode, baseUrl, '/rss.xml', timeoutMs),
    expectRoute(mode, baseUrl, '/sitemap-index.xml', timeoutMs),
    expectLegacyRedirect(mode, baseUrl, `/${listingSlug}/`, listingRoute(listingSlug), timeoutMs),
    expectRoute(mode, baseUrl, '/submit/', timeoutMs)
  ])
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
  await runHttpGates(modeValue, baseUrlValue)
  if (output)
    writeFileSync(
      resolve(output),
      `${JSON.stringify({ home: true, category: true, detail: true, search: true, rss: true, sitemap: true, legacyRedirect: true, submit: true })}\n`
    )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
