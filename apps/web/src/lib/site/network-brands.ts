/**
 * The brands `/brands/` lists (serpcompany/best.serp.co#193). Owner decision of 2026-10-09: the
 * same list as https://devinschumacher.com/brands/, plus devinschumacher.com itself, with no adult
 * EMD, no `*.pages.dev` mirror, and no link to this site.
 *
 * `data/devinschumacher-com-brands.json` is an unedited copy of the file that page renders, at the
 * commit in `NETWORK_BRANDS_SOURCE`. That list is not a set in the shared brand data
 * (serpcompany/serp `workers/brands-page/data/`): no set matches it. To update, copy the file
 * again and record its new commit; `scripts/network-brands.test.ts` compares the copy with that
 * commit in a devinschumacher.com checkout when there is one. This site's own rules stay here:
 * links to best.serp.co are dropped and devinschumacher.com is added.
 */
import sourceData from './data/devinschumacher-com-brands.json' with { type: 'json' }

export const NETWORK_BRANDS_SOURCE = {
  commit: '743d5fe376de1e87e6911a411fb281733dcd0daa',
  page: 'https://devinschumacher.com/brands/',
  path: 'lib/data/network-brands.json',
  repository: 'devinschumacher/devinschumacher.com'
} as const

/** best.serp.co's own hosts (`serp.best` is an alias of it): never listed here. */
export const SELF_HOSTNAMES: ReadonlySet<string> = new Set(['best.serp.co', 'serp.best'])

/** devinschumacher.com, with its name in the shared brand data. */
export const ADDED_NETWORK_BRANDS: Readonly<Record<string, RawNetworkBrand>> = {
  'devinschumacher-com': { name: 'Devin Schumacher', url: 'https://devinschumacher.com' }
}

export type NetworkBrandEntry = {
  hostname: string
  name: string
  slug: string
  url: string
}

/** A source record; its other fields (devinschumacher.com's description and logo) are unused. */
export type RawNetworkBrand = {
  name?: string
  url?: string
}

export type RawNetworkBrandsData = {
  brands?: Record<string, RawNetworkBrand>
}

export function getNetworkBrands(): NetworkBrandEntry[] {
  return selectNetworkBrands(sourceData)
}

/** The source list, without this site and with devinschumacher.com, sorted by name. */
export function selectNetworkBrands(data: RawNetworkBrandsData): NetworkBrandEntry[] {
  return parseNetworkBrands({ brands: { ...data.brands, ...ADDED_NETWORK_BRANDS } }).filter(
    brand => !SELF_HOSTNAMES.has(brand.hostname)
  )
}

export function parseNetworkBrands(data: RawNetworkBrandsData): NetworkBrandEntry[] {
  const seenUrls = new Map<string, string>()

  return Object.entries(data.brands ?? {})
    .map(([slug, brand]) => toNetworkBrandEntry(slug, brand, seenUrls))
    .sort(compareNetworkBrands)
}

function toNetworkBrandEntry(
  slug: string,
  brand: RawNetworkBrand,
  seenUrls: Map<string, string>
): NetworkBrandEntry {
  const cleanSlug = slug.trim()
  const name = brand.name?.trim()
  const url = brand.url?.trim()

  if (!cleanSlug) {
    throw new Error('Network brand slug must not be empty')
  }

  if (!name) {
    throw new Error(`Network brand "${cleanSlug}" must include a name`)
  }

  if (!url) {
    throw new Error(`Network brand "${cleanSlug}" must include a URL`)
  }

  const parsedUrl = parseBrandUrl(cleanSlug, url)
  const normalizedUrl = normalizeBrandUrl(parsedUrl)
  const existingSlug = seenUrls.get(normalizedUrl)

  if (existingSlug) {
    throw new Error(
      `Duplicate network brand URL "${url}" for "${cleanSlug}" duplicates "${existingSlug}"`
    )
  }

  seenUrls.set(normalizedUrl, cleanSlug)

  return {
    hostname: parsedUrl.hostname,
    name,
    slug: cleanSlug,
    url
  }
}

function parseBrandUrl(slug: string, value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported protocol')
    }
    return url
  } catch {
    throw new Error(`Invalid network brand URL for "${slug}": ${value}`)
  }
}

function normalizeBrandUrl(url: URL): string {
  const normalized = new URL(url.toString())
  normalized.hash = ''
  normalized.search = ''
  normalized.pathname = normalized.pathname.replace(/\/+$/g, '')

  return normalized.toString().replace(/\/+$/g, '').toLowerCase()
}

function compareNetworkBrands(first: NetworkBrandEntry, second: NetworkBrandEntry): number {
  return (
    first.name.localeCompare(second.name) ||
    first.hostname.localeCompare(second.hostname) ||
    first.slug.localeCompare(second.slug)
  )
}
