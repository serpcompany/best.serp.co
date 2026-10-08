import type { DraftJobOperations, DueDraftReminder, ExpiredDraft } from '@/db/draft-jobs'
import { DRAFT_REMINDER_COUNT, draftExpiredEmailKey, draftReminderEmailKey } from '@/db/draft-plans'
import { EMAIL_DELIVERY_MAX_ATTEMPTS } from '@/db/email-deliveries'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'
import { draftExpiresInDays } from './contract'

/**
 * The hourly draft job (serpcompany/best.serp.co#59, #63), run by the Worker's scheduled
 * handler (`lib/worker/scheduled.ts`):
 *
 * 1. Expire drafts 30 days after they were first saved (`withdrawn`, reason `expired`), which
 *    frees their URL, then email `draft-expired`.
 * 2. Send the latest due reminder (+12h, +48h, +7d, +14d, +21d) of each remaining draft as
 *    `draft-reminder`, in the variant the draft is in (`choose_plan`, `complete_checkout`).
 * 3. Send again the draft emails whose last send failed (PR #84 review round 1, finding 7):
 *    the email ledger keeps a `failed` row with its attempt count, and resending under the same
 *    event key retries it until the ledger's attempt cap.
 *
 * Each email goes out only after its claim (a compare-and-swap in D1) succeeded, and the email
 * ledger keys each one by submission and reminder, so a repeated or overlapping run never sends
 * twice. Emails go out one at a time. A run handles at most `limit` drafts of each kind; the
 * rest wait for the next run. A D1 failure other than a lost claim fails the run.
 */

export const DRAFT_JOB_LIMIT = 100

export interface DraftJobResult {
  expired: number
  /** True when a query returned `limit` rows, so more may be waiting for the next run. */
  more: boolean
  reminded: number
  /** Draft emails sent again after a failed send. */
  retried: number
  /** Claims another run (or a plan change) won; nothing was sent for them. */
  skipped: number
}

type DraftTemplate = 'draft-expired' | 'draft-reminder'

/** Sends one email and resolves when its delivery finished (whatever the outcome). */
export type SendDraftEmail = <K extends DraftTemplate>(
  templateId: K,
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
) => Promise<void>

export async function runDraftJobs(input: {
  jobs: DraftJobOperations
  limit?: number
  now: Date
  /** `features.orders` (`ordersEnabledFor`): the reminder copy follows the site's paid flag. */
  paidListings: boolean
  priceCents: number
  send: SendDraftEmail
}): Promise<DraftJobResult> {
  const { jobs, now, paidListings, priceCents, send } = input
  const limit = input.limit ?? DRAFT_JOB_LIMIT
  const at = now.toISOString()
  const result: DraftJobResult = { expired: 0, more: false, reminded: 0, retried: 0, skipped: 0 }

  const sendExpired = (draft: ExpiredDraft, eventKey: string) =>
    draft.ownerEmail
      ? send('draft-expired', {
          eventKey,
          input: { productName: draft.name, website: draft.website },
          to: draft.ownerEmail
        })
      : Promise.resolve()

  const sendReminder = (draft: DueDraftReminder, eventKey: string) =>
    send('draft-reminder', {
      eventKey,
      input: {
        expiresInDays: draftExpiresInDays(draft.draftSavedAt, now) ?? 0,
        lastReminder: draft.reminder === DRAFT_REMINDER_COUNT,
        paidListings,
        priceCents,
        productName: draft.name,
        submissionId: draft.id,
        variant: draft.variant,
        website: draft.website
      },
      to: draft.ownerEmail
    })

  // Failed sends from earlier runs first, so a retry never waits behind a full batch.
  const retries = await jobs.retryableEmails({
    limit,
    maxAttempts: EMAIL_DELIVERY_MAX_ATTEMPTS,
    now: at
  })
  for (const retry of retries) {
    if (retry.kind === 'expired') await sendExpired(retry.draft, retry.eventKey)
    else await sendReminder(retry.draft, retry.eventKey)
    result.retried += 1
  }

  const expired = await jobs.expiredDrafts({ limit, now: at })
  for (const draft of expired) {
    if (!(await jobs.expireDraft({ now: at, submissionId: draft.id }))) {
      result.skipped += 1
      continue
    }
    result.expired += 1
    await sendExpired(draft, draftExpiredEmailKey(draft.id))
  }

  const due = await jobs.remindersDue({ limit, now: at })
  for (const draft of due) {
    const claimed = await jobs.claimReminder({
      now: at,
      reminder: draft.reminder,
      submissionId: draft.id,
      variant: draft.variant
    })
    if (!claimed) {
      result.skipped += 1
      continue
    }
    result.reminded += 1
    await sendReminder(draft, draftReminderEmailKey(draft.id, draft.reminder))
  }

  result.more = retries.length >= limit || expired.length >= limit || due.length >= limit
  return result
}
