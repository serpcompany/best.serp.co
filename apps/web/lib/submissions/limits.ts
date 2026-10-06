import type { AuthRateLimitRule } from '@serpdirectory/data-ops/auth'

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
 * per submission (on top of the 30-second cooldown) and per account (across its drafts).
 */
export const BADGE_CHECK_LIMITS = {
  submissionHourly: { max: 20, windowMs: HOUR },
  userHourly: { max: 60, windowMs: HOUR }
} as const

export function badgeCheckRateLimitRules(input: {
  submissionId: string
  userId: string
}): AuthRateLimitRule[] {
  return [
    {
      key: input.submissionId,
      scope: 'badge-check-submission',
      ...BADGE_CHECK_LIMITS.submissionHourly
    },
    { key: input.userId, scope: 'badge-check-user', ...BADGE_CHECK_LIMITS.userHourly }
  ]
}
