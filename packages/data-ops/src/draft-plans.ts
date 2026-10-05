import { assertPreviousStatementChangedOne, type StatementPlan } from './plan-support'

/**
 * Draft expiry and reminders (#59 owner decision, 2026-10-06). A draft is withdrawn
 * automatically 30 days after it was saved, which frees its URL key; reminders go out 12 hours,
 * 48 hours, 7, 14, and 21 days after it was saved, and stop once a plan is chosen or the draft is
 * withdrawn. The clock is `listing_submissions.draft_saved_at`; edits never reset it.
 *
 * The scheduled job (#63) reads the due drafts, claims each reminder with
 * `buildMarkDraftReminderSentPlans` (a compare-and-swap, so two runs cannot both claim it), and
 * only then sends the email through the email ledger with the idempotency key
 * `draftReminderEmailKey`, which absorbs a retried send.
 */
export const DRAFT_REMINDER_OFFSETS_HOURS = [12, 48, 7 * 24, 14 * 24, 21 * 24] as const
export const DRAFT_EXPIRY_HOURS = 30 * 24
export const DRAFT_REMINDER_COUNT = DRAFT_REMINDER_OFFSETS_HOURS.length

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const HOUR_MS = 60 * 60 * 1000

export type DraftReminderNumber = 1 | 2 | 3 | 4 | 5

/**
 * Cutoffs for `now`: a draft saved at or before `reminderCutoffs[n - 1]` is due for reminder `n`,
 * and one saved at or before `expiryCutoff` has expired. Instants are ISO strings
 * (`Date#toISOString()`), the format the `draft_saved_at` CHECK enforces, so they compare as text.
 */
export function draftClockCutoffs(now: string): {
  expiryCutoff: string
  reminderCutoffs: string[]
} {
  const time = ISO_INSTANT.test(now) ? Date.parse(now) : Number.NaN
  if (Number.isNaN(time)) throw new Error('The draft clock needs an ISO instant (toISOString()).')
  const before = (hours: number) => new Date(time - hours * HOUR_MS).toISOString()
  return {
    expiryCutoff: before(DRAFT_EXPIRY_HOURS),
    reminderCutoffs: DRAFT_REMINDER_OFFSETS_HOURS.map(before)
  }
}

function reminderNumber(value: number): DraftReminderNumber {
  if (!Number.isSafeInteger(value) || value < 1 || value > DRAFT_REMINDER_COUNT) {
    throw new Error(`A draft reminder is numbered 1 to ${DRAFT_REMINDER_COUNT}.`)
  }
  return value as DraftReminderNumber
}

/** Idempotency key for a draft reminder email in the email ledger. */
export function draftReminderEmailKey(submissionId: string, reminder: number): string {
  return `submission-draft-reminder:${submissionId}:${reminderNumber(reminder)}`
}

/** Idempotency key for the "draft expired" email. */
export function draftExpiredEmailKey(submissionId: string): string {
  return `submission-draft-expired:${submissionId}`
}

/**
 * Drafts with no plan chosen whose next reminder is due at `now`, with the reminder to send:
 * the latest one due. A job that missed a run sends only that one (earlier ones are skipped,
 * not sent late). Pass `reminder` to read only the drafts due for that reminder. Expired drafts
 * are left to `selectExpiredDraftsPlan`. Rows: `id`, `slug`, `name`, `owner_user_id`,
 * `owner_email`, `draft_saved_at`, `draft_reminders_sent`, `reminder`.
 */
export function selectDraftRemindersDuePlan(input: {
  limit: number
  now: string
  reminder?: number
}): StatementPlan {
  const { expiryCutoff, reminderCutoffs } = draftClockCutoffs(input.now)
  const [first] = reminderCutoffs
  const reminder = input.reminder === undefined ? null : reminderNumber(input.reminder)
  const latestDue = reminderCutoffs
    .map((_, index) => index)
    .reverse()
    .map(index => `WHEN s.draft_saved_at <= ? THEN ${index + 1}`)
    .join(' ')
  return {
    sql: `SELECT id,slug,name,owner_user_id,owner_email,draft_saved_at,draft_reminders_sent,reminder
      FROM (
        SELECT s.id,s.slug,s.name,s.owner_user_id,u.email AS owner_email,s.draft_saved_at,
          s.draft_reminders_sent,CASE ${latestDue} ELSE 0 END AS reminder
        FROM listing_submissions s INDEXED BY listing_submissions_draft_clock_idx
        JOIN users u ON u.id=s.owner_user_id
        WHERE s.status='draft' AND s.plan IS NULL
          AND s.draft_saved_at > ? AND s.draft_saved_at <= ?
      ) due
      WHERE due.reminder > due.draft_reminders_sent${reminder === null ? '' : ' AND due.reminder=?'}
      ORDER BY due.draft_saved_at,due.id
      LIMIT ?`,
    params: [
      ...[...reminderCutoffs].reverse(),
      expiryCutoff,
      first,
      ...(reminder === null ? [] : [reminder]),
      input.limit
    ]
  }
}

/**
 * Drafts saved 30 days or more before `now`, plan chosen or not: a paid draft that never
 * completed checkout also holds its URL key. Rows: `id`, `slug`, `name`, `owner_user_id`,
 * `owner_email` (null without an owner), `draft_saved_at`.
 */
export function selectExpiredDraftsPlan(input: { limit: number; now: string }): StatementPlan {
  const { expiryCutoff } = draftClockCutoffs(input.now)
  return {
    sql: `SELECT s.id,s.slug,s.name,s.owner_user_id,u.email AS owner_email,s.draft_saved_at
      FROM listing_submissions s INDEXED BY listing_submissions_draft_clock_idx
      LEFT JOIN users u ON u.id=s.owner_user_id
      WHERE s.status='draft' AND s.draft_saved_at <= ?
      ORDER BY s.draft_saved_at,s.id
      LIMIT ?`,
    params: [expiryCutoff, input.limit]
  }
}

/**
 * Claims reminder `reminder` for a draft: only while the draft is still a draft with no plan,
 * that reminder is due and not yet claimed, and the draft has not expired. A second claim of the
 * same reminder (a concurrent or repeated run) fails the batch, so the email is sent once.
 */
export function buildMarkDraftReminderSentPlans(input: {
  now: string
  reminder: number
  submissionId: string
}): StatementPlan[] {
  const reminder = reminderNumber(input.reminder)
  const { expiryCutoff, reminderCutoffs } = draftClockCutoffs(input.now)
  return [
    {
      sql: `UPDATE listing_submissions SET draft_reminders_sent=?,draft_last_reminder_at=?
        WHERE id=? AND status='draft' AND plan IS NULL AND draft_reminders_sent<?
          AND draft_saved_at<=? AND draft_saved_at>?`,
      params: [
        reminder,
        input.now,
        input.submissionId,
        reminder,
        reminderCutoffs[reminder - 1],
        expiryCutoff
      ]
    },
    assertPreviousStatementChangedOne('draft_reminder_claimed')
  ]
}

/**
 * `draft` → `withdrawn` (`withdrawal_reason = 'expired'`, event `expired`) once the draft is 30
 * days old. Withdrawal frees the URL key for the duplicate check. Choosing a plan first (free)
 * or paying first moves the row out of `draft`, and then this plan fails.
 */
export function buildExpireDraftPlans(input: {
  now: string
  submissionId: string
}): StatementPlan[] {
  const { expiryCutoff } = draftClockCutoffs(input.now)
  return [
    {
      sql: `UPDATE listing_submissions SET status='withdrawn',withdrawal_reason='expired',updated_at=?
        WHERE id=? AND status='draft' AND draft_saved_at<=?`,
      params: [input.now, input.submissionId, expiryCutoff]
    },
    assertPreviousStatementChangedOne('draft_expired'),
    {
      sql: `INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
        VALUES (?,'expired',NULL,'draft-expiry')`,
      params: [input.submissionId]
    }
  ]
}
