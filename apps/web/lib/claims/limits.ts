import type { AuthRateLimitRule } from '@serpdirectory/data-ops/auth'

const HOUR = 60 * 60_000

/**
 * Claim code sends (#67): each sends an email to an address the claimer typed, so they count per
 * account and per client address (an IPv4 address or an IPv6 /64), on top of the per-claim
 * 60-second resend cooldown. Badge checks of a claim share the badge step's outbound budget
 * (`badgeCheckRateLimitRules`, keyed by the claim).
 */
export const CLAIM_CODE_LIMITS = {
  ipHourly: { max: 20, windowMs: HOUR },
  userHourly: { max: 10, windowMs: HOUR }
} as const

export function claimCodeRateLimitRules(input: {
  ip: string
  userId: string
}): AuthRateLimitRule[] {
  return [
    { key: input.userId, scope: 'claim-code-user', ...CLAIM_CODE_LIMITS.userHourly },
    { key: input.ip, scope: 'claim-code-ip', ...CLAIM_CODE_LIMITS.ipHourly }
  ]
}
