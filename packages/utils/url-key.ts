import { getDomain } from 'tldts'

/**
 * The keys that identify a submitted website (serpcompany/best.serp.co#62, #59 owner decision
 * of 2026-10-06). Shared by submission intake, the duplicate check, and the prohibited-URL block.
 *
 * - `hostKey`: the normalized host. It is the submission slug and the duplicate key.
 * - `blockKey`: the registrable domain of `hostKey` (eTLD+1 per the Public Suffix List, private
 *   section included, so `user.github.io` and `app.vercel.app` are sites of their own). A
 *   prohibited rejection blocks it and every subdomain. An IP address or a host that is itself a
 *   public suffix has no registrable domain and is its own block key.
 */
export interface UrlKey {
  blockKey: string
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
  return { blockKey: registrableDomain(host) ?? host, hostKey: host }
}

/** True when `host` is `domain` or one of its subdomains (the block-key match). */
export function isHostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}
