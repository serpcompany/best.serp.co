/**
 * Abuse limits for sign-in codes (serpcompany/best.serp.co#60), enforced in D1 by
 * `consumeRateLimit` in `@serpdirectory/data-ops/auth`: isolates share no memory, so nothing is
 * counted in memory. Each code also allows at most `OTP_ALLOWED_ATTEMPTS` guesses (Better Auth
 * stores the attempt count with the code and deletes the code after the last one), and only
 * from the browser that requested it (`code-binding.ts`).
 *
 * A client is an IPv4 address or an IPv6 /64 (one host's usual allocation). Two kinds of limit
 * apply to every code request:
 *
 * - Per client (`otpClientRules`): the same for every email, so a 429 reveals nothing about
 *   the email. These are the only code-request limits that answer 429.
 * - Per email (`otpEmailRules`), chosen by the email's standing. A denial here answers the
 *   same 200 as a sent code and sends nothing, so the limits never reveal whether an email
 *   has an account (review round 3, finding 3):
 *   - `new` (no verified account): one budget per email, and the site-wide hourly ceiling,
 *     which bounds mail to arbitrary addresses (cost and sender reputation).
 *   - `member` (a verified account, from a browser without its known-device cookie): the
 *     cooldown and hourly limit count per email and client, under an email-wide ceiling that
 *     bounds how many codes reach the inbox. Never the site-wide ceiling.
 *   - `known-device` (the request carries this account's known-device cookie,
 *     `known-device.ts`): per email and client, under a separate email-wide ceiling that no
 *     request without the cookie can spend, so other clients cannot stop it and a stolen
 *     cookie cannot remove the inbox cap.
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
  /** A member's inbox, across every client with its known-device cookie. */
  knownDeviceEmailHourly: { max: 10, windowMs: HOUR },
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

/** Limits on the requesting client, the same for every email. A denial answers 429. */
export function otpClientRules(ip: string): AuthRateLimitRule[] {
  const limits = OTP_REQUEST_LIMITS
  return [
    { scope: 'otp-ip', key: ip, ...limits.ipBurst },
    { scope: 'otp-ip', key: ip, ...limits.ipHourly }
  ]
}

/** Limits on the email, by its standing. A denial answers 200 and sends nothing. */
export function otpEmailRules({ email, ip, standing }: OtpRequestContext): AuthRateLimitRule[] {
  const limits = OTP_REQUEST_LIMITS
  if (standing === 'new') {
    return [
      { scope: 'otp-email', key: email, ...limits.emailCooldown },
      { scope: 'otp-email', key: email, ...limits.emailHourly },
      { scope: 'otp-site', key: 'all', ...limits.siteHourly }
    ]
  }
  const perEmailAndClient = [
    { scope: 'otp-email-client', key: `${email}\0${ip}`, ...limits.emailCooldown },
    { scope: 'otp-email-client', key: `${email}\0${ip}`, ...limits.emailHourly }
  ]
  return standing === 'member'
    ? [...perEmailAndClient, { scope: 'otp-email', key: email, ...limits.memberEmailHourly }]
    : [
        ...perEmailAndClient,
        { scope: 'otp-email-known-device', key: email, ...limits.knownDeviceEmailHourly }
      ]
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

/** True for 240.0.0.0/4 (Class E), the range Cloudflare's Pseudo IPv4 addresses come from. */
function isPseudoIpv4(address: string): boolean {
  return IPV4_PATTERN.test(address) && Number(address.split('.')[0]) >= 240
}

/**
 * The client of a request. Cloudflare sets `cf-connecting-ip` on every request that reaches
 * the Worker. Only when the zone's Pseudo IPv4 overwrites headers does that header hold a
 * Class E address hashed from the client's IPv6 address, with the real address in
 * `cf-connecting-ipv6`; then the IPv6 /64 is the client. Otherwise `cf-connecting-ipv6` may
 * come from the client itself, so it is ignored (review round 3, finding 2): trusting it would
 * let any client choose its own rate-limit key.
 */
export function clientIp(headers: Headers | undefined): string {
  const address = rateLimitAddress(headers?.get('cf-connecting-ip'))
  if (!isPseudoIpv4(address)) return address
  const ipv6 = rateLimitAddress(headers?.get('cf-connecting-ipv6'))
  return ipv6.endsWith('::/64') ? ipv6 : address
}
