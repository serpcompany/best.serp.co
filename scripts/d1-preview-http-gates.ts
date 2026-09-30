import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { resolveSiteTarget, siteIds } from './site-targets'

export type HttpGateMode = 'preview' | 'production'
const defaultRequestTimeoutMs = 15_000
const maxBodyProbeBytes = 4_096

function parseMode(value: string): HttpGateMode {
  if (value === 'preview' || value === 'production') return value
  throw new Error('HTTP gate mode must be exactly preview or production.')
}

function validateBaseUrl(mode: HttpGateMode, siteId: string, value: string): URL {
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
  if (mode === 'production' && baseUrl.hostname !== siteId)
    throw new Error(`Production gates require the exact https://${siteId} origin.`)
  if (mode === 'preview' && siteIds.some(productionSiteId => baseUrl.hostname === productionSiteId))
    throw new Error('Preview gates reject every registered Production hostname.')
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
  siteValue: string,
  baseUrlValue: string,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const mode = parseMode(modeValue)
  const target = resolveSiteTarget(siteValue)
  const baseUrl = validateBaseUrl(mode, target.siteId, baseUrlValue)
  const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
    parity: { categories: Array<{ slug: string }>; exactSlugSet: string[] }
  }
  const listingSlug = report.parity.exactSlugSet[0]
  const categorySlug = report.parity.categories[0]?.slug
  if (!listingSlug || !categorySlug) throw new Error('Reviewed parity samples are empty.')
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultRequestTimeoutMs)
    throw new Error('HTTP gate timeout must be a positive integer within the protected bound.')
  await Promise.all([
    expectRoute(mode, baseUrl, '/', timeoutMs),
    expectRoute(mode, baseUrl, `/categories/${categorySlug}/`, timeoutMs),
    expectRoute(mode, baseUrl, `/products/${listingSlug}/`, timeoutMs),
    expectRoute(mode, baseUrl, `/api/search?q=${encodeURIComponent(listingSlug)}`, timeoutMs),
    expectRoute(mode, baseUrl, '/rss.xml', timeoutMs),
    expectRoute(mode, baseUrl, '/sitemap-index.xml', timeoutMs),
    expectLegacyRedirect(mode, baseUrl, `/${listingSlug}/`, `/products/${listingSlug}/`, timeoutMs),
    expectRoute(mode, baseUrl, '/submit/', timeoutMs)
  ])
}

export async function runPreviewHttpGates(siteValue: string, baseUrlValue: string): Promise<void> {
  return runHttpGates('preview', siteValue, baseUrlValue)
}

async function main(): Promise<void> {
  const [modeValue, siteValue, baseUrlValue, output] = process.argv.slice(2)
  if (!modeValue || !siteValue || !baseUrlValue)
    throw new Error(
      'Usage: d1-preview-http-gates.ts <preview|production> <site> <clean-https-origin> [output]'
    )
  await runHttpGates(modeValue, siteValue, baseUrlValue)
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
