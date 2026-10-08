import { describe, expect, it, vi } from 'vitest'
import type {
  BadgeCheckRecord,
  BadgeProgramListing,
  BadgeProgramOperations,
  PendingConfirmation,
  RecordedBadgeCheck
} from '@/db/badge-program'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import {
  BADGE_CHECK_LIMIT,
  badgeCheckRecord,
  badgeProblem,
  runBadgeProgram,
  type SendBadgeEmail
} from './program'

const NOW = new Date('2026-10-06T04:00:00.000Z') // Tuesday, after the daily window opened

function listing(
  id: string,
  branch: BadgeProgramListing['branch'] = 'unpublish'
): BadgeProgramListing {
  return {
    branch,
    id,
    name: `Name ${id}`,
    ownerEmail: `${id}@example.com`,
    ownerUserId: `user_${id}`,
    slug: `${id}.example`,
    website: `https://${id}.example/`
  }
}

function pending(
  id: string,
  branch: BadgeProgramListing['branch'] = 'unpublish'
): PendingConfirmation {
  return {
    ...listing(id, branch),
    warning: { checkedAt: '2026-10-05T03:15:00.000Z', id: 1, reason: 'badge_missing' }
  }
}

/** Operations over in-memory lists, recording what the runner asked for. */
function fakeOperations(input: {
  confirmations?: PendingConfirmation[]
  lose?: string[]
  weekly?: BadgeProgramListing[]
}) {
  let nextId = 100
  const recorded: Array<{ id: string; kind: string; result: BadgeCheckRecord }> = []
  const calls: Record<string, unknown> = {}
  const record = (id: string): number | null => (input.lose?.includes(id) ? null : nextId++)
  const operations: BadgeProgramOperations = {
    async confirmationsDue(args) {
      calls.confirmationsDue = args
      return (input.confirmations ?? []).slice(0, args.limit)
    },
    async weeklyDue(args) {
      calls.weeklyDue = args
      return (input.weekly ?? []).slice(0, args.limit)
    },
    async recordWeekly({ listing, now, result }): Promise<RecordedBadgeCheck> {
      const id = record(listing.id)
      if (id === null) return { recorded: false }
      recorded.push({ id: listing.id, kind: 'weekly', result })
      const miss = result.outcome === 'fail' && result.conclusive
      return {
        action: 'none',
        email: miss
          ? {
              checkId: id,
              checkedAt: now,
              listing,
              reason: result.reason,
              template: 'badge-missing',
              to: listing.ownerEmail
            }
          : null,
        id,
        recorded: true
      }
    },
    async recordConfirmation({ listing, now, result }): Promise<RecordedBadgeCheck> {
      const id = record(listing.id)
      if (id === null) return { recorded: false }
      recorded.push({ id: listing.id, kind: 'confirmation', result })
      if (result.outcome === 'pass' || !result.conclusive) {
        return { action: 'none', email: null, id, recorded: true }
      }
      const common = { checkId: id, checkedAt: now, listing, to: listing.ownerEmail }
      return listing.branch === 'unpublish'
        ? {
            action: 'unpublished',
            email: { ...common, template: 'listing-unlisted', warnedAt: listing.warning.checkedAt },
            id,
            recorded: true
          }
        : {
            action: 'revoked',
            email: { ...common, template: 'ownership-removed' },
            id,
            recorded: true
          }
    },
    async retryableEmails() {
      return []
    }
  }
  return { calls, operations, recorded }
}

function sender() {
  const sent: Array<{ eventKey: string; input: unknown; template: string; to: string }> = []
  const send: SendBadgeEmail = async (template, request) => {
    sent.push({ eventKey: request.eventKey, input: request.input, template, to: request.to })
  }
  return { send, sent }
}

const pass: BadgeVerificationResult = { ok: true }
const missing: BadgeVerificationResult = { code: 'badge_missing', ok: false }

describe('badge check outcomes', () => {
  it('counts a loaded page without a working badge, or any 4xx, as a miss', () => {
    expect(badgeCheckRecord({ ok: true })).toEqual({ outcome: 'pass' })
    const conclusive: BadgeVerificationResult[] = [
      { code: 'badge_missing', ok: false },
      { code: 'link_not_followed', ok: false, rel: ['sponsored'] },
      { code: 'page_not_followed', ok: false, source: 'meta' },
      { code: 'wrong_destination', ok: false },
      // Owner decision on #106: a 4xx is a miss right away (a 403 to our checker, a dead page).
      { code: 'http_400', ok: false },
      { code: 'http_403', ok: false },
      { code: 'http_404', ok: false },
      { code: 'http_410', ok: false },
      { code: 'http_451', ok: false }
    ]
    for (const result of conclusive) {
      expect(badgeCheckRecord(result), JSON.stringify(result)).toMatchObject({
        conclusive: true,
        outcome: 'fail'
      })
    }
    // Network errors, timeouts, 5xx, non-HTML and unreadable pages, and the checker's own
    // limits never count as a miss.
    for (const code of [
      'fetch_timeout',
      'site_unreachable',
      'http_500',
      'http_503',
      'not_html',
      'page_unreadable',
      'response_too_large',
      'too_many_redirects',
      'invalid_redirect',
      'invalid_target',
      'verification_service_error'
    ] as const) {
      expect(badgeCheckRecord({ code, ok: false } as BadgeVerificationResult), code).toEqual({
        conclusive: false,
        outcome: 'fail',
        reason: code
      })
    }
  })

  it('names the email finding only in words that are true of it', () => {
    expect(badgeProblem('badge_missing')).toEqual({ problem: 'missing' })
    expect(badgeProblem('wrong_destination')).toEqual({ problem: 'wrong_destination' })
    expect(badgeProblem('page_not_followed')).toEqual({ problem: 'page_not_followed' })
    expect(badgeProblem('http_404')).toEqual({ httpStatus: 404, problem: 'http_status' })
    // "Marked nofollow" only when the link's rel has nofollow.
    const rel = (tokens: Array<'nofollow' | 'sponsored' | 'ugc'>): BadgeVerificationResult => ({
      code: 'link_not_followed',
      ok: false,
      rel: tokens
    })
    expect(badgeProblem('link_not_followed', rel(['nofollow', 'ugc']))).toEqual({
      problem: 'nofollow'
    })
    expect(badgeProblem('link_not_followed', rel(['sponsored']))).toEqual({
      problem: 'not_followed'
    })
    expect(badgeProblem('link_not_followed', rel(['ugc']))).toEqual({ problem: 'not_followed' })
    // Sent again later, without the tokens: the line that is true of every unfollowed link.
    expect(badgeProblem('link_not_followed')).toEqual({ problem: 'not_followed' })
  })
})

describe('badge program run', () => {
  it('warns on a weekly miss with the recheck time, and records passes and inconclusive results quietly', async () => {
    const { calls, operations, recorded } = fakeOperations({
      weekly: [listing('a'), listing('b'), listing('c')]
    })
    const { send, sent } = sender()
    const verdicts: Record<string, BadgeVerificationResult> = {
      a: missing,
      b: pass,
      c: { code: 'fetch_timeout', ok: false }
    }
    const result = await runBadgeProgram({
      now: new Date('2026-10-05T03:15:00.000Z'),
      operations,
      priceCents: 4900,
      send,
      verify: async item => verdicts[item.id] ?? pass
    })
    expect(calls.weeklyDue).toEqual({
      cycleStart: '2026-10-05T03:15:00.000Z',
      limit: BADGE_CHECK_LIMIT,
      now: '2026-10-05T03:15:00.000Z'
    })
    expect(recorded.map(item => item.id).sort()).toEqual(['a', 'b', 'c'])
    expect(sent).toEqual([
      {
        eventKey: 'badge-missing:100',
        input: {
          checkedAt: '2026-10-05T03:15:00.000Z',
          listingName: 'Name a',
          listingSlug: 'a.example',
          priceCents: 4900,
          problem: 'missing',
          recheckAt: '2026-10-06T03:45:00.000Z',
          website: 'https://a.example/'
        },
        template: 'badge-missing',
        to: 'a@example.com'
      }
    ])
    expect(result).toMatchObject({ inconclusive: 1, more: false, passed: 1, warned: 1, weekly: 3 })
  })

  it('names the exact finding in the warning: nofollow, sponsored, or a 4xx', async () => {
    const { operations } = fakeOperations({
      weekly: [listing('n'), listing('s'), listing('g')]
    })
    const { send, sent } = sender()
    const verdicts: Record<string, BadgeVerificationResult> = {
      g: { code: 'http_410', ok: false },
      n: { code: 'link_not_followed', ok: false, rel: ['nofollow'] },
      s: { code: 'link_not_followed', ok: false, rel: ['sponsored'] }
    }
    await runBadgeProgram({
      now: NOW,
      operations,
      priceCents: 4900,
      send,
      verify: async item => verdicts[item.id] ?? pass
    })
    const findings = Object.fromEntries(
      sent.map(email => {
        const input = email.input as { httpStatus?: number; problem: string }
        return [email.to, [input.problem, input.httpStatus]]
      })
    )
    expect(findings).toEqual({
      'g@example.com': ['http_status', 410],
      'n@example.com': ['nofollow', undefined],
      's@example.com': ['not_followed', undefined]
    })
  })

  it('unpublishes or revokes on a confirmed miss and emails the owner', async () => {
    const { calls, operations } = fakeOperations({
      confirmations: [pending('free'), pending('claim', 'revoke'), pending('fixed')]
    })
    const { send, sent } = sender()
    const result = await runBadgeProgram({
      now: NOW,
      operations,
      priceCents: 4900,
      send,
      verify: async item => (item.id === 'fixed' ? pass : missing)
    })
    expect(calls.confirmationsDue).toEqual({
      attemptSince: '2026-10-06T03:45:00.000Z',
      dueBefore: '2026-10-05T07:45:00.000Z',
      limit: BADGE_CHECK_LIMIT,
      now: NOW.toISOString()
    })
    expect(sent.map(email => [email.template, email.to, email.eventKey]).sort()).toEqual([
      ['listing-unlisted', 'free@example.com', expect.stringMatching(/^listing-unlisted:\d+$/u)],
      ['ownership-removed', 'claim@example.com', expect.stringMatching(/^ownership-removed:\d+$/u)]
    ])
    expect(sent.find(email => email.template === 'listing-unlisted')?.input).toEqual({
      checkedAt: NOW.toISOString(),
      listingName: 'Name free',
      listingSlug: 'free.example',
      priceCents: 4900,
      warnedAt: '2026-10-05T03:15:00.000Z',
      website: 'https://free.example/'
    })
    expect(result).toMatchObject({ confirmations: 3, passed: 1, revoked: 1, unpublished: 1 })
  })

  it('sends nothing for a check another run recorded first', async () => {
    const { operations } = fakeOperations({ lose: ['a'], weekly: [listing('a')] })
    const { send, sent } = sender()
    const result = await runBadgeProgram({
      now: NOW,
      operations,
      priceCents: 4900,
      send,
      verify: async () => missing
    })
    expect(sent).toEqual([])
    expect(result).toMatchObject({ skipped: 1, warned: 0, weekly: 0 })
  })

  it('treats a verifier that throws as inconclusive', async () => {
    const { operations, recorded } = fakeOperations({ weekly: [listing('a')] })
    const { send } = sender()
    await runBadgeProgram({
      now: NOW,
      operations,
      priceCents: 4900,
      send,
      verify: async () => {
        throw new Error('boom')
      }
    })
    expect(recorded[0]?.result).toEqual({
      conclusive: false,
      outcome: 'fail',
      reason: 'verification_service_error'
    })
  })

  it('checks at most the limit per run, rechecks first, a few sites at a time', async () => {
    const weekly = Array.from({ length: 30 }, (_, index) => listing(`w${index}`))
    const { calls, operations } = fakeOperations({
      confirmations: [pending('c1'), pending('c2')],
      weekly
    })
    let active = 0
    let peak = 0
    const verify = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return pass
    })
    const result = await runBadgeProgram({
      checkLimit: 10,
      concurrency: 3,
      now: NOW,
      operations,
      priceCents: 4900,
      send: sender().send,
      verify
    })
    expect(verify).toHaveBeenCalledTimes(10)
    expect((calls.weeklyDue as { limit: number }).limit).toBe(8)
    expect(peak).toBe(3)
    expect(result).toMatchObject({ confirmations: 2, more: true, weekly: 8 })
  })
})
