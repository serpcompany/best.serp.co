import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  EyeOff,
  Loader,
  type LucideIcon,
  MessageSquare,
  Pencil,
  Undo2
} from 'lucide-react'
import { StatusChip, type StatusTone } from '@/components/status/status-chip'
import { Badge } from '@/components/ui/badge'
import type { AccountStatus } from '@/lib/account/view'

/**
 * The dashboard's status chips (#70 screen 5 and its legend), as the admin panel shows them:
 * each entry is its label, icon, tone, and whether the circle is filled (live and final states).
 */
const STATUS: Record<AccountStatus | 'revision', [string, LucideIcon, StatusTone, true?]> = {
  changes: ['Changes requested', MessageSquare, 'warning'],
  in_review: ['In review', Loader, 'info'],
  live: ['Live', CircleCheck, 'success', true],
  live_paid: ['Live (paid, in review)', CircleCheck, 'success', true],
  pending_badge: ['Pending badge', Clock, 'warning'],
  plan_draft: ['Draft – choose a plan', Pencil, 'muted'],
  rejected: ['Rejected', CircleX, 'destructive', true],
  revision: ['Edits in review', Loader, 'info'],
  unlisted: ['Unlisted', EyeOff, 'muted'],
  withdrawn: ['Withdrawn', Undo2, 'muted']
}

export function AccountStatusBadge({
  className,
  label,
  status
}: {
  className?: string
  label?: string
  status: AccountStatus | 'revision'
}) {
  const [text, icon, tone, filled] = STATUS[status]
  return (
    <StatusChip className={className} filled={filled} icon={icon} tone={tone}>
      {label ?? text}
    </StatusChip>
  )
}

/** "Paid" (filled), "Free" (outline), or a dash before a plan is chosen. */
export function PlanCell({ plan }: { plan: 'free' | 'paid' | null }) {
  if (!plan) return <span className="text-muted-foreground">—</span>
  return (
    <Badge variant={plan === 'paid' ? 'default' : 'outline'}>
      {plan === 'paid' ? 'Paid' : 'Free'}
    </Badge>
  )
}

/** A badge check's result: pass, a conclusive fail, or an inconclusive one (timed out, …). */
export function CheckResultBadge({
  conclusive,
  label,
  outcome
}: {
  conclusive: boolean
  label: string
  outcome: 'fail' | 'pass'
}) {
  const [icon, tone]: [LucideIcon, StatusTone] =
    outcome === 'pass'
      ? [CircleCheck, 'success']
      : conclusive
        ? [CircleX, 'destructive']
        : [CircleMinus, 'muted']
  return (
    <StatusChip filled={tone !== 'muted'} icon={icon} tone={tone}>
      {label}
    </StatusChip>
  )
}

/**
 * "What the statuses mean" (#70 screen 5). Wording that needs a later area follows its flag: the
 * paid choice (#68), Messages (#73), and the badge program's unlisting (#66).
 */
export function statusLegend(areas: {
  badgeProgram: boolean
  messages: boolean
  showPaid: boolean
}): ReadonlyArray<[AccountStatus, string]> {
  return [
    [
      'plan_draft',
      `Saved, but you haven’t picked ${areas.showPaid ? 'free or paid' : 'how to get listed'}. Nothing is reviewed yet. Drafts expire after 30 days.`
    ],
    ['pending_badge', 'You chose free. Install or verify the badge to send it to review.'],
    ['in_review', 'Waiting for a reviewer.'],
    ['changes', 'A reviewer asked for changes. Edit and resubmit.'],
    ['live', 'Published on best.serp.co.'],
    ['live_paid', 'Paid and published; a reviewer still signs off.'],
    [
      'rejected',
      areas.messages
        ? 'Not approved. The reason is in the submission and in Messages.'
        : 'Not approved. The reason is in the submission.'
    ],
    ['withdrawn', 'You withdrew it.'],
    [
      'unlisted',
      areas.badgeProgram && areas.showPaid
        ? 'Removed after a confirmed badge miss. Relisting is paid.'
        : 'Removed from best.serp.co.'
    ]
  ]
}
