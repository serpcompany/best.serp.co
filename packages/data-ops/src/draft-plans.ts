import { assertPreviousStatementChangedOne, hoursBefore, type StatementPlan } from './plan-support'

/**
 * Draft expiry and reminders (#59 owner decision, 2026-10-06). A draft is withdrawn
 * automatically 30 days after it was saved, which frees its URL key; reminders go out 12 hours,
 * 48 hours, 7, 14, and 21 days after it was saved, to a draft with no plan ("Choose a plan") and
 * to a draft that chose paid and has not paid ("Complete checkout"). They stop on payment,
 * choosing free (the row leaves `draft`), withdrawal, or expiry. The clock is
 * `listing_submissions.draft_saved_at`; edits never reset it.
 *
 * The scheduled job (#63, `draft-jobs.ts` and `apps/web/lib/submissions/draft-jobs.ts`) reads
 * the due drafts, claims each reminder with `buildMarkDraftReminderSentPlans` (a
 * compare-and-swap, so two runs cannot both claim it), and only then sends the email through
 * the email ledger with the idempotency key `draftReminderEmailKey`, which absorbs a retried
 * send.
 */
export const DRAFT_REMINDER_OFFSETS_HOURS = [12, 48, 7 * 24, 14 * 24, 21 * 24] as const
export const DRAFT_EXPIRY_HOURS = 30 * 24
export const DRAFT_REMINDER_COUNT = DRAFT_REMINDER_OFFSETS_HOURS.length

export type DraftReminderNumber = 1 | 2 | 3 | 4 | 5

/** Which reminder email applies: no plan chosen yet, or paid chosen and checkout not completed. */
export const draftReminderVariants = ['choose_plan', 'complete_checkout'] as const
export type DraftReminderVariant = (typeof draftReminderVariants)[number]

/** The SQL condition for each variant (`alias` is the `listing_submissions` alias, or empty). */
function variantCondition(variant: DraftReminderVariant, alias = ''): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name)
  return variant === 'choose_plan'
    ? `${column('plan')} IS NULL`
    : `(${column('plan')}='paid' AND ${column('paid_at')} IS NULL)`
}

const reminderEligible = (alias: string) =>
  `(${draftReminderVariants.map(variant => variantCondition(variant, alias)).join(' OR ')})`

/**
 * Cutoffs for `now`: a draft saved at or before `reminderCutoffs[n - 1]` is due for reminder `n`,
 * and one saved at or before `expiryCutoff` has expired. Instants are ISO strings
 * (`Date#toISOString()`), the format the `draft_saved_at` CHECK enforces, so they compare as text.
 */
export function draftClockCutoffs(now: string): {
  expiryCutoff: string
  reminderCutoffs: string[]
} {
  const before = (hours: number) => hoursBefore(now, hours)
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
 * Drafts whose next reminder is due at `now`, with the reminder to send: the latest one due. A
 * job that missed a run sends only that one (earlier ones are skipped, not sent late). Pass
 * `reminder` to read only the drafts due for that reminder. `variant` picks the email:
 * `choose_plan` (no plan chosen) or `complete_checkout` (paid chosen, not paid). Expired drafts
 * are left to `selectExpiredDraftsPlan`. Rows: `id`, `slug`, `name`, `website`, `owner_user_id`,
 * `owner_email`, `draft_saved_at`, `draft_reminders_sent`, `reminder`, `variant`.
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
    sql: `SELECT id,slug,name,website,owner_user_id,owner_email,draft_saved_at,draft_reminders_sent,
        reminder,variant
      FROM (
        SELECT s.id,s.slug,s.name,s.website,s.owner_user_id,u.email AS owner_email,s.draft_saved_at,
          s.draft_reminders_sent,CASE ${latestDue} ELSE 0 END AS reminder,
          CASE WHEN ${variantCondition('choose_plan', 's')} THEN 'choose_plan'
            ELSE 'complete_checkout' END AS variant
        FROM listing_submissions s INDEXED BY listing_submissions_draft_clock_idx
        JOIN users u ON u.id=s.owner_user_id
        WHERE s.status='draft' AND ${reminderEligible('s')}
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
 * completed checkout also holds its URL key. Rows: `id`, `slug`, `name`, `website`,
 * `owner_user_id`, `owner_email` (null without an owner), `draft_saved_at`.
 */
export function selectExpiredDraftsPlan(input: { limit: number; now: string }): StatementPlan {
  const { expiryCutoff } = draftClockCutoffs(input.now)
  return {
    sql: `SELECT s.id,s.slug,s.name,s.website,s.owner_user_id,u.email AS owner_email,s.draft_saved_at
      FROM listing_submissions s INDEXED BY listing_submissions_draft_clock_idx
      LEFT JOIN users u ON u.id=s.owner_user_id
      WHERE s.status='draft' AND s.draft_saved_at <= ?
      ORDER BY s.draft_saved_at,s.id
      LIMIT ?`,
    params: [expiryCutoff, input.limit]
  }
}

/**
 * Claims reminder `reminder` of `variant` for a draft: only while the draft is still a draft in
 * that variant (so the email sent matches the state claimed), that reminder is due and not yet
 * claimed, and the draft has not expired. A second claim of the same reminder (a concurrent or
 * repeated run, or after the plan changed) fails the batch, so the email is sent once.
 */
export function buildMarkDraftReminderSentPlans(input: {
  now: string
  reminder: number
  submissionId: string
  variant: DraftReminderVariant
}): StatementPlan[] {
  const reminder = reminderNumber(input.reminder)
  if (!(draftReminderVariants as readonly string[]).includes(input.variant)) {
    throw new Error('A draft reminder variant is choose_plan or complete_checkout.')
  }
  const { expiryCutoff, reminderCutoffs } = draftClockCutoffs(input.now)
  return [
    {
      sql: `UPDATE listing_submissions SET draft_reminders_sent=?,draft_last_reminder_at=?
        WHERE id=? AND status='draft' AND ${variantCondition(input.variant)}
          AND draft_reminders_sent<? AND draft_saved_at<=? AND draft_saved_at>?`,
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
