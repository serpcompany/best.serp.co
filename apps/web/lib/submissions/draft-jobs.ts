import type { DraftJobOperations } from '@serpdirectory/data-ops/draft-jobs'
import {
  DRAFT_REMINDER_COUNT,
  draftExpiredEmailKey,
  draftReminderEmailKey
} from '@serpdirectory/data-ops/draft-plans'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailService } from '../email/service'
import { draftExpiresInDays } from './contract'

/**
 * The hourly draft job (serpcompany/best.serp.co#59, #63), run by the Worker's scheduled handler
 * (`lib/worker/scheduled.ts`):
 *
 * 1. Expire drafts 30 days after they were first saved (`withdrawn`, reason `expired`), which
 *    frees their URL, then email `draft-expired`.
 * 2. Send the latest due reminder (+12h, +48h, +7d, +14d, +21d) of each remaining draft as
 *    `draft-reminder`, in the variant the draft is in (`choose_plan`, `complete_checkout`).
 *
 * Each email goes out only after its claim (a compare-and-swap in D1) succeeded, and the email
 * ledger keys each one by submission and reminder, so a repeated or overlapping run never sends
 * twice. A run handles at most `limit` drafts of each kind; the rest wait for the next run.
 */

export const DRAFT_JOB_LIMIT = 100

export interface DraftJobResult {
  expired: number
  /** True when a query returned `limit` rows, so more may be waiting for the next run. */
  more: boolean
  reminded: number
  /** Claims another run (or a plan change) won; nothing was sent for them. */
  skipped: number
}

export async function runDraftJobs(input: {
  email: Pick<EmailService<AppEmailTemplates>, 'enqueue'>
  jobs: DraftJobOperations
  limit?: number
  now: Date
  /** `features.showPaidListings`: the reminder copy follows the site's paid flag. */
  paidListings: boolean
  priceCents: number
}): Promise<DraftJobResult> {
  const { email, jobs, now, paidListings, priceCents } = input
  const limit = input.limit ?? DRAFT_JOB_LIMIT
  const at = now.toISOString()
  const result: DraftJobResult = { expired: 0, more: false, reminded: 0, skipped: 0 }

  const expired = await jobs.expiredDrafts({ limit, now: at })
  for (const draft of expired) {
    if (!(await jobs.expireDraft({ now: at, submissionId: draft.id }))) {
      result.skipped += 1
      continue
    }
    result.expired += 1
    if (draft.ownerEmail) {
      email.enqueue('draft-expired', {
        eventKey: draftExpiredEmailKey(draft.id),
        input: { productName: draft.name, website: draft.website },
        to: draft.ownerEmail
      })
    }
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
    email.enqueue('draft-reminder', {
      eventKey: draftReminderEmailKey(draft.id, draft.reminder),
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
  }

  result.more = expired.length >= limit || due.length >= limit
  return result
}
