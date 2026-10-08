'use client'

import { MessageSquare, Pencil, Plus, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { ProductLogo, ToneAlert } from '@/components/submit/submit-ui'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { FieldDescription, FieldGroup } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { formatDay } from '@/lib/account/format'
import type { HistoryItem } from '@/lib/account/history'
import type { AccountStatus } from '@/lib/account/view'
import { hostOf } from '@/lib/submissions/contract'
import { resubmitSubmission, saveSubmissionExtras } from './account-api'
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
import { AccountRecordHeader, HistoryCard, Kv, TwoColumns } from './record'
import { AccountStatusBadge, PlanCell } from './status'
import { WithdrawDialog } from './withdraw-dialog'

/**
 * A submission in the account (#70 screen 6): its status, what to do next, and its history.
 * Changes requested: the reviewer's note and the edit-and-resubmit form. In review: what was
 * submitted, FAQs and links to add, and Withdraw (before payment only). Withdrawn and rejected:
 * why, and the way to submit again. "Message the reviewers" opens `/contact/` until #73.
 */

export interface SubmissionDetailView {
  categoryName: string | null
  categorySlug: string
  content: string
  contentVersion: number
  description: string
  faqs: Array<{ answer: string; question: string }>
  id: string
  listingLive: boolean
  logoUrl: string
  name: string
  paid: boolean
  plan: 'free' | 'paid' | null
  refunded: boolean
  rejection: { category: 'other' | 'prohibited' | null; reason: string } | null
  resourceLinks: Array<{ label: string; url: string }>
  reviewedAt: string | null
  reviewerNote: string | null
  status: AccountStatus
  updatedAt: string
  website: string
  withdrawable: boolean
  withdrawalReason: 'admin' | 'expired' | 'owner' | null
}

const CONTACT = '/contact/'

function planLabel(view: SubmissionDetailView): string {
  if (view.plan === 'paid') {
    if (view.refunded) return 'Paid ($49, refunded)'
    if (view.rejection?.category === 'prohibited') return 'Paid ($49, not refunded)'
    return 'Paid ($49)'
  }
  return view.plan === 'free' ? 'Free (badge)' : 'Not chosen'
}

function MessageButton({ label = 'Message the reviewers' }: { label?: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={CONTACT}>
        <MessageSquare />
        {label}
      </Link>
    </Button>
  )
}

function ReadOnlyCard({ view }: { view: SubmissionDetailView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What you submitted</CardTitle>
      </CardHeader>
      <CardContent>
        <Kv
          rows={[
            ['Name', view.name],
            [
              'URL',
              <span className="font-mono text-[13px]" key="url">
                {view.website}
              </span>
            ],
            ['Category', view.categoryName ?? view.categorySlug],
            [
              'Short description',
              <span className="font-normal" key="description">
                {view.description}
              </span>
            ],
            ['Logo', <ProductLogo key="logo" name={view.name} size={32} src={view.logoUrl} />],
            ['Plan', planLabel(view)]
          ]}
        />
      </CardContent>
    </Card>
  )
}

/** FAQs and links while the submission waits for review: "Add them now…" (screen 6). */
function ExtrasCard({ faqsHint, view }: { faqsHint: string; view: SubmissionDetailView }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState<ExtrasValue>(() => extrasValue(view))
  const [errors, setErrors] = useState<ExtrasErrors | null>(null)
  const [busy, setBusy] = useState(false)
  const count = view.faqs.length + view.resourceLinks.length

  async function save() {
    const found = extrasErrors(value)
    setErrors(found)
    if (hasExtrasErrors(found)) return
    setBusy(true)
    const response = await saveSubmissionExtras(view.id, {
      ...extrasInput(value),
      expectedContentVersion: view.contentVersion
    })
    setBusy(false)
    if (!response.ok) {
      toast.error(response.error.error)
      return
    }
    toast.success('Saved. They’re reviewed with the listing.')
    setEditing(false)
    setErrors(null)
    router.refresh()
  }

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>FAQs and links</CardTitle>
          <CardDescription>They’re reviewed with the listing.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <ExtrasEditor errors={errors} faqsHint={faqsHint} onChange={setValue} value={value} />
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-2 border-t pt-6 @sm/main:flex-row">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null}
            Save FAQs and links
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setValue(extrasValue(view))
              setErrors(null)
              setEditing(false)
            }}
          >
            Cancel
          </Button>
        </CardFooter>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>FAQs and links</CardTitle>
        <CardDescription>
          {count === 0
            ? 'None yet. Add them now and they’re reviewed with the listing.'
            : 'They’re reviewed with the listing.'}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {count === 0 ? <Plus /> : <Pencil />}
            {count === 0 ? 'Add' : 'Edit'}
          </Button>
        </CardAction>
      </CardHeader>
      {count > 0 ? (
        <CardContent className="flex flex-col gap-4 text-sm">
          {view.faqs.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="font-medium">FAQs</p>
              <ul className="grid gap-1 text-muted-foreground">
                {view.faqs.map(faq => (
                  <li key={faq.question}>{faq.question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.resourceLinks.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="font-medium">Links</p>
              <ul className="grid gap-1">
                {view.resourceLinks.map(link => (
                  <li key={`${link.label}-${link.url}`} className="flex flex-wrap gap-2">
                    {link.label}
                    <span className="break-all font-mono text-[13px] text-muted-foreground">
                      {link.url}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  )
}

function ResubmitCard({
  categories,
  faqsHint,
  view
}: {
  categories: readonly CategoryChoice[]
  faqsHint: string
  view: SubmissionDetailView
}) {
  const router = useRouter()
  const original: ContentValue = {
    categorySlug: view.categorySlug,
    content: view.content,
    description: view.description,
    logoUrl: view.logoUrl,
    name: view.name
  }
  const [value, setValue] = useState<ContentValue>(original)
  const [errors, setErrors] = useState<ContentErrors>({})
  // FAQs and links are fixed in the same pass when the note is about one (#102 round 1).
  const [extras, setExtras] = useState<ExtrasValue>(() => extrasValue(view))
  const [extrasProblems, setExtrasProblems] = useState<ExtrasErrors | null>(null)
  const [busy, setBusy] = useState(false)

  async function resubmit() {
    const found = contentErrors(value, true)
    const foundExtras = extrasErrors(extras)
    setErrors(found)
    setExtrasProblems(foundExtras)
    if (Object.keys(found).length > 0 || hasExtrasErrors(foundExtras)) {
      toast.error('Fix the highlighted fields.')
      return
    }
    setBusy(true)
    const response = await resubmitSubmission(view.id, {
      ...value,
      ...extrasInput(extras),
      expectedContentVersion: view.contentVersion
    })
    setBusy(false)
    if (!response.ok) {
      if (response.error.fields) setErrors(response.error.fields as ContentErrors)
      toast.error(response.error.error)
      return
    }
    toast.success(`${view.name} is back in the review queue.`)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit and resubmit</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <ContentFields
            categories={categories}
            errors={errors}
            idPrefix="resubmit"
            nameEditable
            onChange={setValue}
            original={original}
            value={value}
            website={{
              note: 'To change the URL, withdraw this submission and submit again.',
              url: view.website
            }}
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
        <div className="flex w-full flex-col gap-3 @sm/main:flex-row @sm/main:items-center">
          <Button disabled={busy} onClick={() => void resubmit()}>
            {busy ? <Spinner /> : null}
            Resubmit for review
          </Button>
          <FieldDescription>
            It goes back to the review queue, and we email you the result.
          </FieldDescription>
        </div>
      </CardFooter>
    </Card>
  )
}

export function SubmissionDetail({
  categories,
  email,
  faqsHint,
  history,
  messagesNote,
  view
}: {
  categories: readonly CategoryChoice[]
  email: string
  /** Under "FAQs" (`featureCopy().faqsHint`). */
  faqsHint: string
  history: readonly HistoryItem[]
  /** "The reason is also in your Messages…", once #73 ships Messages. */
  messagesNote: boolean
  view: SubmissionDetailView
}) {
  const [withdrawing, setWithdrawing] = useState(false)
  const submitAgain = `/submit/?url=${encodeURIComponent(view.website)}`
  const prohibited = view.rejection?.category === 'prohibited'
  const withdraw = view.withdrawable ? (
    <Button variant="outline" size="sm" onClick={() => setWithdrawing(true)}>
      Withdraw
    </Button>
  ) : null

  let actions: ReactNode = (
    <>
      <MessageButton />
      {withdraw}
    </>
  )
  let main: ReactNode
  if (view.status === 'changes') {
    main = (
      <>
        <ToneAlert tone="warning" icon={MessageSquare} title="Changes requested">
          <p>“{view.reviewerNote ?? 'A reviewer asked for changes.'}”</p>
          <p className="text-xs">From the SERP team · {formatDay(view.reviewedAt)}</p>
        </ToneAlert>
        <ResubmitCard categories={categories} faqsHint={faqsHint} view={view} />
      </>
    )
  } else if (view.status === 'in_review' || view.status === 'live_paid') {
    main = (
      <>
        {view.status === 'in_review' ? (
          <ToneAlert tone="info" title="Waiting for a reviewer">
            <p>
              {view.plan === 'free' ? 'Your badge checked out. ' : ''}We’ll email {email} when a
              reviewer has looked at {view.name}.
              {view.withdrawable ? ' You can withdraw it while it’s waiting.' : ''}
            </p>
          </ToneAlert>
        ) : (
          <ToneAlert tone="info" title="Live, and waiting for a reviewer">
            <p>
              {view.name} is live on best.serp.co. A reviewer still signs off, and we’ll email{' '}
              {email} with the result.
            </p>
          </ToneAlert>
        )}
        <ReadOnlyCard view={view} />
        <ExtrasCard faqsHint={faqsHint} view={view} />
      </>
    )
  } else if (view.status === 'withdrawn') {
    actions = (
      <>
        <MessageButton />
        <Button asChild size="sm">
          <Link href={submitAgain}>Submit again</Link>
        </Button>
      </>
    )
    const day = formatDay(view.updatedAt)
    main = (
      <>
        {view.withdrawalReason === 'expired' ? (
          <ToneAlert icon={Undo2} title="This draft expired">
            <p>
              It was removed on {day}, 30 days after it was first saved, and {hostOf(view.website)}{' '}
              was released. To list {view.name}, submit it again.
            </p>
          </ToneAlert>
        ) : view.withdrawalReason === 'admin' ? (
          <ToneAlert icon={Undo2} title="The SERP team cleared this draft">
            <p>
              Cleared on {day}. It won’t be reviewed or published. To list {view.name}, submit it
              again.
            </p>
          </ToneAlert>
        ) : (
          <ToneAlert icon={Undo2} title="You withdrew this submission">
            <p>
              Withdrawn on {day}. It won’t be reviewed or published. To list {view.name} later,
              submit it again.
            </p>
          </ToneAlert>
        )}
        <ReadOnlyCard view={view} />
      </>
    )
  } else if (view.status === 'rejected') {
    actions = prohibited ? (
      <MessageButton label="Message us" />
    ) : (
      <>
        <MessageButton />
        <Button asChild size="sm">
          <Link href={submitAgain}>Edit and resubmit</Link>
        </Button>
      </>
    )
    const reason = view.rejection?.reason ?? 'It wasn’t approved.'
    main = (
      <>
        <ToneAlert
          tone="destructive"
          title={
            prohibited
              ? 'Rejected: prohibited content'
              : view.refunded
                ? 'Rejected and refunded'
                : `Rejected on ${formatDay(view.reviewedAt)}`
          }
        >
          <p>
            <b>Reason:</b> {reason}
          </p>
          {view.refunded ? (
            <p>
              <b>Refund:</b> $49.00 to your original payment method. It can take 5 to 10 business
              days to show up.
            </p>
          ) : null}
          {prohibited ? (
            <p>
              <b>This URL can’t be submitted again.</b> If you think this is a mistake, message us.
            </p>
          ) : null}
        </ToneAlert>
        <ReadOnlyCard view={view} />
        {messagesNote ? (
          <p className="text-sm text-muted-foreground">
            The reason is also in your Messages, where you can reply to the reviewers.
          </p>
        ) : null}
      </>
    )
  } else {
    actions = <MessageButton />
    main = (
      <>
        <ToneAlert tone="success" title="Approved">
          <p>{view.name} was published on best.serp.co.</p>
        </ToneAlert>
        <ReadOnlyCard view={view} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AccountRecordHeader
        actions={actions}
        chips={
          <>
            <AccountStatusBadge status={view.status} />
            <PlanCell plan={view.plan} />
          </>
        }
        logoUrl={view.logoUrl}
        meta={`${hostOf(view.website)} · ${view.categoryName ?? view.categorySlug}`}
        name={view.name}
      />
      <TwoColumns aside={<HistoryCard items={history} />}>{main}</TwoColumns>
      {view.withdrawable ? (
        <WithdrawDialog
          inQueue={view.status === 'in_review' || view.status === 'changes'}
          name={view.name}
          onOpenChange={setWithdrawing}
          open={withdrawing}
          submissionId={view.id}
        />
      ) : null}
    </div>
  )
}
