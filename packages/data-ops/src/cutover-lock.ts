import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'

export const CUTOVER_LOCK_ID_PREFIX = 'd1-cutover-lock-v1:'
export const CUTOVER_FROZEN_CODE = 'cutover_frozen'
export const CUTOVER_FROZEN_MESSAGE = 'Writes are temporarily paused for a database cutover.'

export interface CutoverLockStatementPlan {
  params: unknown[]
  sql: string
}

export class CutoverFrozenError extends Error {
  readonly code = CUTOVER_FROZEN_CODE
  readonly status = 503

  constructor() {
    super(CUTOVER_FROZEN_MESSAGE)
  }
}

export function activeCutoverLockIdPrefix(siteId: ActiveCheckedInSiteId): string {
  return `${CUTOVER_LOCK_ID_PREFIX}${siteId}:`
}

export function selectActiveCutoverLockPlan(
  siteId: ActiveCheckedInSiteId
): CutoverLockStatementPlan {
  return {
    sql: `SELECT id FROM migration_runs
      WHERE site_id=? AND id LIKE ? ESCAPE '\\' AND outcome='started'
      ORDER BY started_at DESC,id LIMIT 1`,
    params: [siteId, `${escapeLike(activeCutoverLockIdPrefix(siteId))}%`]
  }
}

/**
 * This statement must be the first member of the same D1 batch as a mutation.
 * SQLite evaluates only the selected CASE branch, so an active lock deliberately
 * raises a JSON error and rolls the whole batch back.
 */
export function assertCutoverUnlockedPlan(siteId: ActiveCheckedInSiteId): CutoverLockStatementPlan {
  const selected = selectActiveCutoverLockPlan(siteId)
  return {
    sql: `SELECT CASE WHEN NOT EXISTS (${selected.sql})
      THEN 1 ELSE json_extract('', '$') END /* cutover_unlocked */`,
    params: selected.params
  }
}

export function hasActiveCutoverLock(rows: ReadonlyArray<Record<string, unknown>>): boolean {
  return rows.some(row => typeof row.id === 'string' && row.id.startsWith(CUTOVER_LOCK_ID_PREFIX))
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}
