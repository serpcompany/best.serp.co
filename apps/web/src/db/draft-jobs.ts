import { type Database, d1ErrorCode } from './client'
import {
  buildExpireDraftPlans,
  buildMarkDraftReminderSentPlans,
  DRAFT_REMINDER_COUNT,
  type DraftReminderNumber,
  type DraftReminderVariant,
  draftClockCutoffs,
  draftReminderVariants,
  selectDraftRemindersDuePlan,
  selectExpiredDraftsPlan
} from './draft-plans'
import type { StatementPlan } from './plan-support'

/**
 * The D1 side of the hourly draft job (#59, #63): read the drafts due for a reminder or past
 * expiry, and claim each reminder or expiry with its compare-and-swap plan
 * (`draft-plans.ts`). The Worker's scheduled handler sends the email only after a claim
 * succeeded (`apps/web/src/lib/submissions/draft-jobs.ts`), so a repeated or concurrent run never
 * sends twice.
 */

export interface DueDraftReminder {
  draftSavedAt: string
  id: string
  name: string
  ownerEmail: string
  reminder: DraftReminderNumber
  slug: string
  variant: DraftReminderVariant
  website: string
}

export interface ExpiredDraft {
  draftSavedAt: string
  id: string
  name: string
  /** Null for a draft whose owner has no address (never for a native draft). */
  ownerEmail: string | null
  slug: string
  website: string
}

/**
 * A draft email whose last send failed and may be sent again (PR #84 review round 1,
 * finding 7): the ledger row is `failed` with attempts left, and the draft is still in the
 * state the email describes (the same reminder still the latest claimed, or expired). The
 * query applies all of that in SQL, so failed rows that can never be sent again (attempts
 * used up, or a draft that moved on) never fill the page ahead of real retries (round 2,
 * finding 5).
 */
export type RetryableDraftEmail =
  | { eventKey: string; kind: 'expired'; draft: ExpiredDraft }
  | { eventKey: string; kind: 'reminder'; draft: DueDraftReminder }

export interface DraftJobOperations {
  /** Claims reminder `reminder`; false when another run claimed it or the draft moved on. */
  claimReminder(input: {
    now: string
    reminder: DraftReminderNumber
    submissionId: string
    variant: DraftReminderVariant
  }): Promise<boolean>
  /** Withdraws an expired draft (`expired`); false when it already left `draft`. */
  expireDraft(input: { now: string; submissionId: string }): Promise<boolean>
  expiredDrafts(input: { limit: number; now: string }): Promise<ExpiredDraft[]>
  remindersDue(input: { limit: number; now: string }): Promise<DueDraftReminder[]>
  /** Draft emails to send again: failed in the email ledger with attempts left. */
  retryableEmails(input: {
    limit: number
    maxAttempts: number
    now: string
  }): Promise<RetryableDraftEmail[]>
}

interface RetryRow {
  draft_reminders_sent: number
  draft_saved_at: string | null
  event_key: string
  id: string
  name: string
  owner_email: string | null
  paid_at: string | null
  plan: string | null
  slug: string
  status: string
  template_id: string
  website: string
  withdrawal_reason: string | null
}

const REMINDER_KEY = /^submission-draft-reminder:([0-9a-f-]{36}):([1-5])$/u
const EXPIRED_KEY = /^submission-draft-expired:([0-9a-f-]{36})$/u

interface DueRow {
  draft_saved_at: string
  id: string
  name: string
  owner_email: string
  reminder: number
  slug: string
  variant: string
  website: string
}

interface ExpiredRow {
  draft_saved_at: string
  id: string
  name: string
  owner_email: string | null
  slug: string
  website: string
}

function reminderOf(value: number): DraftReminderNumber {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error('D1 returned an invalid draft reminder number.')
  }
  return value as DraftReminderNumber
}

function variantOf(value: string): DraftReminderVariant {
  if (!(draftReminderVariants as readonly string[]).includes(value)) {
    throw new Error('D1 returned an invalid draft reminder variant.')
  }
  return value as DraftReminderVariant
}

export function createDraftJobOperations(config: { client: Database }): DraftJobOperations {
  const { binding } = config.client

  async function rows<T>(plan: StatementPlan): Promise<T[]> {
    const result = await binding
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<T>()
    if (!result.success) throw new Error('D1 draft job query failed.')
    return result.results
  }

  /**
   * True when the plan's batch committed, false when its compare-and-swap lost (another run, or
   * the draft moved on). Any other D1 failure is rethrown, so an outage fails the run instead
   * of looking like nothing was due (PR #84 review round 1, finding 7).
   */
  async function claim(plans: StatementPlan[]): Promise<boolean> {
    let results: D1Result<unknown>[]
    try {
      results = await binding.batch(
        plans.map(plan => binding.prepare(plan.sql).bind(...plan.params))
      )
    } catch (error) {
      if (d1ErrorCode(error).endsWith(':plan_assertion_failed')) return false
      throw new Error(`D1 draft job claim failed (${d1ErrorCode(error)}).`)
    }
    if (!results.every(result => result.success)) throw new Error('D1 draft job claim failed.')
    return true
  }

  return {
    async remindersDue({ limit, now }) {
      return (await rows<DueRow>(selectDraftRemindersDuePlan({ limit, now }))).map(row => ({
        draftSavedAt: row.draft_saved_at,
        id: row.id,
        name: row.name,
        ownerEmail: row.owner_email,
        reminder: reminderOf(Number(row.reminder)),
        slug: row.slug,
        variant: variantOf(row.variant),
        website: row.website
      }))
    },

    async claimReminder(input) {
      return claim(buildMarkDraftReminderSentPlans(input))
    },

    async expiredDrafts({ limit, now }) {
      return (await rows<ExpiredRow>(selectExpiredDraftsPlan({ limit, now }))).map(row => ({
        draftSavedAt: row.draft_saved_at,
        id: row.id,
        name: row.name,
        ownerEmail: row.owner_email,
        slug: row.slug,
        website: row.website
      }))
    },

    async expireDraft(input) {
      return claim(buildExpireDraftPlans(input))
    },

    async retryableEmails({ limit, maxAttempts, now }) {
      const { expiryCutoff } = draftClockCutoffs(now)
      // The submission id is the event key's middle part: `submission-draft-reminder:<id>:<n>`
      // (26-character prefix) or `submission-draft-expired:<id>` (25 characters). A reminder
      // still applies while it is the draft's latest, the draft is unexpired and has no plan
      // or an unpaid paid one; an expiry email, while the draft is withdrawn as expired. The
      // checks below repeat these conditions for each row read.
      const failed = await rows<RetryRow>({
        sql: `SELECT d.template_id,d.event_key,s.id,s.slug,s.name,s.website,s.status,s.plan,s.paid_at,
            s.draft_saved_at,s.draft_reminders_sent,s.withdrawal_reason,u.email AS owner_email
          FROM email_deliveries d
          JOIN listing_submissions s ON s.id=CASE d.template_id
            WHEN 'draft-reminder' THEN substr(d.event_key,27,36)
            ELSE substr(d.event_key,26,36) END
          JOIN users u ON u.id=s.owner_user_id
          WHERE d.template_id IN ('draft-reminder','draft-expired') AND d.status='failed'
            AND d.attempts<?
            AND ((d.template_id='draft-reminder'
                AND d.event_key='submission-draft-reminder:'||s.id||':'||s.draft_reminders_sent
                AND s.status='draft' AND s.draft_reminders_sent BETWEEN 1 AND ?
                AND s.draft_saved_at>? AND (s.plan IS NULL OR (s.plan='paid' AND s.paid_at IS NULL)))
              OR (d.template_id='draft-expired' AND d.event_key='submission-draft-expired:'||s.id
                AND s.status='withdrawn' AND s.withdrawal_reason='expired'))
          ORDER BY d.updated_at,d.event_key
          LIMIT ?`,
        params: [maxAttempts, DRAFT_REMINDER_COUNT, expiryCutoff, limit]
      })
      const retryable: RetryableDraftEmail[] = []
      for (const row of failed) {
        if (!row.owner_email) continue
        const expired = EXPIRED_KEY.exec(row.event_key)
        if (row.template_id === 'draft-expired' && expired?.[1] === row.id) {
          if (row.status !== 'withdrawn' || row.withdrawal_reason !== 'expired') continue
          retryable.push({
            draft: {
              draftSavedAt: row.draft_saved_at ?? '',
              id: row.id,
              name: row.name,
              ownerEmail: row.owner_email,
              slug: row.slug,
              website: row.website
            },
            eventKey: row.event_key,
            kind: 'expired'
          })
          continue
        }
        const reminder = REMINDER_KEY.exec(row.event_key)
        if (row.template_id !== 'draft-reminder' || reminder?.[1] !== row.id) continue
        const number = Number(reminder[2])
        const stillLatest =
          row.status === 'draft' &&
          Number(row.draft_reminders_sent) === number &&
          row.draft_saved_at !== null &&
          row.draft_saved_at > expiryCutoff &&
          number <= DRAFT_REMINDER_COUNT
        const variant: DraftReminderVariant | null =
          row.plan === null
            ? 'choose_plan'
            : row.plan === 'paid' && row.paid_at === null
              ? 'complete_checkout'
              : null
        if (!stillLatest || !variant || row.draft_saved_at === null) continue
        retryable.push({
          draft: {
            draftSavedAt: row.draft_saved_at,
            id: row.id,
            name: row.name,
            ownerEmail: row.owner_email,
            reminder: reminderOf(number),
            slug: row.slug,
            variant,
            website: row.website
          },
          eventKey: row.event_key,
          kind: 'reminder'
        })
      }
      return retryable
    }
  }
}
