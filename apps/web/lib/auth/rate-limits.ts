/**
 * Abuse limits for sign-in codes (serpcompany/best.serp.co#60), enforced in D1 by
 * `consumeRateLimit` in `@serpdirectory/data-ops/auth`: isolates share no memory, so nothing is
 * counted in memory. Each code also allows at most `OTP_ALLOWED_ATTEMPTS` guesses (Better Auth
 * stores the attempt count with the code and deletes the code after the last one).
 *
 * A client is an IPv4 address or an IPv6 /64 (one host's usual allocation). Every request is
 * limited per client. What else applies depends on the email's standing:
 *
 * - `new` (no verified account): one budget per email, and the site-wide hourly ceiling,
 *   which bounds mail to arbitrary addresses (cost and sender reputation).
 * - `member` (a verified account, from a browser that has not signed in to it): the cooldown
 *   and hourly limit count per email and client, under an email-wide ceiling that bounds how
 *   many codes reach the inbox. Never the site-wide ceiling.
 * - `known-device` (the request carries this account's known-device cookie, `known-device.ts`):
 *   per email and client only, so no amount of requests from other clients can stop it.
 */
import type { AuthRateLimitRule } from '@serpdirectory/data-ops/auth'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** Six digits, valid for ten minutes, three guesses each. */
export const OTP_LENGTH = 6
export const OTP_EXPIRES_IN_SECONDS = 10 * 60
export const OTP_ALLOWED_ATTEMPTS = 3

export const OTP_REQUEST_LIMITS = {
  /** One code a minute and five an hour, per email (new) or per email and client (members). */
  emailCooldown: { max: 1, windowMs: MINUTE },
  emailHourly: { max: 5, windowMs: HOUR },
  /** A member's inbox, across every client without its known-device cookie. */
  memberEmailHourly: { max: 20, windowMs: HOUR },
  /** Several people can share an IP address, so its limits are looser. */
  ipBurst: { max: 5, windowMs: MINUTE },
  ipHourly: { max: 20, windowMs: HOUR },
  /** Codes to emails with no verified account, across the whole site. */
  siteHourly: { max: 300, windowMs: HOUR }
} as const

export const SIGN_IN_ATTEMPT_LIMITS = {
  /** Code guesses per client address, on top of the per-code attempt cap. */
  ipBurst: { max: 10, windowMs: MINUTE },
  ipHourly: { max: 60, windowMs: HOUR }
} as const

/** Requests that carry no valid client IP share one bucket, which fails safe (stricter). */
export const UNKNOWN_IP = 'unknown'

export type EmailStanding = 'known-device' | 'member' | 'new'

export interface OtpRequestContext {
  email: string
  ip: string
  standing: EmailStanding
}

export function otpRequestRules({ email, ip, standing }: OtpRequestContext): AuthRateLimitRule[] {
  const limits = OTP_REQUEST_LIMITS
  const perClient = [
    { scope: 'otp-ip', key: ip, ...limits.ipBurst },
    { scope: 'otp-ip', key: ip, ...limits.ipHourly }
  ]
  if (standing === 'new') {
    return [
      { scope: 'otp-email', key: email, ...limits.emailCooldown },
      { scope: 'otp-email', key: email, ...limits.emailHourly },
      ...perClient,
      { scope: 'otp-site', key: 'all', ...limits.siteHourly }
    ]
  }
  const perEmailAndClient = [
    { scope: 'otp-email-client', key: `${email}\0${ip}`, ...limits.emailCooldown },
    { scope: 'otp-email-client', key: `${email}\0${ip}`, ...limits.emailHourly }
  ]
  return standing === 'member'
    ? [
        ...perEmailAndClient,
        { scope: 'otp-email', key: email, ...limits.memberEmailHourly },
        ...perClient
      ]
    : [...perEmailAndClient, ...perClient]
}

export function signInAttemptRules(ip: string): AuthRateLimitRule[] {
  const limits = SIGN_IN_ATTEMPT_LIMITS
  return [
    { scope: 'sign-in-ip', key: ip, ...limits.ipBurst },
    { scope: 'sign-in-ip', key: ip, ...limits.ipHourly }
  ]
}

const IPV4_PATTERN =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u
const IPV6_GROUP_PATTERN = /^[0-9a-f]{1,4}$/u

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail becomes two), or null. */
function ipv6Groups(address: string): number[] | null {
  let value = address
  const lastColon = value.lastIndexOf(':')
  const embedded = value.slice(lastColon + 1)
  if (embedded.includes('.')) {
    if (!IPV4_PATTERN.test(embedded)) return null
    const [a = 0, b = 0, c = 0, d = 0] = embedded.split('.').map(Number)
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  const present = [...head, ...rest]
  if (!present.every(group => IPV6_GROUP_PATTERN.test(group))) return null
  if (halves.length === 1 ? present.length !== 8 : present.length > 7) return null
  const zeros = Array<string>(8 - present.length).fill('0')
  const groups = halves.length === 2 ? [...head, ...zeros, ...rest] : present
  return groups.map(group => Number.parseInt(group, 16))
}

/**
 * The client-address key the limits count: an IPv4 address as is, an IPv4-mapped IPv6 address
 * as its IPv4 address, any other IPv6 address as its /64 prefix, and anything that is not an IP
 * address as `UNKNOWN_IP`.
 */
export function rateLimitAddress(value: string | null | undefined): string {
  const address = value?.trim().toLowerCase() ?? ''
  if (!address) return UNKNOWN_IP
  if (IPV4_PATTERN.test(address)) return address
  const groups = address.includes(':') ? ipv6Groups(address) : null
  if (!groups) return UNKNOWN_IP
  const [, , , , , marker = 0, high = 0, low = 0] = groups
  if (groups.slice(0, 5).every(group => group === 0) && marker === 0xffff) {
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return `${groups
    .slice(0, 4)
    .map(group => group.toString(16))
    .join(':')}::/64`
}

/**
 * Cloudflare sets `cf-connecting-ip` on every request that reaches the Worker. If the zone's
 * Pseudo IPv4 is set to overwrite headers, that header holds a per-address Class E IPv4 hashed
 * from the IPv6 address and `cf-connecting-ipv6` holds the real one, so the IPv6 header wins
 * whenever it is present: its /64 is the client either way.
 */
export function clientIp(headers: Headers | undefined): string {
  const ipv6 = headers?.get('cf-connecting-ipv6')
  if (ipv6?.trim()) {
    const address = rateLimitAddress(ipv6)
    if (address !== UNKNOWN_IP) return address
  }
  return rateLimitAddress(headers?.get('cf-connecting-ip'))
}
