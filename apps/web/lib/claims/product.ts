import { safeFetch } from '@serpdirectory/data-ops/safe-fetch'
import { urlKey } from '@serpdirectory/utils/url-key'

/**
 * The product's own site, which a claim proves (serpcompany/best.serp.co#67, #108 review round
 * 1). Most imported listings store a `serp.ly` affiliate link as their website (2,942 of 3,005),
 * so the website's domain is SERP's, not the product's. As the owner decided for search (match on
 * the product slug, never the `serp.ly` host), the product's domain is, in order:
 *
 * 1. the slug, when it is a host with a registrable domain (`jasper.ai`);
 * 2. the website, when it is the product's own (not SERP's, not a link shortener or affiliate
 *    network);
 * 3. where the website lands: the link is followed server-side through the shared safe fetcher
 *    (HTTP redirects, then up to two `<meta http-equiv="refresh">` hops, as `serp.ly` answers),
 *    and the landing page's domain counts unless it is SERP's or another redirector.
 *
 * Otherwise there is no product domain and the listing can't be claimed. SERP's own domains are
 * never a claim domain, so `@serp.ly` mail never proves anything.
 */

/** SERP's own sites (`scripts/listing-domain-classifier.ts`). */
export const SERP_DOMAINS: ReadonlySet<string> = new Set([
  'serp.ai',
  'serp.co',
  'serp.ly',
  'serp.software',
  'serpdownloaders.com'
])

/** Link shorteners and affiliate networks a listing link passes through. */
const REDIRECTOR_DOMAINS: ReadonlySet<string> = new Set([
  '7eer.net',
  'anrdoezrs.net',
  'awin1.com',
  'bit.ly',
  'clickbank.net',
  'dpbolvw.net',
  'dub.co',
  'dub.sh',
  'evyy.net',
  'go2cloud.org',
  'gopjn.com',
  'impact.com',
  'jdoqocy.com',
  'kqzyfj.com',
  'linksynergy.com',
  'ojrq.net',
  'partnerlinks.io',
  'pntrac.com',
  'prf.hn',
  'pxf.io',
  'rebrand.ly',
  'shareasale.com',
  'sjv.io',
  't.co',
  'tinyurl.com',
  'tkqlhce.com'
])

/** True for a domain that can never be a product's claim domain. */
export function isForeignDomain(domain: string): boolean {
  return SERP_DOMAINS.has(domain) || REDIRECTOR_DOMAINS.has(domain)
}

/** The registrable domain of a URL's host, or null (shared hosts, IPs, bad URLs). */
export function registrableOf(url: string): string | null {
  try {
    const key = urlKey(url)
    return key.coversSubdomains ? key.blockKey : null
  } catch {
    return null
  }
}

export interface ProductSite {
  /** The registrable domain claim addresses must be on. */
  domain: string
  /** The page the badge must be on. */
  url: string
}

/** Where a link lands, following `meta refresh` hops; null when it can't be loaded. */
export type ResolveLanding = (url: string) => Promise<string | null>

/**
 * The product's site from what the listing stores, without the network, or null. The website
 * page counts when it is on the product's domain (a submitted listing's own site, with its
 * scheme and port); otherwise the slug's host.
 */
export function storedProductSite(listing: { slug: string; website: string }): ProductSite | null {
  const websiteDomain = registrableOf(listing.website)
  const ownWebsite = websiteDomain && !isForeignDomain(websiteDomain) ? websiteDomain : null
  if (listing.slug.includes('.')) {
    try {
      const key = urlKey(`https://${listing.slug}/`)
      if (key.coversSubdomains && !isForeignDomain(key.blockKey)) {
        return key.blockKey === ownWebsite
          ? { domain: key.blockKey, url: listing.website }
          : { domain: key.blockKey, url: `https://${key.hostKey}/` }
      }
    } catch {
      // Not a host name: fall through.
    }
  }
  return ownWebsite ? { domain: ownWebsite, url: listing.website } : null
}

/** The product's site: stored, else where the website's link lands. */
export async function productSite(
  listing: { slug: string; website: string },
  resolveLanding: ResolveLanding
): Promise<ProductSite | null> {
  const stored = storedProductSite(listing)
  if (stored) return stored
  if (!registrableOf(listing.website)) return null
  const landing = await resolveLanding(listing.website)
  const domain = landing ? registrableOf(landing) : null
  if (!landing || !domain || isForeignDomain(domain)) return null
  return { domain, url: `${new URL(landing).origin}/` }
}

const MAX_REFRESH_HOPS = 2
const LANDING_MAX_BYTES = 256_000

/** A `<meta http-equiv="refresh" content="0; url=…">` target, resolved against the page. */
export function metaRefreshTarget(html: string, pageUrl: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    if (!/http-equiv\s*=\s*["']?refresh/iu.test(tag)) continue
    const target = /content\s*=\s*["'][^"']*?url\s*=\s*['"]?([^"'>\s;]+)/iu.exec(
      tag.replaceAll('&amp;', '&')
    )?.[1]
    if (!target) continue
    try {
      return new URL(target, pageUrl).toString()
    } catch {
      return null
    }
  }
  return null
}

/** Follows a listing link to its landing page through the shared safe fetcher. */
export function safeResolveLanding(fetcher: typeof fetch = fetch): ResolveLanding {
  return async url => {
    let current = url
    for (let hop = 0; hop <= MAX_REFRESH_HOPS; hop += 1) {
      const page = await safeFetch(current, {
        accept: type => type === 'text/html',
        acceptHeader: 'text/html',
        fetcher,
        maxBytes: LANDING_MAX_BYTES
      })
      if (!page.ok) return null
      const next = metaRefreshTarget(new TextDecoder().decode(page.body), page.url)
      if (!next || next === page.url || hop === MAX_REFRESH_HOPS) return page.url
      current = next
    }
    return null
  }
}

/**
 * A fetcher for the badge check that refuses every request off the claim domain, so a redirect
 * can't move the check to a page someone else controls (#108 review round 1, finding 4).
 * `left()` tells whether it refused one.
 */
export function domainPinnedFetcher(
  domain: string,
  fetcher: typeof fetch = fetch
): { fetch: typeof fetch; left(): boolean } {
  let refused = false
  const pinned = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (registrableOf(url) !== domain) {
      refused = true
      throw new TypeError('The badge page left the claim domain.')
    }
    return fetcher(input, init)
  }) as typeof fetch
  return { fetch: pinned, left: () => refused }
}
