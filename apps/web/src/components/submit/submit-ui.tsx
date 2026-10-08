'use client'

import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import { Badge } from '@serpdirectory/design-system/badge'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { Progress } from '@serpdirectory/design-system/progress'
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Info,
  Loader,
  type LucideIcon,
  Pencil,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import type { ReactNode } from 'react'
import { ListingImage } from '@/components/ui/listing-image'
import type { SubmissionStatusName } from '@/lib/submissions/contract'

/**
 * Building blocks shared by the submit pages (#70 screens 2, 2b, 3) and the account table:
 * the step progress, status badges, toned alerts, and the product logo.
 */

/** `Step 2 of 4` above a Progress bar (#70 StepProgress). */
export function StepProgress({
  label,
  step,
  total
}: {
  label: string
  step: number
  total: number
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          Step {step} of {total}
        </span>
      </div>
      <Progress
        value={Math.round((step / total) * 100)}
        aria-label={`${label}: step ${step} of ${total}`}
      />
    </div>
  )
}

export type AlertTone = 'default' | 'destructive' | 'info' | 'success' | 'warning'

const TONE_CLASSES: Record<AlertTone, string> = {
  default: 'bg-card text-card-foreground',
  destructive: '',
  info: 'border-sky-500/40 bg-card text-sky-700 dark:text-sky-400',
  success: 'border-emerald-500/40 bg-card text-emerald-700 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-card text-amber-700 dark:text-amber-400'
}

const TONE_ICONS: Record<AlertTone, LucideIcon> = {
  default: Info,
  destructive: CircleX,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert
}

/**
 * The mockups' Alert: `default` and `destructive` are stock shadcn variants; `warning`,
 * `success`, and `info` are className tones on the default variant.
 */
export function ToneAlert({
  actions,
  children,
  className,
  icon,
  title,
  tone = 'default'
}: {
  actions?: ReactNode
  children?: ReactNode
  className?: string
  icon?: LucideIcon
  title: ReactNode
  tone?: AlertTone
}) {
  const Icon = icon ?? TONE_ICONS[tone]
  return (
    <Alert
      variant={tone === 'destructive' ? 'destructive' : 'default'}
      className={cn(TONE_CLASSES[tone], className)}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {children || actions ? (
        <AlertDescription className="[overflow-wrap:anywhere] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs">
          {children}
          {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  )
}

const STATUS: Record<SubmissionStatusName, { icon: LucideIcon; iconClass: string; label: string }> =
  {
    approved: { icon: CircleCheck, iconClass: 'text-emerald-500', label: 'Live' },
    changes_requested: {
      icon: CircleAlert,
      iconClass: 'text-orange-500',
      label: 'Changes requested'
    },
    draft: { icon: Pencil, iconClass: 'text-muted-foreground', label: 'Draft – choose a plan' },
    paid_pending_review: {
      icon: CircleCheck,
      iconClass: 'text-teal-500',
      label: 'Live (paid, in review)'
    },
    pending_badge: { icon: Clock, iconClass: 'text-amber-500', label: 'Pending badge' },
    rejected: { icon: CircleX, iconClass: 'text-red-500', label: 'Rejected' },
    verified: { icon: Loader, iconClass: 'text-sky-500', label: 'In review' },
    withdrawn: { icon: Undo2, iconClass: 'text-muted-foreground', label: 'Withdrawn' }
  }

/** dashboard-01's status badge: an outline Badge with a colored lucide icon. */
export function SubmissionStatusBadge({ status }: { status: SubmissionStatusName }) {
  const { icon: Icon, iconClass, label } = STATUS[status]
  return (
    <Badge variant="outline" className="px-1.5 text-muted-foreground">
      <Icon className={iconClass} aria-hidden="true" />
      {label}
    </Badge>
  )
}

/**
 * The product's logo in a rounded square: the shared listing image (#122), so a missing or
 * broken logo is the #86 tile, never alt text or a broken-image icon.
 */
export function ProductLogo({
  className,
  name,
  size = 40,
  src
}: {
  className?: string
  name: string
  size?: number
  src: string | null | undefined
}) {
  return <ListingImage className={cn('rounded-lg', className)} name={name} size={size} src={src} />
}
