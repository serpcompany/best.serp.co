import { getDomain } from 'tldts'

/**
 * The keys that identify a submitted website (serpcompany/best.serp.co#62, #59 owner decision
 * of 2026-10-06). Shared by submission intake, the duplicate check, and the prohibited-URL block.
 *
 * - `hostKey`: the normalized host. It is the submission slug and the duplicate key.
 * - `blockKey`: the registrable domain of `hostKey` (eTLD+1 per the Public Suffix List, private
 *   section included, so `user.github.io` and `app.vercel.app` are sites of their own). A
 *   prohibited rejection blocks it and every subdomain (`coversSubdomains`).
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

/** True when a block on `key` (with its scope) covers `host`: the trigger's match. */
export function isHostBlocked(
  host: string,
  block: { coversSubdomains: boolean; key: string }
): boolean {
  return host === block.key || (block.coversSubdomains && host.endsWith(`.${block.key}`))
}
