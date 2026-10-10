/**
 * The public-URL policy for every URL the Worker may fetch for a submitter (badge checks, URL
 * prefill, logo checks) and every URL a submission may store.
 *
 * It is a policy on the URL's text: WHATWG URL parsing first canonicalizes the host (IDNA,
 * percent-decoding, and alternate IPv4 forms such as `0x7f.1` or `2130706433` become dotted
 * quads), then IP literals in private, reserved, or translation ranges and local-only names are
 * refused, and so are URLs carrying credentials. A public hostname that *resolves* to a private
 * address is not caught here: the Worker relies on Cloudflare's egress, which never reaches
 * private ranges, for that (docs/submission-flow.md). The fetcher applies the policy to every
 * redirect hop.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata'
])

/** Names that only resolve inside a network (RFC 6761, RFC 8375, and common internal zones). */
const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.home.arpa',
  '.intranet',
  '.lan'
]

const URL_ERROR = {
  CREDENTIALS: 'URL contains credentials',
  FORMAT: 'Invalid URL format',
  PROTOCOL: 'Invalid URL protocol',
  RESTRICTED_HOST: 'URL points to a restricted network address'
} as const

function parseIPv4(ip: string): number[] | null {
  const octets = ip.split('.')
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/u.test(octet))) return null
  const parsed = octets.map(Number)
  return parsed.some(octet => octet < 0 || octet > 255) ? null : parsed
}

/** Private, shared, loopback, link-local, documentation, benchmark, and reserved IPv4 ranges. */
function isRestrictedIPv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail becomes two), or null. */
export function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const octets = parseIPv4(tail)
    if (!octets) return null
    const [a = 0, b = 0, c = 0, d = 0] = octets
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  const present = [...head, ...rest]
  if (!present.every(group => /^[0-9a-f]{1,4}$/u.test(group))) return null
  if (halves.length === 1 ? present.length !== 8 : present.length > 7) return null
  const zeros = Array<string>(8 - present.length).fill('0')
  const groups = halves.length === 2 ? [...head, ...zeros, ...rest] : present
  return groups.map(group => Number.parseInt(group, 16))
}

function ipv4FromGroups(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/**
 * Loopback, unspecified, unique-local, link-local, site-local, multicast, and documentation
 * IPv6 ranges, and every form that carries an IPv4 address (mapped, compatible, NAT64, 6to4,
 * Teredo), which is refused when that address is, and for the translation prefixes always.
 */
function isRestrictedIPv6(address: string): boolean {
  const groups = ipv6Groups(address)
  if (!groups) return true
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const upperZero = [g0, g1, g2, g3, g4].every(group => group === 0)
  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d: always refused.
  if (upperZero && g5 === 0) return true
  // IPv4-mapped ::ffff:a.b.c.d: refused when the IPv4 address is.
  if (upperZero && g5 === 0xffff) return isRestrictedIPv4(ipv4FromGroups(g6, g7))
  // IPv4-translated ::ffff:0:a.b.c.d.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true
  if (g0 === 0x64 && g1 === 0xff9b) return true // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g0 === 0x2002) return true // 6to4
  if (g0 === 0x2001 && g1 === 0) return true // Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true // multicast ff00::/8
  return false
}

function isRestrictedHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.+$/u, '')
    .toLowerCase()
  if (!normalized) return true
  if (BLOCKED_HOSTNAMES.has(normalized)) return true
  if (BLOCKED_HOST_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return true
  if (normalized.includes(':')) return isRestrictedIPv6(normalized)
  const ipv4 = parseIPv4(normalized)
  if (ipv4) return isRestrictedIPv4(ipv4)
  // A name of digits and dots that is not a dotted quad is never a public host.
  return /^[\d.]+$/u.test(normalized)
}

export type PublicUrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: (typeof URL_ERROR)[keyof typeof URL_ERROR] }

/**
 * Environment-neutral validation for every URL that the Worker may fetch.
 * WHATWG URL parsing canonicalizes alternate IP literal forms before the
 * private/local network policy is evaluated.
 */
export function validatePublicHttpUrl(value: string): PublicUrlValidationResult {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: URL_ERROR.FORMAT }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: URL_ERROR.PROTOCOL }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: URL_ERROR.CREDENTIALS }
  }
  if (isRestrictedHost(parsed.hostname)) {
    return { ok: false, error: URL_ERROR.RESTRICTED_HOST }
  }
  return { ok: true, url: parsed }
}

export const URL_VALIDATION_ERRORS = URL_ERROR
