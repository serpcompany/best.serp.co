'use client'

import { Alert, AlertDescription, AlertTitle } from '@serpdirectory/design-system/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@serpdirectory/design-system/alert-dialog'
import { Avatar, AvatarFallback } from '@serpdirectory/design-system/avatar'
import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@serpdirectory/design-system/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle
} from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { RadioGroup, RadioGroupItem } from '@serpdirectory/design-system/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@serpdirectory/design-system/select'
import { Textarea } from '@serpdirectory/design-system/textarea'
import { ToggleGroup, ToggleGroupItem } from '@serpdirectory/design-system/toggle-group'
import {
  Ban,
  Check,
  ExternalLink,
  Info,
  MessageSquare,
  Pencil,
  TriangleAlert,
  Undo2
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { adminRequest } from './api'
import { ageWords, formatDateTime, formatSince, formatUsd, initials, listingPath } from './format'
import { Kv } from './kv'
import { LogoPreview } from './logo-preview'
import { RecordHeader } from './record-header'
import { PlanBadge, StatusBadge, type StatusKind } from './status-badge'

/**
 * The review page of one submission or owner revision (#64 screen 11): the page head with the
 * decisions, the listing preview (or the inline edit before approving), and the side cards.
 * Decisions call `/api/admin/{submissions|revisions}/<id>/<action>`; each compares and swaps on
 * the content version shown here, so a stale page gets a 409 and a prompt to reload.
 */

type LinkRel = 'follow' | 'nofollow' | 'sponsored'

export interface ReviewView {
  badge: { attempts: number; verifiedAt: string | null } | null
  badgeChecks: Array<{ checkedAt: string | null; outcome: 'fail' | 'pass'; reason: string | null }>
  block: { urlKey: string } | null
  blockKey: string
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  description: string
  duplicates: number
  id: string
  kind: 'revision' | 'submission'
  linkRel: LinkRel
  listing: { live: boolean; liveSince: string | null; slug: string } | null
  /**
   * A submission's featured image as approval would publish it (#96 round 2 B1): the hosted
   * copy, which the listing preview shows, and its key, which approval sends back. Null for a
   * revision.
   */
  featuredImage: { image: string | null; key: string | null } | null
  /** The hosted copy of `logoUrl`, or null for the fallback tile (#96 review S9). */
  logoImage: string | null
  /** The hosted logo's key, which approval sends back (null: approval leaves the tile). */
  logoKey: string | null
  /** The submitted logo source; never rendered as an image. */
  logoUrl: string
  name: string
  paid: boolean
  paidAmountCents: number | null
  queuedAt: string | null
  rejectionCategory: 'other' | 'prohibited' | null
  rejectionReason: string | null
  reviewerNote: string | null
  slug: string
  stale: boolean
  status: string
  submitter: { createdAt: string | null; email: string; otherSubmissions: number } | null
  website: string
}

interface Category {
  name: string
  slug: string
}

type DialogKind = 'allow' | 'approve' | 'changes' | 'reject' | 'rejectConfirm' | null

const DESCRIPTION_MAX = 160

function statusChip(view: ReviewView): { kind: StatusKind; label?: string } {
  if (view.kind === 'revision') {
    if (view.status === 'pending_review') return { kind: 'revision' }
    if (view.status === 'changes_requested') return { kind: 'changes' }
    if (view.status === 'approved') return { kind: 'approved' }
    if (view.status === 'rejected') return { kind: 'rejected' }
    return { kind: 'withdrawn' }
  }
  switch (view.status) {
    case 'verified':
      return view.paid ? { kind: 'paid_wait' } : { kind: 'in_review' }
    case 'paid_pending_review':
      return { kind: 'live_paid' }
    case 'changes_requested':
      return { kind: 'changes' }
    case 'approved':
      return { kind: 'approved' }
    case 'rejected':
      return view.rejectionCategory === 'prohibited' ? { kind: 'blocked' } : { kind: 'rejected' }
    case 'pending_badge':
      return { kind: 'pending_badge' }
    default:
      return { kind: 'withdrawn' }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function ReviewDetail({
  categories,
  preview,
  view
}: {
  categories: Category[]
  preview: ReactNode
  view: ReviewView
}) {
  const router = useRouter()
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [busy, setBusy] = useState(false)
  const [linkRel, setLinkRel] = useState<LinkRel>(view.linkRel)
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState({
    categorySlug: view.categorySlug,
    content: view.content,
    description: view.description,
    logoUrl: view.logoUrl,
    name: view.name
  })
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [category, setCategory] = useState<'other' | 'prohibited'>('other')
  const [error, setError] = useState<string | null>(null)

  const isSubmission = view.kind === 'submission'
  const queued = isSubmission
    ? view.status === 'verified' || view.status === 'paid_pending_review'
    : view.status === 'pending_review'
  const rejectable = isSubmission
    ? ['pending_badge', 'verified', 'paid_pending_review', 'changes_requested'].includes(
        view.status
      )
    : view.status === 'pending_review' || view.status === 'changes_requested'
  const liveNow = Boolean(view.listing?.live)
  const paidLive = isSubmission && view.status === 'paid_pending_review'
  const refundDue = isSubmission && view.paid && view.paidAmountCents !== null
  const amount = formatUsd(view.paidAmountCents ?? 0)
  const editedFields = useMemo(
    () =>
      (Object.keys(edits) as Array<keyof typeof edits>).filter(
        field => edits[field].trim() !== view[field].trim()
      ),
    [edits, view]
  )
  const basePath = `/api/admin/${isSubmission ? 'submissions' : 'revisions'}/${encodeURIComponent(view.id)}`

  const close = () => {
    setDialog(null)
    setError(null)
  }

  async function send(action: string, body: unknown, done: string): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await adminRequest(`${basePath}/${action}`, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      toast.error(result.message)
      return
    }
    setDialog(null)
    setEditing(false)
    if (result.refundPending === true) {
      // The rejection stands; the refund (#68) is retried by rejecting again or by its sweep.
      toast.warning('Rejected, but the refund didn’t go through yet. Reject again to retry it.')
    } else {
      toast.success(result.replayed ? 'Already done. Nothing changed.' : done)
    }
    router.refresh()
  }

  const approve = () =>
    send(
      'approve',
      isSubmission
        ? {
            edits: editing && editedFields.length > 0 ? edits : undefined,
            expectedContentVersion: view.contentVersion,
            // Approval adopts only the images shown here (#96 rounds 2 and 3).
            expectedImageKey: view.featuredImage?.key ?? null,
            // An edited logo URL has no hosted copy yet: the tile, until an admin sets one.
            expectedLogoKey:
              editing && editedFields.includes('logoUrl') ? null : (view.logoKey ?? null),
            linkRel
          }
        : { expectedContentVersion: view.contentVersion, expectedLogoKey: view.logoKey ?? null },
      paidLive ? `Approved. ${view.name} stays live.` : `Approved. ${view.name} is published.`
    )

  const chips = statusChip(view)
  const meta = [
    `${isSubmission ? 'Submission' : 'Revision'} ${view.id.slice(0, 8)}`,
    queued && view.queuedAt ? `waiting ${ageWords(view.queuedAt)}` : null,
    view.submitter?.email ?? null
  ]
    .filter(Boolean)
    .join(' · ')

  const actions = (() => {
    if (editing) {
      return (
        <>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel edits
          </Button>
          <Button size="sm" onClick={() => setDialog('approve')}>
            <Check />
            Approve with edits
          </Button>
        </>
      )
    }
    const buttons: ReactNode[] = []
    if (queued) {
      buttons.push(
        <Button key="changes" variant="outline" size="sm" onClick={() => setDialog('changes')}>
          Request changes
        </Button>
      )
    }
    if (rejectable) {
      buttons.push(
        <Button
          key="reject"
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setDialog('reject')}
        >
          {liveNow && isSubmission ? 'Reject and unpublish' : 'Reject'}
        </Button>
      )
    }
    if (queued && isSubmission && !paidLive) {
      buttons.push(
        <Button key="edit" variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil />
          Edit, then approve
        </Button>
      )
    }
    if (queued) {
      buttons.push(
        <Button key="approve" size="sm" onClick={() => setDialog('approve')}>
          <Check />
          {paidLive ? 'Approve (keep live)' : 'Approve'}
        </Button>
      )
    }
    if (view.status === 'approved' && view.listing) {
      buttons.push(
        <Button key="live" variant="outline" size="sm" asChild>
          <a href={listingPath(view.listing.slug)} target="_blank" rel="noreferrer">
            View live
            <ExternalLink />
          </a>
        </Button>
      )
    }
    if (view.block) {
      buttons.push(
        <Button key="allow" variant="outline" size="sm" onClick={() => setDialog('allow')}>
          <Undo2 />
          Allow resubmission
        </Button>
      )
    }
    return buttons.length ? buttons : null
  })()

  const left = editing ? (
    <Card>
      <CardHeader>
        <CardTitle>Edit before approving</CardTitle>
        <CardDescription>
          {editedFields.length === 0
            ? 'Your edits are logged with the approval.'
            : `${editedFields.length} ${editedFields.length === 1 ? 'field' : 'fields'} edited. Your edits are logged with the approval.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid gap-7 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="edit-name">Name</FieldLabel>
              <Input
                id="edit-name"
                value={edits.name}
                onChange={event => setEdits({ ...edits, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-category">Primary category</FieldLabel>
              <Select
                value={edits.categorySlug}
                onValueChange={value => setEdits({ ...edits, categorySlug: value })}
              >
                <SelectTrigger id="edit-category">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map(option => (
                    <SelectItem key={option.slug} value={option.slug}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field data-invalid={edits.description.length > DESCRIPTION_MAX || undefined}>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="edit-description">Short description</FieldLabel>
              {editedFields.includes('description') ? (
                <Badge variant="secondary" className="ml-auto">
                  Edited
                </Badge>
              ) : null}
            </div>
            <Textarea
              id="edit-description"
              value={edits.description}
              onChange={event => setEdits({ ...edits, description: event.target.value })}
            />
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'ml-auto shrink-0 text-xs tabular-nums',
                  edits.description.length > DESCRIPTION_MAX
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'
                )}
              >
                {edits.description.length}/{DESCRIPTION_MAX}
              </span>
            </div>
          </Field>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="edit-logo">Logo</FieldLabel>
              {editedFields.includes('logoUrl') ? (
                <Badge variant="secondary" className="ml-auto">
                  Edited
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <LogoPreview
                hosted={edits.logoUrl.trim() === view.logoUrl ? view.logoImage : null}
                name={edits.name}
                source={edits.logoUrl}
                website={view.website}
              />
              <Input
                id="edit-logo"
                className="font-mono text-[13px]"
                value={edits.logoUrl}
                onChange={event => setEdits({ ...edits, logoUrl: event.target.value })}
              />
            </div>
            <FieldDescription>
              A square image URL (PNG, JPG or WebP). It is copied to our media host on approval.
            </FieldDescription>
          </Field>
          <Field>
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="edit-content">
                Long description{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              {editedFields.includes('content') ? (
                <Badge variant="secondary" className="ml-auto">
                  Edited
                </Badge>
              ) : null}
            </div>
            <Textarea
              id="edit-content"
              className="min-h-36"
              value={edits.content}
              onChange={event => setEdits({ ...edits, content: event.target.value })}
            />
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  ) : (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <CardDescription>
          {listingPath(view.slug)} · {liveNow ? 'public now' : 'not public yet'}
        </CardDescription>
      </CardHeader>
      <CardContent>{preview}</CardContent>
    </Card>
  )

  const badgeCard = view.paid ? (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Badge</CardTitle>
        <CardDescription>Optional for paid listings. Not checked.</CardDescription>
      </CardHeader>
    </Card>
  ) : (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Badge checks</CardTitle>
      </CardHeader>
      <CardContent>
        {view.badge?.verifiedAt ? (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{formatDateTime(view.badge.verifiedAt)}</span>
              <StatusBadge kind="pass" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Dofollow link to {listingPath(view.slug)} found on {view.website}.{' '}
              {view.badge.attempts} of 10 checks used.
            </p>
          </>
        ) : view.badgeChecks.length > 0 ? (
          <div className="flex flex-col gap-2">
            {view.badgeChecks.slice(0, 3).map(check => (
              <div
                key={`${check.checkedAt}-${check.outcome}`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>{formatDateTime(check.checkedAt)}</span>
                <StatusBadge kind={check.outcome} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No badge checks yet.</p>
        )}
      </CardContent>
    </Card>
  )

  const right = (
    <>
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Submitted</CardTitle>
        </CardHeader>
        <CardContent>
          <Kv
            rows={[
              [
                'URL',
                <span key="u" className="font-mono text-[13px]">
                  {view.website}
                </span>
              ],
              [
                'Matched on',
                <span key="m">
                  <span className="font-mono text-[13px]">{view.blockKey}</span>
                  {view.duplicates === 0
                    ? ', no duplicate'
                    : `, ${view.duplicates} ${view.duplicates === 1 ? 'duplicate' : 'duplicates'}`}
                </span>
              ],
              ['Category', view.categoryName ?? view.categorySlug],
              ['Plan', view.paid ? `Paid · ${amount}` : 'Free (badge)'],
              ['Logo', `From ${hostOf(view.logoUrl)}`]
            ]}
          />
        </CardContent>
      </Card>
      {isSubmission ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Outbound link</CardTitle>
            <CardDescription>Default for new submissions is nofollow.</CardDescription>
          </CardHeader>
          <CardContent>
            <ToggleGroup
              type="single"
              variant="outline"
              value={linkRel}
              disabled={!queued}
              onValueChange={value => value && setLinkRel(value as LinkRel)}
              aria-label="Outbound link"
            >
              <ToggleGroupItem value="follow" className="px-3">
                follow
              </ToggleGroupItem>
              <ToggleGroupItem value="nofollow" className="px-3">
                nofollow
              </ToggleGroupItem>
              <ToggleGroupItem value="sponsored" className="px-3">
                sponsored
              </ToggleGroupItem>
            </ToggleGroup>
          </CardContent>
        </Card>
      ) : null}
      {badgeCard}
      {view.submitter ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Submitter</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarFallback>{initials(view.submitter.email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium">{view.submitter.email}</p>
                <p className="text-xs text-muted-foreground">
                  Since {formatSince(view.submitter.createdAt)} ·{' '}
                  {view.submitter.otherSubmissions === 0
                    ? 'no other submissions'
                    : `${view.submitter.otherSubmissions} other ${view.submitter.otherSubmissions === 1 ? 'submission' : 'submissions'}`}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  )

  const banner = (() => {
    if (paidLive && view.listing) {
      return (
        <Alert className="border-sky-500/40 bg-card text-sky-700 dark:text-sky-400">
          <Info />
          <AlertTitle>
            Live since {formatDateTime(view.listing.liveSince)} UTC, after payment
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Automatic checks passed: public URL, page loads (HTTP 200), not a duplicate, safe-fetch
            rules. Approving keeps it live. Rejecting unpublishes it, and refunds unless you tag it
            prohibited.
          </AlertDescription>
        </Alert>
      )
    }
    if (view.status === 'changes_requested' && view.reviewerNote) {
      return (
        <Alert>
          <MessageSquare />
          <AlertTitle>Waiting for the {isSubmission ? 'submitter' : 'owner'}</AlertTitle>
          <AlertDescription>Your note: “{view.reviewerNote}”</AlertDescription>
        </Alert>
      )
    }
    if (view.status === 'rejected' && view.rejectionReason) {
      return (
        <Alert variant={view.rejectionCategory === 'prohibited' ? 'destructive' : 'default'}>
          <Ban />
          <AlertTitle>
            {view.rejectionCategory === 'prohibited' ? 'Rejected as prohibited' : 'Rejected'}
          </AlertTitle>
          <AlertDescription>
            <p>“{view.rejectionReason}”</p>
            {view.block ? (
              <p>
                Nobody can submit, pay for, or claim this URL until an admin allows resubmission.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      )
    }
    if (!isSubmission && view.stale && queued) {
      return (
        <Alert className="border-amber-500/40 bg-card text-amber-700 dark:text-amber-400">
          <TriangleAlert />
          <AlertTitle>The listing changed after this revision was made</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Approving would overwrite those changes, so it’s refused. Request changes or reject it.
          </AlertDescription>
        </Alert>
      )
    }
    return null
  })()

  const categoryCards = (
    <FieldSet>
      <FieldLegend variant="label">Category</FieldLegend>
      <RadioGroup
        value={category}
        onValueChange={value => setCategory(value as 'other' | 'prohibited')}
      >
        <FieldLabel htmlFor="category-prohibited">
          <Field orientation="horizontal">
            <RadioGroupItem value="prohibited" id="category-prohibited" />
            <FieldContent>
              <FieldTitle>Prohibited by the Terms</FieldTitle>
              <FieldDescription>
                {refundDue
                  ? 'No refund.'
                  : 'Malware, scams, illegal goods, IP infringement, hate, impersonation, spam or parked pages.'}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="category-other">
          <Field orientation="horizontal">
            <RadioGroupItem value="other" id="category-other" />
            <FieldContent>
              <FieldTitle>Other</FieldTitle>
              <FieldDescription>
                {refundDue
                  ? `Full refund of ${amount}, automatically.`
                  : 'Anything else. The submitter can edit and resubmit.'}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      </RadioGroup>
    </FieldSet>
  )

  const reject = () =>
    send(
      'reject',
      isSubmission ? { category, reason } : { reason },
      liveNow ? `Rejected. ${view.name} was unpublished.` : `Rejected ${view.name}.`
    )

  return (
    <>
      <RecordHeader
        actions={actions}
        chips={
          <>
            <StatusBadge kind={chips.kind} label={chips.label} />
            <PlanBadge paid={view.paid} />
            {isSubmission && !view.paid && view.badge?.verifiedAt ? (
              <StatusBadge kind="pass" label="Badge pass" />
            ) : null}
          </>
        }
        logoUrl={view.logoImage}
        meta={meta}
        name={view.name}
        website={view.website}
      />
      {banner}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">{left}</div>
        <div className="flex flex-col gap-4">{right}</div>
      </div>

      <AlertDialog open={dialog === 'approve'} onOpenChange={open => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Approve and publish {editing ? edits.name : view.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It’s published to production and the decision is logged under your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Kv
            rows={[
              [
                'Goes live at',
                liveNow
                  ? `${listingPath(view.slug)}, already live`
                  : `${listingPath(view.slug)}, within about a minute`
              ],
              ['Outbound link', isSubmission ? linkRel : view.linkRel],
              [
                'Email',
                isSubmission && !view.paid && view.submitter
                  ? `“Approved” to ${view.submitter.email}`
                  : 'None'
              ]
            ]}
          />
          {error ? <FieldError>{error}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void approve()
              }}
            >
              Approve and publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialog === 'changes'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>
              {view.name} leaves the queue until the {isSubmission ? 'submitter' : 'owner'}{' '}
              resubmits.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="changes-note">
              Note to the {isSubmission ? 'submitter' : 'owner'}
            </FieldLabel>
            <Textarea
              id="changes-note"
              value={note}
              onChange={event => setNote(event.target.value)}
            />
            {error ? (
              <FieldError>{error}</FieldError>
            ) : (
              <FieldDescription>
                {isSubmission && view.submitter
                  ? `${view.submitter.email} gets an email with this note.`
                  : 'Shown in their account.'}
              </FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !note.trim()}
              onClick={() => void send('request-changes', { note }, 'Changes requested.')}
            >
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'reject'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {view.name}</DialogTitle>
            <DialogDescription>
              {!isSubmission
                ? 'The live listing stays as it is.'
                : refundDue
                  ? liveNow
                    ? `${view.name} is live and paid (${amount}). Rejecting unpublishes it right away.`
                    : `${view.name} is paid (${amount}).`
                  : liveNow
                    ? `${view.name} is live. Rejecting unpublishes it right away.`
                    : 'Free submission. No payment to refund.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-6">
            <Field>
              <FieldLabel htmlFor="reject-reason">Reason</FieldLabel>
              <Textarea
                id="reject-reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
              />
              <FieldDescription>
                Shown in their account and in the rejection email.
              </FieldDescription>
            </Field>
            {isSubmission ? categoryCards : null}
            {refundDue ? (
              category === 'prohibited' ? (
                <Alert className="border-amber-500/40 bg-card text-amber-700 dark:text-amber-400">
                  <TriangleAlert />
                  <AlertTitle>No refund</AlertTitle>
                  <AlertDescription className="text-muted-foreground">
                    Unpublish now and email the rejection with this reason.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <Info />
                  <AlertTitle>Refund {amount} automatically</AlertTitle>
                  <AlertDescription>
                    Unpublish now and email the rejection with this reason.
                  </AlertDescription>
                </Alert>
              )
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !reason.trim()}
              onClick={() => {
                if (refundDue) {
                  setError(null)
                  setDialog('rejectConfirm')
                } else {
                  void reject()
                }
              }}
            >
              {refundDue
                ? category === 'prohibited'
                  ? 'Reject without refund'
                  : `Reject and refund ${amount}`
                : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog === 'rejectConfirm'} onOpenChange={open => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {category === 'prohibited'
                ? `Reject ${view.name} without a refund?`
                : `Reject ${view.name} and refund ${amount}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {liveNow
                ? `This unpublishes ${listingPath(view.slug)} within about a minute`
                : 'This rejects it'}
              {category === 'prohibited'
                ? ' and blocks the domain. It can’t be undone from here.'
                : ` and refunds ${amount} through Stripe. It can’t be undone from here.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <FieldError>{error}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                setError(null)
                setDialog('reject')
              }}
            >
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void reject()
              }}
            >
              {category === 'prohibited' ? 'Yes, reject without refund' : 'Yes, reject and refund'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'allow'} onOpenChange={open => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow {view.block?.urlKey} to be submitted again?</AlertDialogTitle>
            <AlertDialogDescription>
              The block is lifted. Anyone can then submit or claim this URL, and any new submission
              goes through review as usual. This is logged under your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <FieldError>{error}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void send(
                  'allow-resubmission',
                  { urlKey: view.block?.urlKey ?? '' },
                  'Resubmission allowed.'
                )
              }}
            >
              Allow resubmission
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
