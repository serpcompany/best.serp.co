import {
  type BadgeCheckRecord,
  type BadgeProgramEmail,
  type BadgeProgramListing,
  type BadgeProgramOperations,
  badgeProgramEmailKey
} from '@serpdirectory/data-ops/badge-program'
import { EMAIL_DELIVERY_MAX_ATTEMPTS } from '@serpdirectory/data-ops/email-deliveries'
import { CONCLUSIVE_VERIFICATION_FAILURES } from '@serpdirectory/data-ops/submissions'
import type { BadgeProblem } from '../email/emails/listings'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import {
  badgeConfirmationDueBefore,
  badgeCycleStart,
  badgeDailyStart,
  badgeRecheckAt
} from './schedule'

/**
 * The weekly badge program (serpcompany/best.serp.co#59, #66), run by the Worker's scheduled
 * handler (`lib/worker/scheduled.ts`) on its weekly, daily, and hourly triggers
 * (`./schedule.ts`). Every run does the same three steps, each bounded:
 *
 * 1. Send again the program emails whose last send failed and that still apply.
 * 2. Recheck the warnings whose confirmation is due. A pass ends the warning; an inconclusive
 *    result is recorded and tried again the next day; a conclusive miss unpublishes a free
 *    submitted listing (email "unlisted") or removes a badge claimer's ownership while the
 *    listing stays up (email "ownership removed"), in the same D1 batch as the check.
 * 3. Check the listings due this cycle. A conclusive miss opens a warning (email "badge
 *    missing", which names the recheck time).
 *
 * **Conclusive** means the page loaded and the badge is missing, not followed (`rel`
 * `nofollow`, `sponsored`, or `ugc`, or a page that tells Googlebot or all crawlers not to
 * follow links), or links elsewhere: `CONCLUSIVE_VERIFICATION_FAILURES`, as at submit (#63).
 * Anything else (a timeout, an unreachable site, any HTTP error status, a non-HTML or unreadable
 * page, a page past the parser's limits) is inconclusive: recorded, never a miss.
 *
 * **Limits.** A run checks at most `BADGE_CHECK_LIMIT` sites, `BADGE_CHECK_CONCURRENCY` at a
 * time: each check is at most four fetches (three redirects) of 8 seconds and one bounded parse,
 * plus two or three D1 statements and its email, so a run stays far below the Workers
 * subrequest limit (1,000 on the Paid plan) and the 30-second CPU default. The rest wait for
 * the next hourly run; with 20 per hour a cycle covers about 3,000 listings a week.
 *
 * Every write is a compare-and-swap (`@serpdirectory/data-ops/badge-program`) and every email
 * goes through the email ledger under a key per template and check, so an overlapping or
 * repeated run never records a check twice or sends an email twice.
 */

export const BADGE_CHECK_LIMIT = 20
export const BADGE_CHECK_CONCURRENCY = 4
export const BADGE_EMAIL_RETRY_LIMIT = 20

const CONCLUSIVE = new Set<string>(CONCLUSIVE_VERIFICATION_FAILURES)

/** How a verifier result is recorded: a pass, a conclusive miss, or an inconclusive failure. */
export function badgeCheckRecord(result: BadgeVerificationResult): BadgeCheckRecord {
  if (result.ok) return { outcome: 'pass' }
  return { conclusive: CONCLUSIVE.has(result.code), outcome: 'fail', reason: result.code }
}

/** The "badge missing" email's finding for a conclusive miss's reason. */
export function badgeProblem(reason: string): BadgeProblem {
  if (reason === 'wrong_destination') return 'wrong_destination'
  if (reason === 'link_not_followed' || reason === 'page_not_followed' || reason === 'nofollow') {
    return 'nofollow'
  }
  return 'missing'
}

export interface BadgeProgramResult {
  /** Rechecks recorded (pass, inconclusive, or confirmed miss). */
  confirmations: number
  /** Inconclusive results recorded (weekly or recheck). */
  inconclusive: number
  /** True when a step filled its batch, so more may be waiting for the next run. */
  more: boolean
  passed: number
  retried: number
  revoked: number
  /** Checks another run (or a state change) recorded first; nothing was sent for them. */
  skipped: number
  unpublished: number
  /** Weekly conclusive misses: warnings sent. */
  warned: number
  weekly: number
}

type ProgramTemplate = 'badge-missing' | 'listing-unlisted' | 'ownership-removed'

/** Sends one email and resolves when its delivery finished (whatever the outcome). */
export type SendBadgeEmail = <K extends ProgramTemplate>(
  templateId: K,
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
) => Promise<void>

/** Checks one listing's badge; it never throws (a thrown error counts as inconclusive). */
export type VerifyListingBadge = (listing: BadgeProgramListing) => Promise<BadgeVerificationResult>

async function eachLimited<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await run(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker)
  )
}

export async function runBadgeProgram(input: {
  checkLimit?: number
  concurrency?: number
  now: Date
  operations: BadgeProgramOperations
  /** The paid listing price, in cents (the emails' upgrade line). */
  priceCents: number
  send: SendBadgeEmail
  verify: VerifyListingBadge
}): Promise<BadgeProgramResult> {
  const { now, operations, priceCents, send } = input
  const checkLimit = input.checkLimit ?? BADGE_CHECK_LIMIT
  const concurrency = input.concurrency ?? BADGE_CHECK_CONCURRENCY
  const at = now.toISOString()
  const result: BadgeProgramResult = {
    confirmations: 0,
    inconclusive: 0,
    more: false,
    passed: 0,
    retried: 0,
    revoked: 0,
    skipped: 0,
    unpublished: 0,
    warned: 0,
    weekly: 0
  }

  // Emails go out one at a time, after every check of a step has been recorded.
  const outbox: BadgeProgramEmail[] = []
  const flush = async () => {
    for (const email of outbox.splice(0)) await sendEmail(email)
  }
  const sendEmail = (email: BadgeProgramEmail): Promise<void> => {
    const eventKey = badgeProgramEmailKey(email.template, email.checkId)
    const listing = { listingName: email.listing.name, listingSlug: email.listing.slug }
    const website = email.listing.website
    if (email.template === 'badge-missing') {
      return send('badge-missing', {
        eventKey,
        input: {
          ...listing,
          checkedAt: email.checkedAt,
          priceCents,
          problem: badgeProblem(email.reason),
          recheckAt: badgeRecheckAt(email.checkedAt).toISOString(),
          website
        },
        to: email.to
      })
    }
    if (email.template === 'listing-unlisted') {
      return send('listing-unlisted', {
        eventKey,
        input: {
          ...listing,
          checkedAt: email.checkedAt,
          priceCents,
          warnedAt: email.warnedAt,
          website
        },
        to: email.to
      })
    }
    return send('ownership-removed', {
      eventKey,
      input: { ...listing, checkedAt: email.checkedAt, priceCents, website },
      to: email.to
    })
  }

  const verify = async (listing: BadgeProgramListing): Promise<BadgeCheckRecord> => {
    try {
      return badgeCheckRecord(await input.verify(listing))
    } catch {
      return { conclusive: false, outcome: 'fail', reason: 'verification_service_error' }
    }
  }
  const count = (record: BadgeCheckRecord) => {
    if (record.outcome === 'pass') result.passed += 1
    else if (!record.conclusive) result.inconclusive += 1
  }

  // 1. Failed sends from earlier runs first, so a retry never waits behind a full batch.
  const retries = await operations.retryableEmails({
    limit: BADGE_EMAIL_RETRY_LIMIT,
    maxAttempts: EMAIL_DELIVERY_MAX_ATTEMPTS,
    now: at
  })
  for (const email of retries) {
    await sendEmail(email)
    result.retried += 1
  }

  // 2. Due rechecks, then 3. this cycle's weekly checks, within one budget of site checks.
  const confirmations = await operations.confirmationsDue({
    attemptSince: badgeDailyStart(now).toISOString(),
    dueBefore: badgeConfirmationDueBefore(now).toISOString(),
    limit: checkLimit,
    now: at
  })
  await eachLimited(confirmations, concurrency, async listing => {
    const record = await verify(listing)
    const recorded = await operations.recordConfirmation({
      attemptSince: badgeDailyStart(now).toISOString(),
      listing,
      now: at,
      result: record
    })
    if (!recorded.recorded) {
      result.skipped += 1
      return
    }
    result.confirmations += 1
    count(record)
    if (recorded.action === 'unpublished') result.unpublished += 1
    if (recorded.action === 'revoked') result.revoked += 1
    if (recorded.email) outbox.push(recorded.email)
  })
  await flush()

  const remaining = checkLimit - confirmations.length
  const weekly =
    remaining > 0
      ? await operations.weeklyDue({
          cycleStart: badgeCycleStart(now).toISOString(),
          limit: remaining,
          now: at
        })
      : []
  await eachLimited(weekly, concurrency, async listing => {
    const record = await verify(listing)
    const recorded = await operations.recordWeekly({
      cycleStart: badgeCycleStart(now).toISOString(),
      listing,
      now: at,
      result: record
    })
    if (!recorded.recorded) {
      result.skipped += 1
      return
    }
    result.weekly += 1
    count(record)
    if (recorded.email) {
      result.warned += 1
      outbox.push(recorded.email)
    }
  })
  await flush()

  result.more =
    retries.length >= BADGE_EMAIL_RETRY_LIMIT ||
    confirmations.length >= checkLimit ||
    (remaining > 0 && weekly.length >= remaining)
  return result
}
