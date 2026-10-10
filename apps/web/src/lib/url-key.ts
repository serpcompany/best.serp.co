import { getDomain } from 'tldts'

/**
 * The keys that identify a submitted website (serpcompany/best.serp.co#62, #59 owner decision
 * of 2026-10-06). Shared by submission intake, the duplicate check, and the prohibited-URL block.
 *
 * - `hostKey`: the normalized host. It is the submission slug and the duplicate key.
 * - `blockKey`: the registrable domain of `hostKey` (eTLD+1 per the Public Suffix List, private
 *   section included, so `user.github.io` and `app.vercel.app` are sites of their own). A
 *   prohibited rejection blocks it and every subdomain (`coversSubdomains`). The list comes from
 *   `tldts` (about 46 KB gzipped and no Node APIs, so it runs in the Worker); SQLite cannot
 *   evaluate it, so intake stores the key.
 * - A host with no registrable domain (a public suffix such as `github.io`, or an IP address) is
 *   its own block key, and a block on it covers that exact host only, never the sites under it.
 */
export interface UrlKey {
  blockKey: string
  coversSubdomains: boolean
  hostKey: string
}

const pslOptions = { allowPrivateDomains: true } as const

function registrableDomain(host: string): string | null {
  if (host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return null
  return getDomain(host, pslOptions)
}

/**
 * Normalizes a website URL. The WHATWG URL parser (also the one in workerd) already
 * percent-decodes the host, maps it through IDNA to punycode, and lowercases it, so
 * `https://CASINO.com%2E/`, `https://ｃａｓｉｎｏ.com/`, and `https://casino.com./` all reach
 * `casino.com` once trailing dots are removed. A leading `www.` is removed when the rest is
 * still a registrable host (`www.com` stays as it is).
 */
export function urlKey(website: string): UrlKey {
  let host = new URL(website).hostname.replace(/\.+$/u, '')
  if (host.startsWith('www.')) {
    const rest = host.slice(4)
    if (registrableDomain(rest) !== null) host = rest
  }
  if (!host || host.startsWith('.')) throw new Error('A website URL needs a host name.')
  const registrable = registrableDomain(host)
  return registrable === null
    ? { blockKey: host, coversSubdomains: false, hostKey: host }
    : { blockKey: registrable, coversSubdomains: true, hostKey: host }
}

/**
 * The spellings of a website URL that the "already listed" check treats as the same website
 * (#64 review): http or https, the host with and without a leading `www.` (the host is
 * `urlKey`'s), and the path with and without a trailing slash, all without the query and
 * fragment. `listings.website` stores a URL as it was entered, so `listingWebsiteMatch` in
 * `src/db` compares the stored value with the URL as given, with each spelling, and with each
 * spelling followed by any query or fragment. Shared by submission intake and the admin website
 * edit, so both match the same listings.
 */
export function websiteSpellings(website: string): string[] {
  const url = new URL(website)
  const { hostKey } = urlKey(website)
  const port = url.port ? `:${url.port}` : ''
  const path = url.pathname.replace(/\/+$/u, '')
  const spellings: string[] = []
  for (const scheme of ['https', 'http']) {
    for (const host of [hostKey, `www.${hostKey}`]) {
      for (const tail of [path, `${path}/`]) spellings.push(`${scheme}://${host}${port}${tail}`)
    }
  }
  return spellings
}

/** True when a block on `key` (with its scope) covers `host`: the trigger's match. */
export function isHostBlocked(
  host: string,
  block: { coversSubdomains: boolean; key: string }
): boolean {
  return host === block.key || (block.coversSubdomains && host.endsWith(`.${block.key}`))
}
