import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCheckedInSiteConfig } from '@serpdirectory/site-contract'
import { activeCheckedInSiteIds } from '@serpdirectory/site-contract/active-site-ids'
import type { CheckedInSiteConfig } from '@serpdirectory/site-contract/types'

type AuditScope = 'artifact' | 'live'
type AuditSeverity = 'error' | 'warning'

export type SitemapAuditIssue = {
  message: string
  severity: AuditSeverity
  sitemapUrl?: string
  url?: string
}

export type SitemapFileAudit = {
  locCount: number
  sitemapUrl: string
  status?: number | string
  type: 'sitemapindex' | 'urlset' | 'unknown'
}

type ParsedSitemapEntry = {
  lastmod?: string
  loc: string
}

type RobotsAudit = {
  sitemapTarget?: string
  status?: number | string
}

export type SitemapSiteAudit = {
  artifactDir?: string
  childSitemaps: SitemapFileAudit[]
  compatibilitySitemap?: SitemapFileAudit
  domain: string
  issues: SitemapAuditIssue[]
  robots?: RobotsAudit
  scope: AuditScope
  siteId: string
  sitemapIndexUrl: string
  urlCount: number
}

type CliOptions = {
  json: boolean
  reportPath?: string
  scope: 'artifact' | 'live' | 'both'
  siteIds: string[]
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const SITEMAP_INDEX_PATH = '/sitemap-index.xml'
const SITEMAP_COMPATIBILITY_PATH = '/sitemap.xml'
const LEGACY_GROUP_SITEMAP_PATHS = [
  '/pages-sitemap.xml',
  '/listings-sitemap.xml',
  '/taxonomies-sitemap.xml',
  '/docs-sitemap.xml',
  '/posts-sitemap.xml'
] as const

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function decodeXmlEntity(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

export function parseSitemapLocs(xml: string): string[] {
  return parseSitemapEntries(xml).map(entry => entry.loc)
}

export function parseSitemapEntries(xml: string): ParsedSitemapEntry[] {
  return [...xml.matchAll(/<(url|sitemap)>\s*([\s\S]*?)\s*<\/\1>/g)].map(match => {
    const body = match[2] ?? ''
    const loc = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1] ?? ''
    const lastmod = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1]

    return {
      lastmod: lastmod ? decodeXmlEntity(lastmod) : undefined,
      loc: decodeXmlEntity(loc)
    }
  })
}

function sitemapXmlType(xml: string): SitemapFileAudit['type'] {
  if (xml.includes('<sitemapindex')) {
    return 'sitemapindex'
  }

  if (xml.includes('<urlset')) {
    return 'urlset'
  }

  return 'unknown'
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function normalizePath(path: string): string {
  const normalizedPath = path.replace(/^\/+|\/+$/g, '')
  return normalizedPath ? `/${normalizedPath}` : '/'
}

function hasFileExtension(path: string): boolean {
  return path.split('/').at(-1)?.includes('.') ?? false
}

function hasFinalTrailingSlash(path: string): boolean {
  return path === '/' || path.endsWith('/') || hasFileExtension(path)
}

function isValidW3CDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
}

function toAbsoluteUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

function getSitemapIndexUrl(siteConfig: CheckedInSiteConfig): string {
  return toAbsoluteUrl(siteConfig.site.publicUrl, SITEMAP_INDEX_PATH)
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function sameOrigin(left: string, right: string): boolean {
  const leftUrl = tryParseUrl(left)
  const rightUrl = tryParseUrl(right)
  return leftUrl !== null && rightUrl !== null && leftUrl.origin === rightUrl.origin
}

function artifactFilePathForUrl(artifactDir: string, url: string): string | null {
  const parsedUrl = tryParseUrl(url)

  if (!parsedUrl) {
    return null
  }

  const normalizedPath = normalizePath(parsedUrl.pathname)
  return resolve(artifactDir, normalizedPath.slice(1))
}

function publicPathForArtifactFile(artifactDir: string, filePath: string): string {
  return normalizePath(filePath.slice(artifactDir.length + 1).replaceAll('\\', '/'))
}

function isSitemapArtifactPath(publicPath: string): boolean {
  const normalizedPath = normalizePath(publicPath)
  const fileName = normalizedPath.split('/').at(-1) ?? ''

  return (
    normalizedPath === SITEMAP_INDEX_PATH ||
    normalizedPath === SITEMAP_COMPATIBILITY_PATH ||
    normalizedPath.startsWith('/sitemaps/') ||
    (fileName.includes('sitemap') && fileName.endsWith('.xml'))
  )
}

function listSitemapArtifactPaths(artifactDir: string, currentDir = artifactDir): string[] {
  const sitemapPaths: string[] = []

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      sitemapPaths.push(...listSitemapArtifactPaths(artifactDir, entryPath))
      continue
    }

    const publicPath = publicPathForArtifactFile(artifactDir, entryPath)
    if (isSitemapArtifactPath(publicPath)) {
      sitemapPaths.push(publicPath)
    }
  }

  return sitemapPaths
}

function artifactRouteIndexPathForUrl(artifactDir: string, url: string): string | null {
  const parsedUrl = tryParseUrl(url)

  if (!parsedUrl) {
    return null
  }

  const normalizedPath = normalizePath(parsedUrl.pathname)
  return normalizedPath === '/'
    ? resolve(artifactDir, 'index.html')
    : resolve(artifactDir, normalizedPath.slice(1), 'index.html')
}

function addIssue(
  audit: SitemapSiteAudit,
  severity: AuditSeverity,
  message: string,
  details: { sitemapUrl?: string; url?: string } = {}
): void {
  audit.issues.push({
    message,
    severity,
    ...details
  })
}

function configuredExcludedPaths(siteConfig: CheckedInSiteConfig): Set<string> {
  return new Set(
    [
      ...(siteConfig.sitemap.excludedPaths ?? []),
      ...(siteConfig.sitemap.artifactExcludedPaths ?? [])
    ].map(path => normalizePath(path))
  )
}

function isRedirectOrErrorShell(path: string): boolean {
  const html = readFileSync(path, 'utf8')
  return html.includes('NEXT_REDIRECT') || html.includes('__next_error__')
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))

  return match?.[1] ?? match?.[2]
}

function getCanonicalHref(html: string): string | undefined {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const linkTag = tag[0]
    const rel = getHtmlAttribute(linkTag, 'rel')

    if (!rel?.split(/\s+/).some(value => value.toLowerCase() === 'canonical')) {
      continue
    }

    return getHtmlAttribute(linkTag, 'href')
  }

  return undefined
}

function getRobotsMetaContents(html: string): string[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => {
      const name = getHtmlAttribute(tag, 'name')?.toLowerCase()
      return name === 'robots' || name === 'googlebot'
    })
    .map(tag => getHtmlAttribute(tag, 'content') ?? '')
    .filter(Boolean)
}

function normalizeCanonicalUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return null
  }
}

function validatePageMetadata(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  url: string,
  html: string
): void {
  const canonicalHref = getCanonicalHref(html)

  if (canonicalHref) {
    const canonicalUrl = normalizeCanonicalUrl(canonicalHref, siteConfig.site.publicUrl)
    const sitemapEntryUrl = normalizeCanonicalUrl(url, siteConfig.site.publicUrl)

    if (canonicalUrl && sitemapEntryUrl && canonicalUrl !== sitemapEntryUrl) {
      addIssue(audit, 'error', 'Sitemap entry canonical URL does not match the sitemap URL.', {
        sitemapUrl,
        url
      })
    }
  }

  if (
    getRobotsMetaContents(html).some(content =>
      content
        .toLowerCase()
        .split(/[,\s]+/)
        .some(value => value === 'noindex' || value === 'nofollow')
    )
  ) {
    addIssue(audit, 'error', 'Sitemap entry has noindex or nofollow robots metadata.', {
      sitemapUrl,
      url
    })
  }
}

function validateArtifactPageMetadata(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  url: string,
  routeIndexPath: string
): void {
  validatePageMetadata(audit, siteConfig, sitemapUrl, url, readFileSync(routeIndexPath, 'utf8'))
}

function validateArtifactPageUrl(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  url: string,
  seenPageUrls: Set<string>
): void {
  const parsedUrl = tryParseUrl(url)

  if (!parsedUrl) {
    addIssue(audit, 'error', 'Sitemap entry is not a valid absolute URL.', {
      sitemapUrl,
      url
    })
    return
  }

  if (!sameOrigin(url, siteConfig.site.publicUrl)) {
    addIssue(audit, 'error', 'Sitemap entry points outside the site origin.', {
      sitemapUrl,
      url
    })
    return
  }

  if (seenPageUrls.has(url)) {
    addIssue(audit, 'warning', 'Duplicate sitemap entry.', { sitemapUrl, url })
  }
  seenPageUrls.add(url)

  if (!hasFinalTrailingSlash(parsedUrl.pathname)) {
    addIssue(audit, 'error', 'Final page sitemap URL is missing a trailing slash.', {
      sitemapUrl,
      url
    })
  }

  const normalizedPath = normalizePath(parsedUrl.pathname)
  if (configuredExcludedPaths(siteConfig).has(normalizedPath)) {
    addIssue(audit, 'error', 'Excluded path leaked into sitemap output.', {
      sitemapUrl,
      url
    })
  }

  const routeIndexPath = artifactRouteIndexPathForUrl(audit.artifactDir ?? '', url)
  if (!routeIndexPath || !existsSync(routeIndexPath)) {
    addIssue(audit, 'error', 'Sitemap entry does not map to a generated route artifact.', {
      sitemapUrl,
      url
    })
    return
  }

  if (isRedirectOrErrorShell(routeIndexPath)) {
    addIssue(audit, 'error', 'Sitemap entry maps to a redirect or error shell.', {
      sitemapUrl,
      url
    })
    return
  }

  validateArtifactPageMetadata(audit, siteConfig, sitemapUrl, url, routeIndexPath)
}

function validateSitemapLastmods(
  audit: SitemapSiteAudit,
  sitemapUrl: string,
  entries: ParsedSitemapEntry[]
): void {
  for (const entry of entries) {
    if (!entry.lastmod) {
      addIssue(audit, 'error', 'Sitemap entry is missing lastmod.', {
        sitemapUrl,
        url: entry.loc
      })
      continue
    }

    if (!isValidW3CDateTime(entry.lastmod)) {
      addIssue(audit, 'error', 'Sitemap entry lastmod is not W3C Datetime format.', {
        sitemapUrl,
        url: entry.loc
      })
    }
  }
}

function auditArtifactSitemapFile(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  seenSitemaps: Set<string>,
  seenPageUrls: Set<string>,
  allowSitemapIndex = false
): void {
  if (seenSitemaps.has(sitemapUrl)) {
    addIssue(audit, 'warning', 'Duplicate sitemap file reference.', { sitemapUrl })
    return
  }
  seenSitemaps.add(sitemapUrl)

  if (!sameOrigin(sitemapUrl, siteConfig.site.publicUrl)) {
    addIssue(audit, 'error', 'Sitemap file points outside the site origin.', { sitemapUrl })
    return
  }

  const artifactPath = artifactFilePathForUrl(audit.artifactDir ?? '', sitemapUrl)
  if (!artifactPath || !existsSync(artifactPath)) {
    addIssue(audit, 'error', 'Sitemap file referenced by index is missing from artifact.', {
      sitemapUrl
    })
    return
  }

  const xml = readFileSync(artifactPath, 'utf8')
  const type = sitemapXmlType(xml)
  const entries = parseSitemapEntries(xml)
  const locs = entries.map(entry => entry.loc)

  audit.childSitemaps.push({
    locCount: locs.length,
    sitemapUrl,
    type
  })

  if (type === 'unknown') {
    addIssue(audit, 'error', 'Sitemap file is not a sitemap index or URL set.', {
      sitemapUrl
    })
    return
  }

  if (locs.length === 0) {
    addIssue(audit, 'error', 'Sitemap file contains no loc entries.', { sitemapUrl })
    return
  }

  validateSitemapLastmods(audit, sitemapUrl, entries)

  if (type === 'sitemapindex' && !allowSitemapIndex) {
    addIssue(audit, 'error', 'Sitemap index must point directly to URL-set sitemap files.', {
      sitemapUrl
    })
    return
  }

  if (type === 'sitemapindex') {
    for (const childSitemapUrl of locs) {
      auditArtifactSitemapFile(audit, siteConfig, childSitemapUrl, seenSitemaps, seenPageUrls)
    }
    return
  }

  audit.urlCount += locs.length
  for (const url of locs) {
    validateArtifactPageUrl(audit, siteConfig, sitemapUrl, url, seenPageUrls)
  }
}

function validateArtifactRobots(audit: SitemapSiteAudit, siteConfig: CheckedInSiteConfig): void {
  const robotsPath = resolve(audit.artifactDir ?? '', 'robots.txt')

  if (!existsSync(robotsPath)) {
    addIssue(audit, 'error', 'robots.txt is missing from artifact.')
    return
  }

  const robots = readFileSync(robotsPath, 'utf8')
  const sitemapTarget = robots
    .split(/\r?\n/)
    .find(line => line.toLowerCase().startsWith('sitemap:'))
    ?.slice('sitemap:'.length)
    .trim()

  audit.robots = {
    sitemapTarget,
    status: 200
  }

  if (sitemapTarget !== getSitemapIndexUrl(siteConfig)) {
    addIssue(
      audit,
      'error',
      `robots.txt sitemap target must be ${getSitemapIndexUrl(siteConfig)}.`,
      { url: sitemapTarget }
    )
  }
}

function validateArtifactCompatibilitySitemap(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig
): void {
  const compatibilityUrl = toAbsoluteUrl(siteConfig.site.publicUrl, '/sitemap.xml')
  const compatibilityPath = resolve(audit.artifactDir ?? '', 'sitemap.xml')
  const indexPath = resolve(audit.artifactDir ?? '', 'sitemap-index.xml')

  if (!existsSync(compatibilityPath)) {
    addIssue(audit, 'error', 'Compatibility sitemap.xml is missing from artifact.', {
      sitemapUrl: compatibilityUrl
    })
    return
  }

  const compatibilityXml = readFileSync(compatibilityPath, 'utf8')
  const compatibilityLocs = parseSitemapLocs(compatibilityXml)
  audit.compatibilitySitemap = {
    locCount: compatibilityLocs.length,
    sitemapUrl: compatibilityUrl,
    status: 200,
    type: sitemapXmlType(compatibilityXml)
  }

  if (audit.compatibilitySitemap.type !== 'sitemapindex') {
    addIssue(audit, 'error', 'Compatibility sitemap.xml must be a sitemap index.', {
      sitemapUrl: compatibilityUrl
    })
  }

  if (existsSync(indexPath)) {
    const indexLocs = parseSitemapLocs(readFileSync(indexPath, 'utf8'))
    if (JSON.stringify(compatibilityLocs) !== JSON.stringify(indexLocs)) {
      addIssue(
        audit,
        'error',
        'Compatibility sitemap.xml does not match sitemap-index.xml child sitemap entries.',
        { sitemapUrl: compatibilityUrl }
      )
    }
  }
}

function validateArtifactUnreferencedSitemapFiles(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  referencedSitemapUrls: Set<string>
): void {
  const allowedSitemapUrls = new Set([
    ...referencedSitemapUrls,
    toAbsoluteUrl(siteConfig.site.publicUrl, SITEMAP_COMPATIBILITY_PATH)
  ])

  for (const publicPath of listSitemapArtifactPaths(audit.artifactDir ?? '')) {
    const sitemapUrl = toAbsoluteUrl(siteConfig.site.publicUrl, publicPath)
    if (!allowedSitemapUrls.has(sitemapUrl)) {
      addIssue(audit, 'error', 'Unreferenced sitemap file is present in artifact.', {
        sitemapUrl
      })
    }
  }
}

export function auditArtifactSitemaps(siteConfig: CheckedInSiteConfig): SitemapSiteAudit {
  const artifactDir = resolve(process.cwd(), siteConfig.build.artifactDir)
  const audit: SitemapSiteAudit = {
    artifactDir,
    childSitemaps: [],
    domain: siteConfig.site.domain,
    issues: [],
    scope: 'artifact',
    siteId: siteConfig.id,
    sitemapIndexUrl: getSitemapIndexUrl(siteConfig),
    urlCount: 0
  }

  if (!existsSync(artifactDir)) {
    addIssue(audit, 'error', 'Artifact directory is missing. Build the site before auditing.', {
      sitemapUrl: audit.sitemapIndexUrl
    })
    return audit
  }

  const referencedSitemaps = new Set<string>()

  validateArtifactRobots(audit, siteConfig)
  validateArtifactCompatibilitySitemap(audit, siteConfig)
  auditArtifactSitemapFile(
    audit,
    siteConfig,
    audit.sitemapIndexUrl,
    referencedSitemaps,
    new Set<string>(),
    true
  )
  validateArtifactUnreferencedSitemapFiles(audit, siteConfig, referencedSitemaps)

  return audit
}

async function fetchText(
  url: string,
  timeoutMs: number
): Promise<{ body: string; contentType: string; status: number }> {
  const response = await fetch(url, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  return {
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
    status: response.status
  }
}

async function fetchStatus(url: string, timeoutMs: number): Promise<number | string> {
  try {
    const response = await fetch(url, {
      headers: { connection: 'close' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    await response.body?.cancel()
    return response.status
  } catch (error) {
    return error instanceof Error ? `ERR:${error.name}` : 'ERR:unknown'
  }
}

async function auditLivePageUrl(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  url: string,
  timeoutMs: number,
  seenPageUrls: Set<string>
): Promise<void> {
  const parsedUrl = tryParseUrl(url)

  if (!parsedUrl) {
    addIssue(audit, 'error', 'Sitemap entry is not a valid absolute URL.', {
      sitemapUrl,
      url
    })
    return
  }

  if (!sameOrigin(url, siteConfig.site.publicUrl)) {
    addIssue(audit, 'error', 'Sitemap entry points outside the site origin.', {
      sitemapUrl,
      url
    })
    return
  }

  if (seenPageUrls.has(url)) {
    addIssue(audit, 'warning', 'Duplicate sitemap entry.', { sitemapUrl, url })
  }
  seenPageUrls.add(url)

  if (!hasFinalTrailingSlash(parsedUrl.pathname)) {
    addIssue(audit, 'error', 'Final page sitemap URL is missing a trailing slash.', {
      sitemapUrl,
      url
    })
  }

  if (configuredExcludedPaths(siteConfig).has(normalizePath(parsedUrl.pathname))) {
    addIssue(audit, 'error', 'Excluded path leaked into sitemap output.', {
      sitemapUrl,
      url
    })
  }

  let response: Awaited<ReturnType<typeof fetchText>>
  try {
    response = await fetchText(url, timeoutMs)
  } catch (error) {
    addIssue(
      audit,
      'error',
      `Failed to fetch live sitemap entry: ${error instanceof Error ? error.message : String(error)}`,
      {
        sitemapUrl,
        url
      }
    )
    return
  }

  if (response.status !== 200) {
    addIssue(audit, 'error', `Live sitemap entry returned ${response.status}.`, {
      sitemapUrl,
      url
    })
    return
  }

  validatePageMetadata(audit, siteConfig, sitemapUrl, url, response.body)
}

async function auditLiveSitemapFile(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  sitemapUrl: string,
  timeoutMs: number,
  seenSitemaps: Set<string>,
  seenPageUrls: Set<string>,
  allowSitemapIndex = false
): Promise<void> {
  if (seenSitemaps.has(sitemapUrl)) {
    addIssue(audit, 'warning', 'Duplicate sitemap file reference.', { sitemapUrl })
    return
  }
  seenSitemaps.add(sitemapUrl)

  if (!sameOrigin(sitemapUrl, siteConfig.site.publicUrl)) {
    addIssue(audit, 'error', 'Sitemap file points outside the site origin.', { sitemapUrl })
    return
  }

  let response: Awaited<ReturnType<typeof fetchText>>
  try {
    response = await fetchText(sitemapUrl, timeoutMs)
  } catch (error) {
    addIssue(
      audit,
      'error',
      `Failed to fetch sitemap file: ${error instanceof Error ? error.message : String(error)}`,
      { sitemapUrl }
    )
    return
  }

  if (response.status !== 200) {
    addIssue(audit, 'error', `Sitemap file returned ${response.status}.`, { sitemapUrl })
    return
  }

  if (!response.contentType.includes('xml')) {
    addIssue(audit, 'warning', `Sitemap file content-type is ${response.contentType}.`, {
      sitemapUrl
    })
  }

  const type = sitemapXmlType(response.body)
  const entries = parseSitemapEntries(response.body)
  const locs = entries.map(entry => entry.loc)

  audit.childSitemaps.push({
    locCount: locs.length,
    sitemapUrl,
    status: response.status,
    type
  })

  if (type === 'unknown') {
    addIssue(audit, 'error', 'Sitemap file is not a sitemap index or URL set.', {
      sitemapUrl
    })
    return
  }

  if (locs.length === 0) {
    addIssue(audit, 'error', 'Sitemap file contains no loc entries.', { sitemapUrl })
    return
  }

  validateSitemapLastmods(audit, sitemapUrl, entries)

  if (type === 'sitemapindex' && !allowSitemapIndex) {
    addIssue(audit, 'error', 'Sitemap index must point directly to URL-set sitemap files.', {
      sitemapUrl
    })
    return
  }

  if (type === 'sitemapindex') {
    for (const childSitemapUrl of locs) {
      await auditLiveSitemapFile(
        audit,
        siteConfig,
        childSitemapUrl,
        timeoutMs,
        seenSitemaps,
        seenPageUrls
      )
    }
    return
  }

  audit.urlCount += locs.length
  for (const url of locs) {
    await auditLivePageUrl(audit, siteConfig, sitemapUrl, url, timeoutMs, seenPageUrls)
  }
}

async function validateLiveRobots(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  timeoutMs: number
): Promise<void> {
  const robotsUrl = toAbsoluteUrl(siteConfig.site.publicUrl, '/robots.txt')

  try {
    const response = await fetchText(robotsUrl, timeoutMs)
    const sitemapTarget = response.body
      .split(/\r?\n/)
      .find(line => line.toLowerCase().startsWith('sitemap:'))
      ?.slice('sitemap:'.length)
      .trim()

    audit.robots = {
      sitemapTarget,
      status: response.status
    }

    if (response.status !== 200) {
      addIssue(audit, 'error', `robots.txt returned ${response.status}.`, {
        url: robotsUrl
      })
      return
    }

    if (sitemapTarget !== getSitemapIndexUrl(siteConfig)) {
      addIssue(
        audit,
        'error',
        `robots.txt sitemap target must be ${getSitemapIndexUrl(siteConfig)}.`,
        { url: sitemapTarget }
      )
    }
  } catch (error) {
    addIssue(
      audit,
      'error',
      `Failed to fetch robots.txt: ${error instanceof Error ? error.message : String(error)}`,
      { url: robotsUrl }
    )
  }
}

async function validateLiveCompatibilitySitemap(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  timeoutMs: number
): Promise<void> {
  const compatibilityUrl = toAbsoluteUrl(siteConfig.site.publicUrl, '/sitemap.xml')

  try {
    const response = await fetchText(compatibilityUrl, timeoutMs)
    const locs = parseSitemapLocs(response.body)
    const type = sitemapXmlType(response.body)

    audit.compatibilitySitemap = {
      locCount: locs.length,
      sitemapUrl: compatibilityUrl,
      status: response.status,
      type
    }

    if (response.status !== 200) {
      addIssue(audit, 'error', `Compatibility sitemap.xml returned ${response.status}.`, {
        sitemapUrl: compatibilityUrl
      })
      return
    }

    if (type !== 'sitemapindex') {
      addIssue(audit, 'error', 'Compatibility sitemap.xml must be a sitemap index.', {
        sitemapUrl: compatibilityUrl
      })
    }
  } catch (error) {
    addIssue(
      audit,
      'error',
      `Failed to fetch compatibility sitemap.xml: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { sitemapUrl: compatibilityUrl }
    )
  }
}

async function validateLiveKnownUnreferencedSitemapFiles(
  audit: SitemapSiteAudit,
  siteConfig: CheckedInSiteConfig,
  timeoutMs: number,
  referencedSitemapUrls: Set<string>
): Promise<void> {
  const allowedSitemapUrls = new Set([
    ...referencedSitemapUrls,
    toAbsoluteUrl(siteConfig.site.publicUrl, SITEMAP_COMPATIBILITY_PATH)
  ])

  for (const publicPath of LEGACY_GROUP_SITEMAP_PATHS) {
    const sitemapUrl = toAbsoluteUrl(siteConfig.site.publicUrl, publicPath)
    if (allowedSitemapUrls.has(sitemapUrl)) {
      continue
    }

    const status = await fetchStatus(sitemapUrl, timeoutMs)
    if (typeof status === 'number' && status < 400) {
      addIssue(audit, 'error', 'Unreferenced sitemap file is publicly accessible.', {
        sitemapUrl
      })
    }
  }
}

export async function auditLiveSitemaps(
  siteConfig: CheckedInSiteConfig,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SitemapSiteAudit> {
  const audit: SitemapSiteAudit = {
    childSitemaps: [],
    domain: siteConfig.site.domain,
    issues: [],
    scope: 'live',
    siteId: siteConfig.id,
    sitemapIndexUrl: getSitemapIndexUrl(siteConfig),
    urlCount: 0
  }

  const referencedSitemaps = new Set<string>()

  await validateLiveRobots(audit, siteConfig, timeoutMs)
  await validateLiveCompatibilitySitemap(audit, siteConfig, timeoutMs)
  await auditLiveSitemapFile(
    audit,
    siteConfig,
    audit.sitemapIndexUrl,
    timeoutMs,
    referencedSitemaps,
    new Set<string>(),
    true
  )
  await validateLiveKnownUnreferencedSitemapFiles(audit, siteConfig, timeoutMs, referencedSitemaps)

  return audit
}

function issueCounts(audit: SitemapSiteAudit): { errors: number; warnings: number } {
  return {
    errors: audit.issues.filter(issue => issue.severity === 'error').length,
    warnings: audit.issues.filter(issue => issue.severity === 'warning').length
  }
}

export function formatConsoleReport(audits: SitemapSiteAudit[]): string {
  return audits
    .map(audit => {
      const counts = issueCounts(audit)
      const lines = [
        `${audit.scope} ${audit.siteId}: ${audit.urlCount} urls, ${audit.childSitemaps.length} sitemap files, ${counts.errors} errors, ${counts.warnings} warnings`
      ]

      for (const issue of audit.issues) {
        lines.push(
          `  [${issue.severity}] ${issue.message}${issue.url ? ` ${issue.url}` : ''}${
            issue.sitemapUrl ? ` (${issue.sitemapUrl})` : ''
          }`
        )
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

export function formatMarkdownReport(audits: SitemapSiteAudit[]): string {
  const generatedAt = new Date().toISOString()
  const rows = audits.map(audit => {
    const counts = issueCounts(audit)
    return `| ${audit.siteId} | ${audit.scope} | ${audit.childSitemaps.length} | ${audit.urlCount} | ${counts.errors} | ${counts.warnings} |`
  })
  const issueSections = audits
    .map(audit => {
      const childRows = audit.childSitemaps.map(
        sitemap =>
          `| ${escapeMarkdownCell(sitemap.sitemapUrl)} | ${sitemap.type} | ${
            sitemap.status ?? ''
          } | ${sitemap.locCount} |`
      )
      const details = [
        `Robots sitemap target: ${audit.robots?.sitemapTarget ?? 'not found'}${
          audit.robots?.status ? ` (${audit.robots.status})` : ''
        }`,
        `Compatibility sitemap: ${
          audit.compatibilitySitemap
            ? `${audit.compatibilitySitemap.sitemapUrl} (${audit.compatibilitySitemap.type}, ${audit.compatibilitySitemap.status ?? 'artifact'}, ${audit.compatibilitySitemap.locCount} locs)`
            : 'not checked'
        }`,
        '',
        '| Child sitemap | Type | Status | Locs |',
        '| --- | --- | ---: | ---: |',
        ...(childRows.length > 0 ? childRows : ['| none |  |  | 0 |'])
      ].join('\n')

      if (audit.issues.length === 0) {
        return `### ${audit.siteId} (${audit.scope})\n\n${details}\n\nNo issues found.`
      }

      const issueRows = audit.issues.map(
        issue =>
          `| ${issue.severity} | ${escapeMarkdownCell(issue.message)} | ${escapeMarkdownCell(
            issue.sitemapUrl ?? ''
          )} | ${escapeMarkdownCell(issue.url ?? '')} |`
      )

      return [
        `### ${audit.siteId} (${audit.scope})`,
        '',
        details,
        '',
        '| Severity | Message | Sitemap | URL |',
        '| --- | --- | --- | --- |',
        ...issueRows
      ].join('\n')
    })
    .join('\n\n')

  return [
    '# XML Sitemap Audit',
    '',
    `Generated: ${generatedAt}`,
    '',
    '| Site | Scope | Sitemap files | URLs | Errors | Warnings |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    '## Issues',
    '',
    issueSections,
    ''
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    scope: 'artifact',
    siteIds: [],
    timeoutMs: DEFAULT_TIMEOUT_MS
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--') {
      continue
    }

    if (arg === '--artifact') {
      options.scope = 'artifact'
      continue
    }

    if (arg === '--live') {
      options.scope = 'live'
      continue
    }

    if (arg === '--both') {
      options.scope = 'both'
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--site' && argv[index + 1]) {
      options.siteIds.push(argv[index + 1])
      index += 1
      continue
    }

    if (arg === '--report' && argv[index + 1]) {
      options.reportPath = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--timeout-ms' && argv[index + 1]) {
      options.timeoutMs = Number(argv[index + 1])
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }

  return options
}

async function runAudit(options: CliOptions): Promise<SitemapSiteAudit[]> {
  const siteIds = options.siteIds.length > 0 ? options.siteIds : [...activeCheckedInSiteIds]
  const audits: SitemapSiteAudit[] = []

  for (const siteId of siteIds) {
    const siteConfig = resolveCheckedInSiteConfig(siteId)

    if (options.scope === 'artifact' || options.scope === 'both') {
      audits.push(auditArtifactSitemaps(siteConfig))
    }

    if (options.scope === 'live' || options.scope === 'both') {
      audits.push(await auditLiveSitemaps(siteConfig, options.timeoutMs))
    }
  }

  return audits
}

export async function runAuditSitemaps(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const audits = await runAudit(options)
  const hasErrors = audits.some(audit => audit.issues.some(issue => issue.severity === 'error'))

  if (options.reportPath) {
    const reportPath = resolve(process.cwd(), options.reportPath)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, formatMarkdownReport(audits))
  }

  console.log(options.json ? JSON.stringify(audits, null, 2) : formatConsoleReport(audits))

  if (hasErrors) {
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runAuditSitemaps().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
