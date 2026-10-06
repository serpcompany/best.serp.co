import { urlKey } from '@serpdirectory/utils/url-key'

/**
 * The domain address of a claim (serpcompany/best.serp.co#67): the claimer proves they work at
 * the listed product by receiving a code at an address on its website's registrable domain.
 * `www.` and any subdomain normalize to that domain (`jordan@mail.brieflow.ai` claims
 * `https://www.brieflow.ai/`), using the Public Suffix List with its private section, so
 * `user.github.io` is its own site and a website on a shared host with no registrable domain
 * (`github.io` itself, an IP address) can't be claimed by email at all. Free webmail domains are
 * refused whatever the listing: nobody proves working at Gmail with a Gmail address.
 */

/**
 * Free webmail and consumer mailbox providers, by registrable domain. An address on one of
 * these never proves ownership, even when the listing is the provider itself.
 */
export const WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '126.com',
  '163.com',
  'aim.com',
  'aol.com',
  'comcast.net',
  'duck.com',
  'fastmail.com',
  'fastmail.fm',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'hey.com',
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.de',
  'hotmail.fr',
  'hushmail.com',
  'icloud.com',
  'inbox.com',
  'live.com',
  'mac.com',
  'mail.com',
  'mail.ru',
  'me.com',
  'msn.com',
  'naver.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.ch',
  'protonmail.com',
  'qq.com',
  'rocketmail.com',
  'sina.com',
  'tuta.io',
  'tutanota.com',
  'web.de',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.fr',
  'yandex.com',
  'yandex.ru',
  'ymail.com',
  'zoho.com',
  'zohomail.com'
])

/** A local part and domain as an address form accepts them (no quoted local parts). */
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/u

export type ClaimAddressProblem = 'domain_mismatch' | 'invalid_email' | 'webmail'

export type ClaimAddress =
  | { address: string; domain: string; ok: true }
  | { ok: false; problem: ClaimAddressProblem }

function registrable(host: string): string | null {
  try {
    const key = urlKey(`https://${host}/`)
    return key.coversSubdomains ? key.blockKey : null
  } catch {
    return null
  }
}

/** The listing website's registrable domain, or null when it has none (shared hosts, IPs). */
export function websiteClaimDomain(website: string): string | null {
  try {
    const key = urlKey(website)
    return key.coversSubdomains ? key.blockKey : null
  } catch {
    return null
  }
}

/**
 * Checks `email` against the listing `website`: a well-formed address, not webmail, whose
 * domain's registrable domain is the website's. Returns the normalized (lowercase) address and
 * that domain.
 */
export function checkClaimAddress(email: string, website: string): ClaimAddress {
  const address = email.trim().toLowerCase()
  if (address.length > 254) return { ok: false, problem: 'invalid_email' }
  const match = ADDRESS.exec(address)
  const host = match?.[1]
  if (!host) return { ok: false, problem: 'invalid_email' }
  const domain = registrable(host)
  if (!domain) return { ok: false, problem: 'invalid_email' }
  if (WEBMAIL_DOMAINS.has(domain)) return { ok: false, problem: 'webmail' }
  if (domain !== websiteClaimDomain(website)) return { ok: false, problem: 'domain_mismatch' }
  return { address, domain, ok: true }
}

/** The keys an active prohibited-URL block on this website would use. */
export function claimBlockKeys(website: string): string[] {
  try {
    const key = urlKey(website)
    return [...new Set([key.blockKey, key.hostKey])]
  } catch {
    return []
  }
}
