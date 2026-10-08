import type { AccountEvent, AccountSubmissionDetail } from '@/db/account'
import { formatStamp } from './format'

/**
 * A submission's history card (#70 screen 6): its events, newest first, as the submitter reads
 * them. Bookkeeping (plan choice, failed badge checks, edits) is left out. The first badge pass
 * also marks when the submission entered review, as the mockup shows.
 */

export interface HistoryItem {
  detail: string
  key: string
  title: string
  tone: 'err' | 'muted' | 'now' | 'ok' | 'warn'
}

const PAID_AMOUNT = '$49.00'

function title(
  event: AccountEvent,
  submission: AccountSubmissionDetail
): HistoryItem['title'] | null {
  switch (event.type) {
    case 'created':
      return 'Submitted'
    case 'paid':
      return `Paid ${PAID_AMOUNT}`
    case 'resubmitted':
      return 'Resubmitted'
    case 'changes_requested':
      return 'Changes requested'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return submission.rejection?.category === 'prohibited'
        ? 'Rejected (prohibited, no refund)'
        : 'Rejected'
    case 'refunded':
      return `Refunded ${PAID_AMOUNT}`
    case 'unpublished':
      return 'Unpublished'
    case 'expired':
      return 'Draft expired'
    case 'withdrawn':
      return submission.withdrawalReason === 'admin'
        ? 'Cleared by the SERP team'
        : 'Withdrawn by you'
    default:
      return null
  }
}

const TONES: Record<string, HistoryItem['tone']> = {
  'Changes requested': 'warn',
  Approved: 'ok',
  'Badge verified': 'ok',
  Rejected: 'err',
  'Rejected (prohibited, no refund)': 'err',
  'Withdrawn by you': 'err'
}

export function submissionHistory(submission: AccountSubmissionDetail): HistoryItem[] {
  const firstPass = [...submission.events].reverse().find(event => event.type === 'badge_verified')
  const items: HistoryItem[] = []
  for (const [index, event] of submission.events.entries()) {
    const detail = formatStamp(event.at)
    if (event.type === 'badge_verified') {
      if (event !== firstPass) continue
      items.push({ detail, key: `${index}-review`, title: 'In review', tone: 'muted' })
      items.push({ detail, key: `${index}`, title: 'Badge verified', tone: 'ok' })
      continue
    }
    const text = title(event, submission)
    if (!text) continue
    items.push({ detail, key: `${index}`, title: text, tone: TONES[text] ?? 'muted' })
  }
  // The newest entry is "now" while the submission waits for a reviewer.
  const first = items[0]
  if (
    first &&
    (submission.status === 'verified' || submission.status === 'paid_pending_review') &&
    (first.title === 'In review' || first.title === 'Resubmitted')
  ) {
    items[0] = { ...first, tone: 'now' }
  }
  return items
}
