import type { AuthRateLimitRule } from '@/db/auth'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * URL prefill limits (#63). Each prefill makes the Worker fetch the submitted page and up to
 * four images. Every caller counts against its client address (an IPv4 address or an IPv6
 * /64), and a signed-in caller also against their account, so many accounts behind one
 * address share that address's budget (PR #84 review round 1, finding 3). Several people can
 * share an address, so its hourly limit is looser than an account's.
 */
export const PREFILL_LIMITS = {
  burst: { max: 10, windowMs: MINUTE },
  ipHourly: { max: 60, windowMs: HOUR },
  userHourly: { max: 40, windowMs: HOUR }
} as const

export function prefillRateLimitRules(client: {
  ip: string
  userId: string | null
}): AuthRateLimitRule[] {
  const rules: AuthRateLimitRule[] = [
    { key: client.ip, scope: 'submission-prefill-ip', ...PREFILL_LIMITS.burst },
    { key: client.ip, scope: 'submission-prefill-ip', ...PREFILL_LIMITS.ipHourly }
  ]
  if (client.userId) {
    rules.push(
      { key: client.userId, scope: 'submission-prefill-user', ...PREFILL_LIMITS.burst },
      { key: client.userId, scope: 'submission-prefill-user', ...PREFILL_LIMITS.userHourly }
    )
  }
  return rules
}

/**
 * The outbound-fetch budget of badge checks (PR #84 review round 1, finding 2). Every check
 * fetches the submitter's site (up to four hops), and timeouts and server errors never use up
 * one of a submission's ten checks, so each attempt also counts here, whatever its result:
 * per submission (on top of the 30-second cooldown), per account (across its drafts), and per
 * client address (an IPv4 address or an IPv6 /64), so accounts are free but many of them
 * behind one address share its budget (round 2, finding 3). Several people can share an
 * address, so its limit is looser than an account's.
 */
export const BADGE_CHECK_LIMITS = {
  ipHourly: { max: 120, windowMs: HOUR },
  submissionHourly: { max: 20, windowMs: HOUR },
  userHourly: { max: 60, windowMs: HOUR }
} as const

export function badgeCheckRateLimitRules(input: {
  ip: string
  submissionId: string
  userId: string
}): AuthRateLimitRule[] {
  return [
    {
      key: input.submissionId,
      scope: 'badge-check-submission',
      ...BADGE_CHECK_LIMITS.submissionHourly
    },
    { key: input.userId, scope: 'badge-check-user', ...BADGE_CHECK_LIMITS.userHourly },
    { key: input.ip, scope: 'badge-check-ip', ...BADGE_CHECK_LIMITS.ipHourly }
  ]
}
