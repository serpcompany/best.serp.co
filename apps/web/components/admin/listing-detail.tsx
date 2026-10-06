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
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel
} from '@serpdirectory/design-system/field'
import { Input } from '@serpdirectory/design-system/input'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle
} from '@serpdirectory/design-system/item'
import { cn } from '@serpdirectory/design-system/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@serpdirectory/design-system/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@serpdirectory/design-system/table'
import { Textarea } from '@serpdirectory/design-system/textarea'
import { ToggleGroup, ToggleGroupItem } from '@serpdirectory/design-system/toggle-group'
import { Ban, ExternalLink, EyeOff, Undo2, Users } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { adminRequest } from './api'
import { formatDay, initials, listingPath } from './format'
import { Kv } from './kv'
import { ProductLogo } from './product-cell'
import { RecordHeader } from './record-header'
import { StatusBadge, type StatusKind } from './status-badge'

/**
 * One listing (#64 screen 12): details, outbound link, owner, badge checks, and activity, with
 * unpublish or republish, transfer and remove owner, and "Allow resubmission" for a URL blocked
 * by a prohibited rejection. Each action posts to `/api/admin/listings/<id>/<action>`.
 */

type LinkRel = 'follow' | 'nofollow' | 'sponsored'

export interface ListingDetailView {
  activity: Array<{ detail: string; key: string; title: string; tone?: 'err' | 'ok' | 'warn' }>
  adminStatus: 'blocked' | 'draft' | 'live' | 'rejected' | 'unlisted'
  badgeChecks: Array<{
    checkedAt: string | null
    key: string
    note: string
    outcome: 'fail' | 'pass'
    conclusive: boolean
  }>
  block: { blockedAt: string | null; blockedBy: string; reason: string; urlKey: string } | null
  categoryName: string | null
  categorySlug: string | null
  checksum: string
  description: string
  id: string
  linkRel: LinkRel
  logoUrl: string | null
  meta: string
  name: string
  owner: {
    email: string
    userId: string
    verifiedAt: string | null
    verifiedVia: string
    verifiedViaLabel: string
  } | null
  slug: string
  submission: {
    id: string
    paidLabel: string | null
    submitterCreatedAt: string | null
    submitterEmail: string | null
  } | null
  submissionQueued: boolean
  unpublished: { at: string | null; by: string; note: string | null } | null
  website: string
}

interface Category {
  name: string
  slug: string
}

type DialogKind = 'allow' | 'removeOwner' | 'transfer' | 'unpublish' | null

const DESCRIPTION_MAX = 160

const statusKinds: Record<ListingDetailView['adminStatus'], StatusKind> = {
  blocked: 'blocked',
  draft: 'draft',
  live: 'live',
  rejected: 'rejected',
  unlisted: 'unlisted'
}

function ownerNote(verifiedVia: string): string {
  if (verifiedVia === 'badge_claim') {
    return 'Badge claim: weekly checks are on. If the badge is confirmed missing, ownership is removed and the listing stays live.'
  }
  if (verifiedVia === 'paid_claim') return 'Paid claim: ownership doesn’t depend on a badge.'
  if (verifiedVia === 'submission') return 'They submitted this listing.'
  return 'An admin made them the owner.'
}

function Timeline({ items }: { items: ListingDetailView['activity'] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>
  return (
    <ol className="space-y-4">
      {items.map(item => (
        <li key={item.key} className="flex gap-3">
          <span
            className={cn(
              'mt-1.5 size-2 shrink-0 rounded-full',
              item.tone === 'ok'
                ? 'bg-emerald-500'
                : item.tone === 'warn'
                  ? 'bg-orange-500'
                  : item.tone === 'err'
                    ? 'bg-red-500'
                    : 'bg-muted-foreground/40'
            )}
          />
          <div className="text-sm">
            <p className="font-medium">{item.title}</p>
            <p className="text-xs text-muted-foreground">{item.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function ListingDetail({
  categories,
  view
}: {
  categories: Category[]
  view: ListingDetailView
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialDialog = searchParams.get('dialog')
  const [dialog, setDialog] = useState<DialogKind>(
    initialDialog === 'transfer' || (initialDialog === 'unpublish' && view.adminStatus === 'live')
      ? initialDialog
      : null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState({
    categorySlug: view.categorySlug ?? '',
    description: view.description,
    logoUrl: view.logoUrl ?? '',
    name: view.name,
    website: view.website
  })
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [linkRel, setLinkRel] = useState<LinkRel>(view.linkRel)
  const [note, setNote] = useState('')
  const [transferEmail, setTransferEmail] = useState('')

  const base = `/api/admin/listings/${encodeURIComponent(view.id)}`
  const readOnly = view.adminStatus === 'blocked' || view.adminStatus === 'rejected'
  const editable = !readOnly && !view.submissionQueued

  const close = () => {
    setDialog(null)
    setError(null)
  }

  async function send(
    action: string,
    body: unknown,
    done: string,
    onError: (message: string) => void = setError
  ): Promise<boolean> {
    setBusy(true)
    onError('')
    const result = await adminRequest(`${base}/${action}`, body)
    setBusy(false)
    if (!result.ok) {
      onError(result.message)
      toast.error(result.message)
      return false
    }
    setDialog(null)
    toast.success(result.replayed ? 'Already done. Nothing changed.' : done)
    router.refresh()
    return true
  }

  const head = (() => {
    const actions: ReactNode[] = []
    if (view.adminStatus === 'live') {
      actions.push(
        <Button key="live" variant="outline" size="sm" asChild>
          <a href={listingPath(view.slug)} target="_blank" rel="noreferrer">
            View live
            <ExternalLink />
          </a>
        </Button>,
        <Button
          key="unpublish"
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setDialog('unpublish')}
        >
          Unpublish
        </Button>
      )
    }
    if (view.adminStatus === 'unlisted') {
      actions.push(
        <Button
          key="republish"
          size="sm"
          disabled={busy}
          onClick={() => void send('republish', {}, `${view.name} is live again.`)}
        >
          <Undo2 />
          Republish
        </Button>
      )
    }
    if (view.block) {
      actions.push(
        <Button key="allow" variant="outline" size="sm" onClick={() => setDialog('allow')}>
          <Undo2 />
          Allow resubmission
        </Button>
      )
    }
    return (
      <RecordHeader
        actions={actions.length ? actions : null}
        chips={<StatusBadge kind={statusKinds[view.adminStatus]} />}
        logoUrl={view.logoUrl}
        meta={view.meta}
        name={view.name}
        website={view.website}
      />
    )
  })()

  const notice = (() => {
    if (view.block) {
      return (
        <Alert variant="destructive">
          <Ban />
          <AlertTitle>Resubmission is blocked</AlertTitle>
          <AlertDescription>
            <p>
              Rejected as prohibited on {formatDay(view.block.blockedAt)} by {view.block.blockedBy}:
              “{view.block.reason}”{view.submission?.paidLabel ? ' No refund.' : ''}
            </p>
            <p>Nobody can submit, pay for, or claim this URL until an admin allows resubmission.</p>
          </AlertDescription>
        </Alert>
      )
    }
    if (view.unpublished) {
      return (
        <Alert>
          <EyeOff />
          <AlertTitle>
            Unpublished {formatDay(view.unpublished.at)} by {view.unpublished.by}
          </AlertTitle>
          <AlertDescription>
            {view.unpublished.note ? `Note: “${view.unpublished.note}” ` : ''}Removed from the site,
            search, sitemap and RSS. The URL returns 410 Gone with a page that points to its
            category. Republish to bring it back.
          </AlertDescription>
        </Alert>
      )
    }
    if (view.submissionQueued && view.submission) {
      return (
        <Alert>
          <AlertTitle>Its submission is in review</AlertTitle>
          <AlertDescription>
            <p>
              Edit, approve, or reject it on the{' '}
              <Link
                className="underline underline-offset-4"
                href={`/admin/submissions/${encodeURIComponent(view.submission.id)}/`}
              >
                review page
              </Link>
              . Until then the details here are read-only and the listing can’t be unpublished.
            </p>
          </AlertDescription>
        </Alert>
      )
    }
    return null
  })()

  const detailsCard = readOnly ? (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          Read-only while the listing is {view.block ? 'blocked' : 'rejected'}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Kv
          rows={[
            ['Name', view.name],
            [
              'URL',
              <span key="u" className="font-mono text-[13px]">
                {view.website}
              </span>
            ],
            ['Category', view.categoryName ?? '—'],
            [
              'Short description',
              <span key="d" className="font-normal">
                {view.description}
              </span>
            ],
            ...(view.submission?.paidLabel
              ? ([['Payment', view.submission.paidLabel]] as Array<[string, ReactNode]>)
              : [])
          ]}
        />
      </CardContent>
    </Card>
  ) : (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid gap-7 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="listing-name">Name</FieldLabel>
              <Input
                id="listing-name"
                disabled={!editable}
                value={details.name}
                onChange={event => setDetails({ ...details, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="listing-category">Primary category</FieldLabel>
              <Select
                disabled={!editable}
                value={details.categorySlug}
                onValueChange={value => setDetails({ ...details, categorySlug: value })}
              >
                <SelectTrigger id="listing-category">
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
          <Field>
            <FieldLabel htmlFor="listing-website">Website URL</FieldLabel>
            <Input
              id="listing-website"
              className="font-mono text-[13px]"
              disabled={!editable}
              value={details.website}
              onChange={event => setDetails({ ...details, website: event.target.value })}
            />
          </Field>
          <Field data-invalid={details.description.length > DESCRIPTION_MAX || undefined}>
            <FieldLabel htmlFor="listing-description">Short description</FieldLabel>
            <Textarea
              id="listing-description"
              disabled={!editable}
              value={details.description}
              onChange={event => setDetails({ ...details, description: event.target.value })}
            />
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'ml-auto shrink-0 text-xs tabular-nums',
                  details.description.length > DESCRIPTION_MAX
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'
                )}
              >
                {details.description.length}/{DESCRIPTION_MAX}
              </span>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="listing-logo">Logo</FieldLabel>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <ProductLogo
                className="rounded-lg"
                logoUrl={details.logoUrl}
                name={details.name}
                size={64}
                website={details.website}
              />
              <Input
                id="listing-logo"
                className="font-mono text-[13px]"
                disabled={!editable}
                value={details.logoUrl}
                onChange={event => setDetails({ ...details, logoUrl: event.target.value })}
              />
            </div>
            <FieldDescription>A square image URL (PNG, JPG, SVG or WebP).</FieldDescription>
          </Field>
          {detailsError ? <FieldError>{detailsError}</FieldError> : null}
        </FieldGroup>
      </CardContent>
      <CardFooter className="border-t pt-6">
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            disabled={!editable || busy}
            onClick={() =>
              void send(
                'details',
                { details, expectedChecksum: view.checksum },
                'Saved.',
                message => setDetailsError(message || null)
              )
            }
          >
            Save changes
          </Button>
          <FieldDescription>Saves to production and is logged under your name.</FieldDescription>
        </div>
      </CardFooter>
    </Card>
  )

  const side = readOnly ? (
    <>
      {view.submission?.submitterEmail ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Submitter</CardTitle>
          </CardHeader>
          <CardContent>
            <Item className="!border-0 !p-0">
              <ItemMedia>
                <Avatar>
                  <AvatarFallback>{initials(view.submission.submitterEmail)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{view.submission.submitterEmail}</ItemTitle>
                <ItemDescription>
                  Account since {formatDay(view.submission.submitterCreatedAt)}
                </ItemDescription>
              </ItemContent>
            </Item>
          </CardContent>
        </Card>
      ) : null}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline items={view.activity} />
        </CardContent>
      </Card>
    </>
  ) : (
    <>
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Outbound link</CardTitle>
          <CardDescription>
            The rel on the Visit Site link. Defaults: follow for admin-added listings, nofollow for
            new submissions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleGroup
            type="single"
            variant="outline"
            value={linkRel}
            disabled={busy}
            aria-label="Outbound link"
            onValueChange={value => {
              if (!value || value === linkRel) return
              const previous = linkRel
              setLinkRel(value as LinkRel)
              void send('link-rel', { linkRel: value }, `Outbound link set to ${value}.`).then(
                ok => {
                  if (!ok) setLinkRel(previous)
                }
              )
            }}
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
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {view.owner ? (
              <>
                <Item className="!border-0 !p-0">
                  <ItemMedia>
                    <Avatar>
                      <AvatarFallback>{initials(view.owner.email)}</AvatarFallback>
                    </Avatar>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{view.owner.email}</ItemTitle>
                    <ItemDescription>
                      {view.owner.verifiedViaLabel} · {formatDay(view.owner.verifiedAt)}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                <FieldDescription>{ownerNote(view.owner.verifiedVia)}</FieldDescription>
              </>
            ) : (
              <FieldDescription>No owner. Anyone at the company can claim it.</FieldDescription>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialog('transfer')}>
                <Users />
                Transfer
              </Button>
              {view.owner ? (
                <Button variant="ghost" size="sm" onClick={() => setDialog('removeOwner')}>
                  Remove owner
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Badge checks</CardTitle>
        </CardHeader>
        <CardContent>
          {view.badgeChecks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No badge checks yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead className="text-foreground first:pl-4">Date</TableHead>
                    <TableHead className="text-foreground">Result</TableHead>
                    <TableHead className="text-foreground last:pr-4">Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.badgeChecks.map(check => (
                    <TableRow key={check.key}>
                      <TableCell className="first:pl-4">{formatDay(check.checkedAt)}</TableCell>
                      <TableCell>
                        {check.outcome === 'pass' ? (
                          <StatusBadge kind="pass" />
                        ) : check.conclusive ? (
                          <StatusBadge kind="miss_warn" label="Missing" />
                        ) : (
                          <StatusBadge kind="inconclusive" />
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground last:pr-4">
                        {check.note}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline items={view.activity} />
        </CardContent>
      </Card>
    </>
  )

  return (
    <>
      {head}
      {notice}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">{detailsCard}</div>
        <div className="flex flex-col gap-4">{side}</div>
      </div>

      <Dialog open={dialog === 'transfer'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer {view.name}</DialogTitle>
            <DialogDescription>
              Move ownership to another account. Logged under your name.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="transfer-email">New owner’s email</FieldLabel>
            <Input
              id="transfer-email"
              type="email"
              value={transferEmail}
              onChange={event => setTransferEmail(event.target.value)}
            />
            {error ? (
              <FieldError>{error}</FieldError>
            ) : (
              <FieldDescription>
                They need a SERP account.
                {view.owner ? ` ${view.owner.email} loses access right away.` : ''}
              </FieldDescription>
            )}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || !transferEmail.trim()}
              onClick={() =>
                void send(
                  'transfer-owner',
                  { email: transferEmail, expectedOwnerUserId: view.owner?.userId ?? null },
                  `${view.name} now belongs to ${transferEmail.trim().toLowerCase()}.`
                )
              }
            >
              Transfer ownership
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog === 'unpublish'} onOpenChange={open => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish {view.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Within about a minute it leaves the site, search, sitemap and RSS, and its URL returns
              410 Gone with a page that points to its category. You can republish it any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="unpublish-note">
              Note for the activity log{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <Input
              id="unpublish-note"
              value={note}
              onChange={event => setNote(event.target.value)}
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void send('unpublish', { note }, `${view.name} was unpublished.`)
              }}
            >
              Unpublish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === 'removeOwner'} onOpenChange={open => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {view.owner?.email} as the owner?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to this listing right away. The listing stays live. This is logged
              under your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <FieldError>{error}</FieldError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                void send(
                  'remove-owner',
                  { expectedOwnerUserId: view.owner?.userId ?? '' },
                  'Owner removed.'
                )
              }}
            >
              Remove owner
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
