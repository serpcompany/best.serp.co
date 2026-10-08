import type { Database } from './client'
import type { StatementPlan } from './plan-support'

/**
 * Runs credential-free statement plans on the injected D1 client (serpcompany/best.serp.co#64).
 * The app's admin adapter composes plans and calls these, so it never prepares SQL itself.
 */

/** Sends the plans as one D1 batch: one transaction that commits whole or not at all. */
export async function executePlans(client: Database, plans: StatementPlan[]): Promise<void> {
  if (plans.length === 0) throw new Error('A batch needs at least one statement.')
  await client.binding.batch(
    plans.map(plan => client.binding.prepare(plan.sql).bind(...plan.params))
  )
}

/** The rows of one read plan. */
export async function queryPlan<T = Record<string, unknown>>(
  client: Database,
  plan: StatementPlan
): Promise<T[]> {
  const result = await client.binding
    .prepare(plan.sql)
    .bind(...plan.params)
    .all<T>()
  return result.results ?? []
}

/**
 * True when a batch failed because a compare-and-swap guard refused it (the state was not what
 * the caller read) or a constraint or trigger refused the write: the caller re-reads and answers
 * 409, never 500. Any other error (D1 unavailable, a malformed statement) is not a conflict.
 */
export function isPlanConflict(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : ''
  return /malformed JSON|constraint failed|UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint|primary category|blocked/iu.test(
    message
  )
}
