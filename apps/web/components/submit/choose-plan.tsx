'use client'

import { Badge } from '@serpdirectory/design-system/badge'
import { Button } from '@serpdirectory/design-system/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@serpdirectory/design-system/card'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle
} from '@serpdirectory/design-system/item'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { Spinner } from '@serpdirectory/design-system/spinner'
import { ArrowRight, Check, Info, Lock, Pencil } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { featureCopy } from '@/lib/feature-copy'
import { hostOf, type SubmissionSummary } from '@/lib/submissions/contract'
import { chooseFreePlan } from './submit-api'
import { ProductLogo, StepProgress, SubmissionStatusBadge, ToneAlert } from './submit-ui'

/**
 * `/submit/<id>/choose/` (#70 screen 2b): the saved draft, then free (install the badge) or
 * paid. The paid card and every $49 link stay hidden until the paid listing ships (#68,
 * `features.showPaidListings`). "Decide later" shows the saved state; the draft stays in the
 * account until it expires.
 */

export interface ChoosePlanProps {
  /** Arrived right after saving (`?saved=1`): "Details saved"; otherwise "Welcome back". */
  justSaved: boolean
  priceCents: number
  showPaid: boolean
  signedInEmail: string
  submission: SubmissionSummary
}

function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-2.5 text-sm">
      {items.map(item => (
        <li key={item} className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function SummaryItem({ edit, submission }: { edit: boolean; submission: SubmissionSummary }) {
  const domain = hostOf(submission.website)
  return (
    <Item variant="outline">
      <ItemMedia>
        <ProductLogo name={submission.name} size={40} src={submission.logoUrl} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {submission.name}{' '}
          <span className="font-normal text-muted-foreground">
            {domain}
            {submission.categoryName ? ` · ${submission.categoryName}` : ''}
          </span>
        </ItemTitle>
        <ItemDescription>{submission.description}</ItemDescription>
      </ItemContent>
      {edit ? (
        <ItemActions>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/submit/?edit=${submission.id}`}>
              <Pencil />
              Edit details
            </Link>
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  )
}

export function ChoosePlan({
  justSaved,
  priceCents,
  showPaid,
  signedInEmail,
  submission
}: ChoosePlanProps) {
  const { freePlanBadgeCheck } = featureCopy()
  const router = useRouter()
  const [later, setLater] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const domain = hostOf(submission.website)
  const price = `$${Math.round(priceCents / 100)}`

  async function chooseFree() {
    setPending(true)
    setFailure(null)
    const response = await chooseFreePlan(submission.id)
    if (response.ok) {
      router.push(response.data.next)
      return
    }
    setPending(false)
    setFailure(response.error.error)
  }

  if (later) {
    return (
      <section className="mx-auto w-full max-w-xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-semibold text-2xl tracking-tight">{submission.name} is saved</h1>
            </CardTitle>
            <CardDescription>
              {showPaid
                ? 'You can leave now. Nothing is reviewed or published until you choose free or paid.'
                : 'You can leave now. Nothing is reviewed or published until you choose how to get listed.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <SummaryItem edit={false} submission={submission} />
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Status</span>
                <SubmissionStatusBadge status="draft" />
              </div>
              <ToneAlert icon={Info} title="Pick it up from your account">
                <p>
                  It’s listed under Submissions as “Draft – choose a plan”, with a Continue button
                  that brings you back to this choice.
                </p>
              </ToneAlert>
            </div>
          </CardContent>
          <CardFooter>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Button asChild>
                <Link href="/account/">Go to my account</Link>
              </Button>
              <Button variant="outline" onClick={() => setLater(false)}>
                Choose now
              </Button>
            </div>
          </CardFooter>
        </Card>
      </section>
    )
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10 md:py-14">
      <div className="flex flex-col gap-6">
        <StepProgress label="How to get listed" step={2} total={4} />
        {justSaved ? (
          <ToneAlert tone="success" title="Details saved">
            <p>Signed in as {signedInEmail}. You can change the details until it’s reviewed.</p>
          </ToneAlert>
        ) : (
          <ToneAlert tone="info" title="Welcome back">
            <p>
              {submission.name} is saved but not in the review queue yet. Pick an option to
              continue.
            </p>
          </ToneAlert>
        )}
        <SummaryItem edit submission={submission} />
        <div className="space-y-1">
          <h1 className="font-semibold text-2xl tracking-tight">Choose how to get listed</h1>
          <p className="text-muted-foreground text-sm">
            {showPaid
              ? 'Both options are reviewed by the SERP team. You can switch from free to paid later.'
              : 'Every listing is reviewed by the SERP team.'}
          </p>
        </div>
        {failure ? (
          <ToneAlert tone="destructive" title="Something went wrong">
            <p>{failure}</p>
          </ToneAlert>
        ) : null}
        <div
          className={cn(
            'grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card',
            showPaid && 'md:grid-cols-2'
          )}
        >
          <Card>
            <CardHeader>
              <CardDescription>Install the badge (free)</CardDescription>
              <CardTitle className="font-semibold text-3xl tabular-nums">Free</CardTitle>
              <CardAction>
                <Badge variant="outline">Reviewed first</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <CheckList
                items={[
                  `Add the Featured on SERP badge to ${domain} with a dofollow link to your listing`,
                  'We verify it, then a reviewer looks at your listing',
                  // Weekly checks are #66's, so the point waits for its flag.
                  ...(freePlanBadgeCheck ? [freePlanBadgeCheck] : [])
                ]}
              />
            </CardContent>
            <CardFooter className="mt-auto">
              <Button className="w-full" disabled={pending} onClick={chooseFree}>
                {pending ? <Spinner /> : null}
                Get the badge code
                {pending ? null : <ArrowRight />}
              </Button>
            </CardFooter>
          </Card>
          {showPaid ? (
            <Card>
              <CardHeader>
                <CardDescription>Skip the badge: {price} one-off</CardDescription>
                <CardTitle className="font-semibold text-3xl tabular-nums">{price}</CardTitle>
                <CardAction>
                  <Badge variant="outline">Live after checks</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <CheckList
                  items={[
                    'Live right after payment when automatic checks pass',
                    'Still reviewed. Full refund if rejected, except prohibited content',
                    'Badge optional and never checked. One-off, no subscription'
                  ]}
                />
              </CardContent>
              <CardFooter className="mt-auto">
                <div className="flex w-full flex-col gap-2">
                  <Button asChild className="w-full">
                    <Link href={`/submit/${submission.id}/checkout/`}>
                      Pay {price} and go live
                      <ArrowRight />
                    </Link>
                  </Button>
                  <p className="flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
                    <Lock className="size-3" aria-hidden="true" /> Secure checkout by Stripe
                  </p>
                </div>
              </CardFooter>
            </Card>
          ) : null}
        </div>
        <p className="text-center text-muted-foreground text-sm">
          Not ready to decide?{' '}
          <Button variant="link" className="h-auto p-0" onClick={() => setLater(true)}>
            Decide later
          </Button>
        </p>
      </div>
    </section>
  )
}
