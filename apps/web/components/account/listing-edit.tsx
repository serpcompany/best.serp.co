'use client'

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
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import { FieldGroup } from '@serpdirectory/design-system/field'
import { Separator } from '@serpdirectory/design-system/separator'
import { Spinner } from '@serpdirectory/design-system/spinner'
import { ExternalLink, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { ProductLogo, ToneAlert } from '@/components/submit/submit-ui'
import { formatDay, formatStamp } from '@/lib/account/format'
import { hostOf } from '@/lib/submissions/contract'
import { discardRevision, saveRevision } from './account-api'
import {
  type CategoryChoice,
  type ContentErrors,
  ContentFields,
  type ContentValue,
  contentErrors
} from './content-fields'
import {
  ExtrasEditor,
  type ExtrasErrors,
  type ExtrasValue,
  extrasErrors,
  extrasInput,
  extrasValue,
  hasExtrasErrors
} from './extras-editor'
import { AccountRecordHeader } from './record'
import { AccountStatusBadge } from './status'

/**
 * Editing a live listing (#70 screen 7): the edits become a revision that a reviewer approves
 * before anything public changes (#62 plans). The name and website stay as they are. While a
 * revision waits, the page shows what changed, and the owner can change or discard it; a
 * reviewer's change request shows its note above the form.
 */

interface Extras {
  faqs: Array<{ answer: string; question: string }>
  resourceLinks: Array<{ label: string; url: string }>
}

export interface ListingEditView extends Extras {
  categoryName: string | null
  categorySlug: string
  content: string
  description: string
  id: string
  live: boolean
  logoUrl: string
  name: string
  revision:
    | (Extras & {
        categoryName: string | null
        categorySlug: string
        content: string
        /** The version the form loads: saving it back refuses a stale tab. */
        contentVersion: number
        description: string
        logoUrl: string
        rejectionReason: string | null
        reviewedAt: string | null
        reviewerNote: string | null
        status: 'approved' | 'changes_requested' | 'pending_review' | 'rejected' | 'withdrawn'
        updatedAt: string
      })
    | null
  slug: string
  website: string
}

function MessageButton() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/contact/">
        <MessageSquare />
        Message the reviewers
      </Link>
    </Button>
  )
}

/** One field's before and after, or the items added and removed from a list. */
function Changes({
  revision,
  view
}: {
  revision: NonNullable<ListingEditView['revision']>
  view: ListingEditView
}) {
  const blocks: ReactNode[] = []
  let count = 0
  const text = (label: string, before: string, after: string) => {
    if (before.trim() === after.trim()) return
    count += 1
    blocks.push(
      <div key={label} className="flex flex-col gap-2">
        <p className="text-sm font-medium">{label}</p>
        {before.trim() ? (
          <p className="whitespace-pre-line rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-900 line-through decoration-red-500/50 dark:text-red-200">
            {before}
          </p>
        ) : null}
        {after.trim() ? (
          <p className="whitespace-pre-line rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
            {after}
          </p>
        ) : null}
      </div>
    )
  }
  text(
    'Primary category',
    view.categoryName ?? view.categorySlug,
    revision.categoryName ?? revision.categorySlug
  )
  text('Short description', view.description, revision.description)
  text('Long description', view.content, revision.content)
  if (view.logoUrl !== revision.logoUrl) {
    count += 1
    blocks.push(
      <div key="logo" className="flex flex-col gap-2">
        <p className="text-sm font-medium">Logo</p>
        <div className="flex items-center gap-3">
          <ProductLogo name={view.name} size={40} src={view.logoUrl} className="opacity-60" />
          <span className="text-muted-foreground">→</span>
          <ProductLogo name={view.name} size={40} src={revision.logoUrl} />
        </div>
      </div>
    )
  }
  const list = (
    label: string,
    before: string[],
    after: string[],
    render: (item: string) => ReactNode
  ) => {
    const added = after.filter(item => !before.includes(item))
    const removed = before.filter(item => !after.includes(item))
    if (added.length + removed.length === 0) return
    count += added.length + removed.length
    const summary = [
      added.length ? `${added.length} added` : '',
      removed.length ? `${removed.length} removed` : ''
    ]
      .filter(Boolean)
      .join(', ')
    blocks.push(
      <div key={label} className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          {label} · {summary}
        </p>
        <ul className="grid gap-1 text-sm">
          {added.map(item => (
            <li key={`+${item}`} className="flex flex-wrap gap-2">
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">+</span>
              {render(item)}
            </li>
          ))}
          {removed.map(item => (
            <li
              key={`-${item}`}
              className="flex flex-wrap gap-2 text-muted-foreground line-through"
            >
              <span className="font-semibold text-red-600 no-underline dark:text-red-400">−</span>
              {render(item)}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  const faq = (item: { answer: string; question: string }) =>
    JSON.stringify([item.question, item.answer])
  const link = (item: { label: string; url: string }) => JSON.stringify([item.label, item.url])
  list(
    'FAQs',
    view.faqs.map(faq),
    revision.faqs.map(faq),
    item => (JSON.parse(item) as string[])[0]
  )
  list('Links', view.resourceLinks.map(link), revision.resourceLinks.map(link), item => {
    const [label, url] = JSON.parse(item) as string[]
    return (
      <>
        {label} <span className="break-all font-mono text-[13px] text-muted-foreground">{url}</span>
      </>
    )
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{count === 1 ? '1 change' : `${count} changes`} in this revision</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 [&>*+*]:border-t [&>*+*]:pt-4">
        {blocks.length > 0 ? (
          blocks
        ) : (
          <p className="text-sm text-muted-foreground">No changes from the live listing.</p>
        )}
      </CardContent>
    </Card>
  )
}

export function ListingEdit({
  categories,
  faqsHint,
  view
}: {
  categories: readonly CategoryChoice[]
  faqsHint: string
  view: ListingEditView
}) {
  const router = useRouter()
  const revision = view.revision
  const open =
    revision && (revision.status === 'pending_review' || revision.status === 'changes_requested')
      ? revision
      : null
  const source = open ?? view
  const original: ContentValue = {
    categorySlug: source.categorySlug,
    content: source.content,
    description: source.description,
    logoUrl: source.logoUrl,
    name: view.name
  }
  const [editing, setEditing] = useState(open?.status !== 'pending_review')
  const [value, setValue] = useState<ContentValue>(original)
  const [extras, setExtras] = useState<ExtrasValue>(() => extrasValue(source))
  const [errors, setErrors] = useState<ContentErrors>({})
  const [extrasProblems, setExtrasProblems] = useState<ExtrasErrors | null>(null)
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)

  function reset() {
    setValue(original)
    setExtras(extrasValue(source))
    setErrors({})
    setExtrasProblems(null)
  }

  async function submit() {
    const found = contentErrors(value, false)
    const foundExtras = extrasErrors(extras)
    setErrors(found)
    setExtrasProblems(foundExtras)
    if (Object.keys(found).length > 0 || hasExtrasErrors(foundExtras)) {
      toast.error('Fix the highlighted fields.')
      return
    }
    setBusy(true)
    const response = await saveRevision(view.id, {
      categorySlug: value.categorySlug,
      content: value.content,
      description: value.description,
      expectedRevisionVersion: open?.contentVersion ?? null,
      logoUrl: value.logoUrl,
      ...extrasInput(extras)
    })
    setBusy(false)
    if (!response.ok) {
      if (response.error.fields) setErrors(response.error.fields as ContentErrors)
      toast.error(response.error.error)
      return
    }
    toast.success('Your edits are waiting for review.')
    setEditing(false)
    router.refresh()
  }

  async function discard() {
    setBusy(true)
    const response = await discardRevision(view.id)
    setBusy(false)
    if (!response.ok) {
      toast.error(response.error.error)
      return
    }
    setDiscarding(false)
    toast.success('Your pending edits were discarded.')
    router.refresh()
  }

  const header = (
    <AccountRecordHeader
      actions={
        <>
          <MessageButton />
          {view.live ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/products/${view.slug}/`} target="_blank" rel="noreferrer">
                View live listing
                <ExternalLink />
              </a>
            </Button>
          ) : null}
        </>
      }
      chips={
        <>
          <AccountStatusBadge status={view.live ? 'live' : 'unlisted'} />
          {open?.status === 'pending_review' ? <AccountStatusBadge status="revision" /> : null}
          {open?.status === 'changes_requested' ? (
            <AccountStatusBadge status="changes" label="Edits need changes" />
          ) : null}
        </>
      }
      logoUrl={view.logoUrl || null}
      meta={`${hostOf(view.website)} · /products/${view.slug}/`}
      name={view.name}
      title={`Edit ${view.name}`}
    />
  )

  if (!view.live) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ToneAlert title="This listing isn’t live">
          <p>
            It was removed from best.serp.co, so it can’t be edited here. Message us to bring it
            back.
          </p>
        </ToneAlert>
      </div>
    )
  }

  if (open?.status === 'pending_review' && !editing) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ToneAlert
          tone="info"
          title="Your edits are waiting for review"
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Change pending edits
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDiscarding(true)}>
                <Trash2 />
                Discard edits
              </Button>
            </>
          }
        >
          <p>
            Submitted {formatStamp(open.updatedAt)}. Visitors see the current listing until a
            reviewer approves the changes.
          </p>
        </ToneAlert>
        <Changes revision={open} view={view} />
        <AlertDialog open={discarding} onOpenChange={setDiscarding}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard your pending edits?</AlertDialogTitle>
              <AlertDialogDescription>
                They leave the review queue, and {view.name} stays as it is now.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={busy}
                onClick={event => {
                  event.preventDefault()
                  void discard()
                }}
              >
                Discard edits
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {open?.status === 'changes_requested' ? (
        <ToneAlert tone="warning" icon={MessageSquare} title="Changes requested">
          <p>“{open.reviewerNote ?? 'A reviewer asked for changes.'}”</p>
          <p className="text-xs">From the SERP team · {formatDay(open.reviewedAt)}</p>
        </ToneAlert>
      ) : revision?.status === 'rejected' ? (
        <ToneAlert tone="destructive" title="Your last edits weren’t approved">
          <p>
            <b>Reason:</b> {revision.rejectionReason ?? 'Not given.'}
          </p>
        </ToneAlert>
      ) : (
        <ToneAlert title="Edits are reviewed before they go live">
          <p>Visitors keep seeing the current listing until a reviewer approves your changes.</p>
        </ToneAlert>
      )}
      <Card>
        <CardContent>
          <FieldGroup>
            <ContentFields
              categories={categories}
              errors={errors}
              idPrefix="listing"
              nameEditable={false}
              nameNote="To change the name or URL, message the reviewers."
              onChange={setValue}
              original={original}
              tallContent
              value={value}
            />
            <Separator />
            <ExtrasEditor
              errors={extrasProblems}
              faqsHint={faqsHint}
              onChange={setExtras}
              value={extras}
            />
          </FieldGroup>
        </CardContent>
        <CardFooter className="border-t pt-6">
          <div className="flex w-full flex-col gap-2 @sm/main:flex-row">
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? <Spinner /> : null}
              {open?.status === 'changes_requested'
                ? 'Resubmit for review'
                : 'Submit changes for review'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                reset()
                if (open?.status === 'pending_review') setEditing(false)
                else router.push('/account/listings/')
              }}
            >
              Cancel
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}
