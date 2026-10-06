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

/**
 * Caps per recipient address, per domain, and per listing (#108 review round 1), so several
 * accounts and addresses together can't keep mailing one company's people: 3 codes an hour to one
 * address, 10 to one domain, 10 for one listing. Keys are hashed before they are stored
 * (`auth_rate_limit_hits` is pseudonymous).
 */
export const CLAIM_RECIPIENT_LIMITS = {
  addressHourly: { max: 3, windowMs: HOUR },
  domainHourly: { max: 10, windowMs: HOUR },
  listingHourly: { max: 10, windowMs: HOUR }
} as const

export function claimRecipientRateLimitRules(input: {
  address: string
  domain: string
  listingId: string
}): AuthRateLimitRule[] {
  return [
    { key: input.address, scope: 'claim-code-address', ...CLAIM_RECIPIENT_LIMITS.addressHourly },
    { key: input.domain, scope: 'claim-code-domain', ...CLAIM_RECIPIENT_LIMITS.domainHourly },
    { key: input.listingId, scope: 'claim-code-listing', ...CLAIM_RECIPIENT_LIMITS.listingHourly }
  ]
}

/** Claim dialog lookups: each may follow a listing's link, so they count per account and address. */
export function claimLookupRateLimitRules(input: {
  ip: string
  userId: string
}): AuthRateLimitRule[] {
  return [
    { key: input.userId, scope: 'claim-lookup-user', max: 60, windowMs: HOUR },
    { key: input.ip, scope: 'claim-lookup-ip', max: 120, windowMs: HOUR }
  ]
}
