/**
 * Dub partner attribution on SERP's own short links (#169; serp
 * docs/engineering/websites/features/dub-partner-outlink-tracking.md): every `serp.ly` link the
 * site renders carries `?via=<the site's Dub partner ID>` (`site.analytics.dubPartnerId`).
 *
 * Any other URL, a link that already names a `via`, and anything without a partner ID are
 * returned unchanged. Structured data keeps the plain URL: `via` belongs on links people click.
 */
import { siteConfig } from '../site/site-config'

const DUB_SHORT_LINK_HOST = 'serp.ly'

export function withDubVia(
  url: string,
  partnerId: string | null = siteConfig.dubPartnerId ?? null
): string {
  const via = partnerId?.trim()
  if (!via) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.hostname !== DUB_SHORT_LINK_HOST ||
    parsed.searchParams.has('via')
  ) {
    return url
  }
  // Appended, so an existing query keeps its exact encoding.
  const query = `${parsed.search}${parsed.search ? '&' : '?'}via=${encodeURIComponent(via)}`
  return `${parsed.origin}${parsed.pathname}${query}${parsed.hash}`
}
