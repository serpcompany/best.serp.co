const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  '::',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata'
])

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local']

const URL_ERROR = {
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

function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4(ip)
  if (!octets) return false
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateIPv6(ip: string): boolean {
  const value = ip.toLowerCase()
  if (value === '::1' || value === '::') return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (/^fe[89ab]/u.test(value)) return true
  if (!value.startsWith('::ffff:')) return false

  const mapped = value.slice('::ffff:'.length)
  if (mapped.includes('.')) return isPrivateIPv4(mapped)
  const hexParts = mapped.split(':')
  if (hexParts.length !== 2) return false
  const high = Number.parseInt(hexParts[0] || '', 16)
  const low = Number.parseInt(hexParts[1] || '', 16)
  if (!Number.isInteger(high) || !Number.isInteger(low) || high > 0xffff || low > 0xffff)
    return false
  return isPrivateIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
}

function isRestrictedHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.$/u, '')
    .toLowerCase()
  if (!normalized) return true
  if (BLOCKED_HOSTNAMES.has(normalized)) return true
  if (BLOCKED_HOST_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return true
  if (parseIPv4(normalized)) return isPrivateIPv4(normalized)
  if (normalized.includes(':')) return isPrivateIPv6(normalized)
  return false
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
  if (isRestrictedHost(parsed.hostname)) {
    return { ok: false, error: URL_ERROR.RESTRICTED_HOST }
  }
  return { ok: true, url: parsed }
}

export const URL_VALIDATION_ERRORS = URL_ERROR
