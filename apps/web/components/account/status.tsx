import { Badge } from '@serpdirectory/design-system/badge'
import { cn } from '@serpdirectory/design-system/lib/utils'
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  EyeOff,
  Loader,
  MessageSquare,
  Pencil,
  Undo2
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AccountStatus } from '@/lib/account/view'

/**
 * The dashboard's status chips (#70 screen 5 and its legend): dashboard-01's outline Badge with
 * a colored lucide icon, filled circles for live and final states, as the admin panel shows them.
 */
const STATUS: Record<AccountStatus | 'revision', [string, ReactNode]> = {
  changes: ['Changes requested', <MessageSquare key="i" className="text-orange-500" />],
  in_review: ['In review', <Loader key="i" className="text-sky-500" />],
  live: [
    'Live',
    <CircleCheck key="i" className="fill-emerald-500 text-background dark:fill-emerald-400" />
  ],
  live_paid: [
    'Live (paid, in review)',
    <CircleCheck key="i" className="fill-teal-500 text-background dark:fill-teal-400" />
  ],
  pending_badge: ['Pending badge', <Clock key="i" className="text-amber-500" />],
  plan_draft: ['Draft – choose a plan', <Pencil key="i" className="text-muted-foreground" />],
  rejected: [
    'Rejected',
    <CircleX key="i" className="fill-red-500 text-background dark:fill-red-400" />
  ],
  revision: ['Edits in review', <Loader key="i" className="text-sky-500" />],
  unlisted: ['Unlisted', <EyeOff key="i" className="text-muted-foreground" />],
  withdrawn: ['Withdrawn', <Undo2 key="i" className="text-muted-foreground" />]
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
  const [text, icon] = STATUS[status]
  return (
    <Badge variant="outline" className={cn('px-1.5 text-muted-foreground', className)}>
      {icon}
      {label ?? text}
    </Badge>
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
  const icon =
    outcome === 'pass' ? (
      <CircleCheck className="fill-emerald-500 text-background dark:fill-emerald-400" />
    ) : conclusive ? (
      <CircleX className="fill-red-500 text-background dark:fill-red-400" />
    ) : (
      <CircleMinus className="text-muted-foreground" />
    )
  return (
    <Badge variant="outline" className="px-1.5 text-muted-foreground">
      {icon}
      {label}
    </Badge>
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
