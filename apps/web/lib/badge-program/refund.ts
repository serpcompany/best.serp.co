import type {
  BadgeCheckRecord,
  BadgeProgramOperations
} from '@serpdirectory/data-ops/badge-program'
import { badgeCheckRecord, type VerifyListingBadge } from './program'

/**
 * The badge check at refund (#68; owner decision on #59 and #106, 2026-10-06): when a paid
 * listing is refunded, its badge is checked once, right then, and the refund decides on that
 * check alone. #68 calls this, then passes `checkId` to `buildRefundSubmissionPlans` within
 * `REFUND_BADGE_CHECK_MAX_AGE_HOURS`:
 * - `keepFree: true` (a pass): `keep_free` keeps the listing up as a free listing, which then
 *   joins the weekly program. The plan refuses unless that check is the listing's latest refund
 *   check and passed.
 * - `keepFree: false` (a miss, a 4xx, or a result that can't tell: a timeout, a 5xx):
 *   `unpublish` takes it down. The plan refuses unless that check did not pass, so an earlier
 *   weekly pass can neither keep the listing nor block the unpublish (#106 review round 2).
 * The check is recorded in `badge_checks` as `kind = 'refund'`, the only write there outside the
 * weekly program.
 */
export interface RefundBadgeCheck {
  checkId: number
  /** True only for a pass: the refund keeps the listing as a free one. */
  keepFree: boolean
  record: BadgeCheckRecord
}

export async function checkBadgeAtRefund(input: {
  listingId: string
  now: Date
  operations: Pick<BadgeProgramOperations, 'recordRefundCheck' | 'refundCheckTarget'>
  verify: VerifyListingBadge
}): Promise<RefundBadgeCheck> {
  const target = await input.operations.refundCheckTarget(input.listingId)
  if (!target) throw new Error('The refunded listing is not an approved listing.')
  let record: BadgeCheckRecord
  try {
    record = badgeCheckRecord(await input.verify(target))
  } catch {
    record = { conclusive: false, outcome: 'fail', reason: 'verification_service_error' }
  }
  const { id } = await input.operations.recordRefundCheck({
    listingId: target.id,
    now: input.now.toISOString(),
    result: record
  })
  return { checkId: id, keepFree: record.outcome === 'pass', record }
}
