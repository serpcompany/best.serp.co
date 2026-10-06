import type { AuthRateLimitRule } from '@serpdirectory/data-ops/auth'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Account edits (#65: resubmit, FAQs and links, revisions) have their own budget per account,
 * apart from the submit flow's draft saves (#102 review round 1). A request counts only once it
 * is valid (its body, its record's state, and its version), right before the logo check and
 * the write, so a refused or stale save never spends it.
 */
export const ACCOUNT_EDIT_LIMITS = {
  burst: { max: 10, windowMs: MINUTE },
  hourly: { max: 60, windowMs: HOUR }
} as const

export function accountEditRateLimitRules(userId: string): AuthRateLimitRule[] {
  return [
    { key: userId, scope: 'account-edit-user', ...ACCOUNT_EDIT_LIMITS.burst },
    { key: userId, scope: 'account-edit-user', ...ACCOUNT_EDIT_LIMITS.hourly }
  ]
}
