import { validatePublicHttpUrl } from './public-url'

/**
 * Reads a site's own metadata from its HTML: the title, description, site name, icons, and
 * social (Open Graph) image. Shared by media ingestion and the legacy media migration
 * (serpcompany/best.serp.co#95), which take a listing's logo from its site icon and its featured
 * image from its social image. Submit v2 (#84) carries the same parser in
 * `apps/web/src/lib/submissions/prefill.ts`; it should import this module instead once both are on
 * `staging` (its form-specific `proposeName` and `fitShortDescription` stay there).
 */

export type MetadataSource =
  | 'application-name'
  | 'meta description'
  | 'og:description'
  | 'og:site_name'
  | 'page title'
  | 'twitter:description'

export interface ProposedText {
  source: MetadataSource
  value: string
}

export interface IconCandidate {
  href: string
  /** The larger declared side; null for `any` or undeclared. */
  size: number | null
  touch: boolean
  vector: boolean
}

export interface SiteMetadata {
  applicationName: string | null
  description: ProposedText | null
  icons: IconCandidate[]
  ogSiteName: string | null
  socialImage: string | null
  title: string | null
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’'
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null
  const text = decodeEntities(value)
    // Control characters and the replacement character never belong in a listing.
    .replace(/[\p{Cc}�]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text || null
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu')
  )
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

/** An absolute public http(s) URL for `href` on the page at `base`, or null. */
export function absoluteUrl(href: string | null, base: string): string | null {
  const value = href?.trim()
  if (!value || value.startsWith('data:')) return null
  try {
    const url = new URL(decodeEntities(value), base)
    return validatePublicHttpUrl(url.toString()).ok ? url.toString() : null
  } catch {
    return null
  }
}

function declaredSize(sizes: string | null): number | null {
  if (!sizes) return null
  let largest: number | null = null
  for (const token of sizes.toLowerCase().split(/\s+/u)) {
    const match = token.match(/^(\d{1,5})x(\d{1,5})$/u)
    if (match) largest = Math.max(largest ?? 0, Math.min(Number(match[1]), Number(match[2])))
  }
  return largest
}

/** The document head (or the first 256 KB), where metadata lives. */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>|<body[\s>]/iu)
  return (end === -1 ? html : html.slice(0, end)).slice(0, 256_000)
}

export function parseSiteMetadata(html: string, pageUrl: string): SiteMetadata {
  const head = headOf(html)
  const meta = new Map<string, string>()
  for (const match of head.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0]
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name'))?.trim().toLowerCase()
    const content = attribute(tag, 'content')
    if (key && content !== null && !meta.has(key)) meta.set(key, content)
  }
  const icons: IconCandidate[] = []
  for (const match of head.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0]
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u)
    const touch = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')
    if (!touch && !rel.includes('icon')) continue
    const href = absoluteUrl(attribute(tag, 'href'), pageUrl)
    if (!href) continue
    const type = (attribute(tag, 'type') ?? '').toLowerCase()
    const vector = type === 'image/svg+xml' || /\.svg(?:[?#]|$)/iu.test(href)
    // An apple-touch-icon without `sizes` is 180 × 180 by convention.
    icons.push({
      href,
      size: declaredSize(attribute(tag, 'sizes')) ?? (touch ? 180 : null),
      touch,
      vector
    })
  }
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1] ?? null
  const descriptionSources: Array<[string, MetadataSource]> = [
    ['description', 'meta description'],
    ['og:description', 'og:description'],
    ['twitter:description', 'twitter:description']
  ]
  let description: ProposedText | null = null
  for (const [key, source] of descriptionSources) {
    const value = clean(meta.get(key))
    if (value) {
      description = { source, value }
      break
    }
  }
  return {
    applicationName: clean(meta.get('application-name')),
    description,
    icons,
    ogSiteName: clean(meta.get('og:site_name')),
    socialImage:
      absoluteUrl(meta.get('og:image:secure_url') ?? null, pageUrl) ??
      absoluteUrl(meta.get('og:image') ?? null, pageUrl) ??
      absoluteUrl(meta.get('twitter:image') ?? null, pageUrl),
    title: clean(title)
  }
}

/**
 * The target of a `<meta http-equiv="refresh" content="0; url=…">` redirect, which link
 * shorteners use instead of an HTTP redirect, as a public absolute URL, or null.
 */
export function metaRefreshUrl(html: string, pageUrl: string): string | null {
  for (const match of headOf(html).matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0]
    if ((attribute(tag, 'http-equiv') ?? '').trim().toLowerCase() !== 'refresh') continue
    const target = (attribute(tag, 'content') ?? '').match(/url\s*=\s*['"]?([^'"\s>]+)/iu)?.[1]
    return target ? absoluteUrl(target, pageUrl) : null
  }
  return null
}

export interface IconCandidateOptions {
  /** Well-known paths tried after the declared icons, in order. */
  fallbacks?: readonly string[]
  /** Declared icons smaller than this are skipped (an undeclared size is always tried). */
  minPixels?: number
  /** Whether SVG icons are candidates (hosted media never takes SVG). */
  vector?: boolean
}

/**
 * Site icons to try, best first: declared size (SVG counts as large when allowed), touch icons,
 * then the well-known fallbacks. The defaults are submit v2's: SVG allowed, 128 px, and
 * `/apple-touch-icon.png`.
 */
export function iconCandidates(
  metadata: SiteMetadata,
  pageUrl: string,
  options: IconCandidateOptions = {}
): string[] {
  const minPixels = options.minPixels ?? 128
  const allowVector = options.vector ?? true
  const ranked = metadata.icons
    .filter(icon => allowVector || !icon.vector)
    .sort((a, b) => {
      const size = (icon: IconCandidate) => (icon.vector ? 10_000 : (icon.size ?? 0))
      return size(b) - size(a) || Number(b.touch) - Number(a.touch)
    })
  const hrefs = ranked
    .filter(icon => icon.vector || icon.size === null || icon.size >= minPixels)
    .map(icon => icon.href)
  for (const path of options.fallbacks ?? ['/apple-touch-icon.png']) {
    const fallback = absoluteUrl(path, pageUrl)
    if (fallback) hrefs.push(fallback)
  }
  return [...new Set(hrefs)]
}
