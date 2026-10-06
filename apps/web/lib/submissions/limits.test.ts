import { describe, expect, it } from 'vitest'
import { badgeCheckRateLimitRules, prefillRateLimitRules } from './limits'

describe('submit-flow rate limits', () => {
  // PR #84 review round 1, finding 3: many accounts behind one address share its budget.
  it('limits every prefill by client address, and a signed-in one by account too', () => {
    const scopes = (rules: ReturnType<typeof prefillRateLimitRules>) =>
      rules.map(rule => `${rule.scope}:${rule.key}:${rule.max}`)
    expect(scopes(prefillRateLimitRules({ ip: '203.0.113.7', userId: null }))).toEqual([
      'submission-prefill-ip:203.0.113.7:10',
      'submission-prefill-ip:203.0.113.7:60'
    ])
    expect(scopes(prefillRateLimitRules({ ip: '203.0.113.7', userId: 'user_1' }))).toEqual([
      'submission-prefill-ip:203.0.113.7:10',
      'submission-prefill-ip:203.0.113.7:60',
      'submission-prefill-user:user_1:10',
      'submission-prefill-user:user_1:40'
    ])
  })

  // PR #84 review round 1, finding 2: every badge fetch counts, per submission and account.
  it('budgets badge-check fetches per submission and per account', () => {
    expect(badgeCheckRateLimitRules({ submissionId: 's_1', userId: 'user_1' })).toEqual([
      { key: 's_1', max: 20, scope: 'badge-check-submission', windowMs: 3_600_000 },
      { key: 'user_1', max: 60, scope: 'badge-check-user', windowMs: 3_600_000 }
    ])
  })
})
