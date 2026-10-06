import type {
  BadgeCheckRecord,
  BadgeProgramOperations
} from '@serpdirectory/data-ops/badge-program'
import { badgeCheckRecord, type VerifyListingBadge } from './program'

/**
 * The badge check at refund (#68; owner decision on #59 and #106, 2026-10-06): when a paid
 * listing is refunded, its badge is checked once, right then. A pass keeps it up as a free
 * listing, which then joins the weekly program (`buildRefundSubmissionPlans` with `keep_free`
 * reads this check: a conclusive pass within `KEEP_FREE_BADGE_MAX_AGE_HOURS`). A miss, or a
 * result that can't tell (a timeout, a 5xx), unpublishes it (`unpublish`), as a refund does
 * without the exception. The check is recorded in `badge_checks` as `kind = 'refund'`, the only
 * write there outside the weekly program. #68 calls this before it builds the refund plans.
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
