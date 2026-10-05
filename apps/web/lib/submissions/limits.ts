import type { AuthRateLimitRule } from '@serpdirectory/data-ops/auth'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * URL prefill limits (#63). Each prefill makes the Worker fetch the submitted page and up to
 * four images, so it is limited per signed-in user, or per client address (an IPv4 address or
 * IPv6 /64) for visitors filling in the form before signing in. Several people can share an
 * address, so its hourly limit is looser.
 */
export const PREFILL_LIMITS = {
  burst: { max: 10, windowMs: MINUTE },
  ipHourly: { max: 60, windowMs: HOUR },
  userHourly: { max: 40, windowMs: HOUR }
} as const

export function prefillRateLimitRules(
  client: { ip: string } | { userId: string }
): AuthRateLimitRule[] {
  if ('userId' in client) {
    return [
      { key: client.userId, scope: 'submission-prefill-user', ...PREFILL_LIMITS.burst },
      { key: client.userId, scope: 'submission-prefill-user', ...PREFILL_LIMITS.userHourly }
    ]
  }
  return [
    { key: client.ip, scope: 'submission-prefill-ip', ...PREFILL_LIMITS.burst },
    { key: client.ip, scope: 'submission-prefill-ip', ...PREFILL_LIMITS.ipHourly }
  ]
}
