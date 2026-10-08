import networkBrandsData from './data/network-brands.json' with { type: 'json' }

export type NetworkBrandEntry = {
  hostname: string
  name: string
  slug: string
  url: string
}

type RawNetworkBrand = {
  name?: string
  url?: string
}

type RawNetworkBrandsData = {
  brandGroups?: Record<string, string[]>
  brands?: Record<string, RawNetworkBrand>
}

export function getNetworkBrands(): NetworkBrandEntry[] {
  return parseNetworkBrands(networkBrandsData)
}

export function getNetworkBrandsForGroup(
  groupSlug: string | null | undefined
): NetworkBrandEntry[] {
  if (!groupSlug) {
    return getNetworkBrands()
  }

  return parseNetworkBrandGroup(networkBrandsData, groupSlug)
}

export function parseNetworkBrands(data: RawNetworkBrandsData): NetworkBrandEntry[] {
  const brands = data.brands ?? {}
  const seenUrls = new Map<string, string>()

  return Object.entries(brands)
    .map(([slug, brand]) => toNetworkBrandEntry(slug, brand, seenUrls))
    .sort(compareNetworkBrands)
}

export function parseNetworkBrandGroup(
  data: RawNetworkBrandsData,
  groupSlug: string
): NetworkBrandEntry[] {
  const group = data.brandGroups?.[groupSlug]

  if (!group) {
    throw new Error(`Network brand group "${groupSlug}" does not exist`)
  }

  const seenUrls = new Map<string, string>()

  return group
    .map(slug => {
      const brand = data.brands?.[slug]

      if (!brand) {
        throw new Error(`Network brand group "${groupSlug}" references missing brand "${slug}"`)
      }

      return toNetworkBrandEntry(slug, brand, seenUrls)
    })
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
