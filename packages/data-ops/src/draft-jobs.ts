import type { Database } from './client'
import {
  buildExpireDraftPlans,
  buildMarkDraftReminderSentPlans,
  type DraftReminderNumber,
  type DraftReminderVariant,
  draftReminderVariants,
  selectDraftRemindersDuePlan,
  selectExpiredDraftsPlan
} from './draft-plans'
import type { StatementPlan } from './plan-support'

/**
 * The D1 side of the hourly draft job (#59, #63): read the drafts due for a reminder or past
 * expiry, and claim each reminder or expiry with its compare-and-swap plan
 * (`draft-plans.ts`). The Worker's scheduled handler sends the email only after a claim
 * succeeded (`apps/web/lib/submissions/draft-jobs.ts`), so a repeated or concurrent run never
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
}

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

  /** True when the plan's batch committed; a failed compare-and-swap rolls it back. */
  async function claim(plans: StatementPlan[]): Promise<boolean> {
    try {
      const results = await binding.batch(
        plans.map(plan => binding.prepare(plan.sql).bind(...plan.params))
      )
      return results.every(result => result.success)
    } catch {
      return false
    }
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
    }
  }
}
