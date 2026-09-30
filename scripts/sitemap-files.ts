import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const SITEMAP_PAGE_SIZE = 10_000

const PUBLIC_FILE_EXTENSION_PATTERN =
  /\.(?:css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webp|woff2?|xml)$/i

type SitemapGroup = {
  key: 'docs' | 'listings' | 'pages' | 'posts' | 'taxonomies'
  name: string
  paths: string[]
}

type SitemapLastmodOptions = {
  defaultLastmod?: string
  lastmodByPath?: Record<string, string>
}

type WriteSplitSitemapsOptions = {
  additionalPathsByGroup?: Partial<Record<SitemapGroup['key'], string[]>>
  baseUrl: string
  categoryBasePath?: string
  defaultLastmod?: string
  excludedPaths?: string[]
  indexGroupOrder?: SitemapGroup['key'][]
  lastmodByPath?: Record<string, string>
  listingDetailSuffix?: string
  listingBasePath: string
  pageSize?: number
  sitemapPathByGroup?: Partial<Record<SitemapGroup['key'], string>>
  staticPagePaths?: string[]
}

const EXCLUDED_SITEMAP_PATHS = new Set([
  '/404',
  '/account',
  '/cookies',
  '/favorites',
  '/login',
  '/news',
  '/privacy',
  '/search',
  '/submit',
  '/terms'
])

const DOCS_PREFIX = '/docs'
const POSTS_PREFIX = '/posts'
const SITEMAP_INDEX_PATH = '/sitemap-index.xml'
const SITEMAP_COMPATIBILITY_PATH = '/sitemap.xml'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function normalizeArtifactPath(path: string): string {
  if (!path) {
    return '/'
  }

  const normalizedPath = path.replaceAll(sep, '/').replace(/^\/+|\/+$/g, '')
  return normalizedPath ? `/${normalizedPath}` : '/'
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeXmlEntity(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(match =>
    decodeXmlEntity(match[1] ?? '')
  )
}

function isSitemapIndexXml(xml: string): boolean {
  return xml.includes('<sitemapindex')
}

function withTrailingSlash(path: string): string {
  if (path === '/') {
    return path
  }

  const lastSegment = path.split('/').at(-1) ?? ''

  if (path.endsWith('/') || PUBLIC_FILE_EXTENSION_PATTERN.test(lastSegment)) {
    return path
  }

  return `${path}/`
}

function buildUrl(
  baseUrl: string,
  path: string,
  options: { trailingSlash?: boolean } = {}
): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedPath = options.trailingSlash ? withTrailingSlash(path) : path
  return normalizedPath === '/' ? `${normalizedBaseUrl}/` : `${normalizedBaseUrl}${normalizedPath}`
}

function artifactFilePathForPublicPath(artifactDir: string, publicPath: string): string {
  return resolve(artifactDir, normalizeArtifactPath(publicPath).slice(1))
}

function publicPathForArtifactFile(artifactDir: string, filePath: string): string {
  return normalizeArtifactPath(filePath.slice(artifactDir.length + 1))
}

function sitemapPublicPathFromLoc(baseUrl: string, loc: string): string | null {
  try {
    const base = new URL(normalizeBaseUrl(baseUrl))
    const parsed = new URL(loc, base)

    if (parsed.origin !== base.origin) {
      return null
    }

    return normalizeArtifactPath(parsed.pathname)
  } catch {
    return null
  }
}

function isSitemapArtifactPath(publicPath: string): boolean {
  const normalizedPath = normalizeArtifactPath(publicPath)
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

function collectReachableSitemapPaths(
  artifactDir: string,
  baseUrl: string,
  sitemapPath: string,
  reachablePaths: Set<string>
): void {
  const normalizedPath = normalizeArtifactPath(sitemapPath)

  if (reachablePaths.has(normalizedPath)) {
    return
  }

  reachablePaths.add(normalizedPath)

  const sitemapFilePath = artifactFilePathForPublicPath(artifactDir, normalizedPath)
  if (!existsSync(sitemapFilePath)) {
    return
  }

  const xml = readFileSync(sitemapFilePath, 'utf8')
  if (!isSitemapIndexXml(xml)) {
    return
  }

  for (const loc of parseSitemapLocs(xml)) {
    const childPath = sitemapPublicPathFromLoc(baseUrl, loc)
    if (childPath && isSitemapArtifactPath(childPath)) {
      collectReachableSitemapPaths(artifactDir, baseUrl, childPath, reachablePaths)
    }
  }
}

function pruneUnreferencedSitemapFiles(artifactDir: string, baseUrl: string): void {
  const reachablePaths = new Set<string>()

  collectReachableSitemapPaths(artifactDir, baseUrl, SITEMAP_INDEX_PATH, reachablePaths)
  collectReachableSitemapPaths(artifactDir, baseUrl, SITEMAP_COMPATIBILITY_PATH, reachablePaths)

  for (const sitemapPath of listSitemapArtifactPaths(artifactDir)) {
    if (!reachablePaths.has(sitemapPath)) {
      rmSync(artifactFilePathForPublicPath(artifactDir, sitemapPath), { force: true })
    }
  }
}

function appendPathSegment(path: string, segment: string | undefined): string {
  if (!segment) {
    return path
  }

  const normalizedSegment = segment.replace(/^\/+|\/+$/g, '')

  if (!normalizedSegment) {
    return path
  }

  if (path.replace(/\/+$/g, '').endsWith(`/${normalizedSegment}`)) {
    return path
  }

  return `${path.replace(/\/+$/g, '')}/${normalizedSegment}`
}

function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) {
    return toPrefix
  }

  if (!path.startsWith(`${fromPrefix}/`)) {
    return path
  }

  return `${toPrefix}${path.slice(fromPrefix.length)}`
}

function chunkPaths(paths: string[], pageSize: number): string[][] {
  const chunks: string[][] = []

  for (let index = 0; index < paths.length; index += pageSize) {
    chunks.push(paths.slice(index, index + pageSize))
  }

  return chunks
}

function normalizeLastmod(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim()

  if (!trimmedValue) {
    return undefined
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return trimmedValue
  }

  const date = new Date(trimmedValue)

  if (Number.isNaN(date.getTime())) {
    return undefined
  }

  return date.toISOString()
}

function lastmodForPath(path: string, options: SitemapLastmodOptions = {}): string | undefined {
  const normalizedPath = normalizeArtifactPath(path)
  return normalizeLastmod(options.lastmodByPath?.[normalizedPath] ?? options.defaultLastmod)
}

function buildUrlSetXml(
  baseUrl: string,
  paths: string[],
  lastmodOptions: SitemapLastmodOptions = {}
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map(path => {
      const lastmod = lastmodForPath(path, lastmodOptions)
      const lastmodXml = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''
      return `<url><loc>${escapeXml(buildUrl(baseUrl, path, { trailingSlash: true }))}</loc>${lastmodXml}</url>`
    }),
    '</urlset>'
  ].join('')
}

function buildSitemapIndexXml(
  baseUrl: string,
  sitemapPaths: string[],
  defaultLastmod?: string
): string {
  const normalizedLastmod = normalizeLastmod(defaultLastmod)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapPaths.map(path => {
      const lastmodXml = normalizedLastmod
        ? `<lastmod>${escapeXml(normalizedLastmod)}</lastmod>`
        : ''
      return `<sitemap><loc>${escapeXml(buildUrl(baseUrl, path))}</loc>${lastmodXml}</sitemap>`
    }),
    '</sitemapindex>'
  ].join('')
}

function listArtifactRoutePaths(
  artifactDir: string,
  currentDir = artifactDir,
  excludedPaths = new Set<string>(),
  includedPaths = new Set<string>()
): string[] {
  const routePaths: string[] = []

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      routePaths.push(
        ...listArtifactRoutePaths(artifactDir, entryPath, excludedPaths, includedPaths)
      )
      continue
    }

    if (entry.name === '404.html') {
      continue
    }

    if (entry.name !== 'index.html') {
      continue
    }

    const relativeDir = currentDir === artifactDir ? '' : currentDir.slice(artifactDir.length + 1)
    const publicPath = normalizeArtifactPath(relativeDir)

    if (EXCLUDED_SITEMAP_PATHS.has(publicPath) && !includedPaths.has(publicPath)) {
      continue
    }

    if (excludedPaths.has(publicPath)) {
      continue
    }

    const html = readFileSync(entryPath, 'utf8')
    if (html.includes('NEXT_REDIRECT') || html.includes('__next_error__')) {
      continue
    }

    routePaths.push(publicPath)
  }

  return routePaths
}

function artifactRouteExists(artifactDir: string, path: string): boolean {
  const normalizedPath = normalizeArtifactPath(path)
  const routeFilePath =
    normalizedPath === '/'
      ? resolve(artifactDir, 'index.html')
      : resolve(artifactDir, normalizedPath.slice(1), 'index.html')

  return existsSync(routeFilePath)
}

function validateConfiguredSitemapRoutePaths(
  artifactDir: string,
  options: {
    additionalPathsByGroup?: Partial<Record<SitemapGroup['key'], string[]>>
    excludedPaths: Set<string>
    staticPagePaths?: string[]
  }
): void {
  const missingStaticPagePaths = (options.staticPagePaths ?? [])
    .map(path => normalizeArtifactPath(path))
    .filter(path => !artifactRouteExists(artifactDir, path))

  const missingAdditionalPaths = Object.entries(options.additionalPathsByGroup ?? {}).flatMap(
    ([group, paths]) =>
      (paths ?? [])
        .map(path => normalizeArtifactPath(path))
        .filter(path => !artifactRouteExists(artifactDir, path))
        .map(path => `${group}:${path}`)
  )

  const excludedAdditionalPaths = Object.entries(options.additionalPathsByGroup ?? {}).flatMap(
    ([group, paths]) =>
      (paths ?? [])
        .map(path => normalizeArtifactPath(path))
        .filter(path => options.excludedPaths.has(path))
        .map(path => `${group}:${path}`)
  )

  const failures = [
    missingStaticPagePaths.length > 0
      ? `staticPagePaths without route artifacts: ${missingStaticPagePaths.join(', ')}`
      : null,
    missingAdditionalPaths.length > 0
      ? `additionalPathsByGroup without route artifacts: ${missingAdditionalPaths.join(', ')}`
      : null,
    excludedAdditionalPaths.length > 0
      ? `additionalPathsByGroup entries also excluded from sitemaps: ${excludedAdditionalPaths.join(', ')}`
      : null
  ].filter((failure): failure is string => failure !== null)

  if (failures.length > 0) {
    throw new Error(`Invalid configured sitemap paths in ${artifactDir}\n${failures.join('\n')}`)
  }
}

function sortPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort((left, right) => {
    if (left === '/') return -1
    if (right === '/') return 1
    return left.localeCompare(right)
  })
}

function groupArtifactPaths(
  paths: string[],
  options: {
    categoryBasePath?: string
    listingBasePath: string
    listingDetailSuffix?: string
    staticPagePaths?: string[]
  }
): SitemapGroup[] {
  const listingPrefix = `/${options.listingBasePath}`
  const categoryPrefix = '/categories'
  const categoryOutputPrefix = options.categoryBasePath
    ? `/${options.categoryBasePath.replace(/^\/+|\/+$/g, '')}`
    : categoryPrefix
  const staticPagePaths = options.staticPagePaths
    ? new Set(options.staticPagePaths.map(path => normalizeArtifactPath(path)))
    : null
  const pages: string[] = []
  const listings: string[] = []
  const taxonomies: string[] = []
  const docs: string[] = []
  const posts: string[] = []

  for (const path of paths) {
    if (staticPagePaths?.has(path)) {
      pages.push(path)
      continue
    }

    if (
      categoryOutputPrefix !== categoryPrefix &&
      (path === categoryOutputPrefix || path.startsWith(`${categoryOutputPrefix}/`))
    ) {
      taxonomies.push(path)
      continue
    }

    if (path === DOCS_PREFIX || path.startsWith(`${DOCS_PREFIX}/`)) {
      docs.push(path)
      continue
    }

    if (path === POSTS_PREFIX || path.startsWith(`${POSTS_PREFIX}/`)) {
      posts.push(path)
      continue
    }

    if (path === listingPrefix) {
      if (!staticPagePaths) {
        taxonomies.push(path)
      }
      continue
    }

    if (path.startsWith(`${listingPrefix}/`)) {
      listings.push(appendPathSegment(path, options.listingDetailSuffix))
      continue
    }

    if (path.startsWith(`${categoryPrefix}/`)) {
      taxonomies.push(replacePathPrefix(path, categoryPrefix, categoryOutputPrefix))
      continue
    }

    if (staticPagePaths && !staticPagePaths.has(path)) {
      continue
    }

    pages.push(path)
  }

  return [
    { key: 'pages', name: 'pages-sitemap', paths: sortPaths(pages) },
    { key: 'listings', name: 'listings-sitemap', paths: sortPaths(listings) },
    { key: 'taxonomies', name: 'taxonomies-sitemap', paths: sortPaths(taxonomies) },
    { key: 'docs', name: 'docs-sitemap', paths: sortPaths(docs) },
    { key: 'posts', name: 'posts-sitemap', paths: sortPaths(posts) }
  ]
}

function writeGroupSitemaps(
  artifactDir: string,
  baseUrl: string,
  group: SitemapGroup,
  pageSize: number,
  lastmodOptions: SitemapLastmodOptions,
  outputPath?: string
): string[] {
  if (group.paths.length === 0) {
    return []
  }

  const pagePaths = chunkPaths(group.paths, pageSize)
  const sitemapEntries = pagePaths.map((_, index) =>
    outputPath
      ? paginatedOutputPath(outputPath, index + 1)
      : pagePaths.length === 1
        ? `/${group.name}.xml`
        : `/${group.name}-${index + 1}.xml`
  )

  pagePaths.forEach((paths, index) => {
    const sitemapPath = sitemapEntries[index] ?? `/${group.name}-${index + 1}.xml`
    const outputFilePath = resolve(artifactDir, normalizeArtifactPath(sitemapPath).slice(1))
    mkdirSync(dirname(outputFilePath), { recursive: true })
    writeFileSync(outputFilePath, buildUrlSetXml(baseUrl, paths, lastmodOptions))
  })

  return sitemapEntries
}

function paginatedOutputPath(outputPath: string, pageNumber: number): string {
  const normalizedOutputPath = normalizeArtifactPath(outputPath)

  if (pageNumber === 1) {
    return normalizedOutputPath
  }

  if (/\/\d+\.xml$/.test(normalizedOutputPath)) {
    return normalizedOutputPath.replace(/\/\d+\.xml$/, `/${pageNumber}.xml`)
  }

  if (normalizedOutputPath.endsWith('.xml')) {
    return normalizedOutputPath.replace(/\.xml$/, `-${pageNumber}.xml`)
  }

  return `${normalizedOutputPath.replace(/\/+$/g, '')}/${pageNumber}.xml`
}

export function writeSplitSitemaps(artifactDir: string, options: WriteSplitSitemapsOptions): void {
  const pageSize = options.pageSize ?? SITEMAP_PAGE_SIZE
  const defaultLastmod = normalizeLastmod(options.defaultLastmod) ?? new Date().toISOString()
  const excludedPaths = new Set(
    (options.excludedPaths ?? []).map(path => normalizeArtifactPath(path))
  )
  validateConfiguredSitemapRoutePaths(artifactDir, {
    additionalPathsByGroup: options.additionalPathsByGroup,
    excludedPaths,
    staticPagePaths: options.staticPagePaths
  })
  const includedPaths = new Set(
    (options.staticPagePaths ?? []).map(path => normalizeArtifactPath(path))
  )
  const publicPaths = sortPaths(
    listArtifactRoutePaths(artifactDir, artifactDir, excludedPaths, includedPaths)
  )
  const groupedPaths = groupArtifactPaths(publicPaths, {
    categoryBasePath: options.categoryBasePath,
    listingBasePath: options.listingBasePath.replace(/^\/+|\/+$/g, ''),
    listingDetailSuffix: options.listingDetailSuffix,
    staticPagePaths: options.staticPagePaths
  }).map(group => ({
    ...group,
    paths: sortPaths([
      ...group.paths,
      ...(options.additionalPathsByGroup?.[group.key] ?? []).map(path =>
        normalizeArtifactPath(path)
      )
    ]).filter(path => !excludedPaths.has(path))
  }))
  const indexOrder = options.indexGroupOrder
    ? new Map(options.indexGroupOrder.map((key, index) => [key, index]))
    : null
  const sitemapIndexEntries = groupedPaths
    .sort((left, right) => {
      if (!indexOrder) {
        return 0
      }

      return (
        (indexOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (indexOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER)
      )
    })
    .flatMap(group =>
      writeGroupSitemaps(
        artifactDir,
        options.baseUrl,
        group,
        pageSize,
        {
          defaultLastmod,
          lastmodByPath: options.lastmodByPath
        },
        options.sitemapPathByGroup?.[group.key]
      )
    )

  const sitemapIndexXml = buildSitemapIndexXml(options.baseUrl, sitemapIndexEntries, defaultLastmod)

  writeFileSync(resolve(artifactDir, SITEMAP_INDEX_PATH.slice(1)), sitemapIndexXml)
  writeFileSync(resolve(artifactDir, SITEMAP_COMPATIBILITY_PATH.slice(1)), sitemapIndexXml)
  pruneUnreferencedSitemapFiles(artifactDir, options.baseUrl)
}
