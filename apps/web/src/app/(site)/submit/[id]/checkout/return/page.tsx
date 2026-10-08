import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import {
  CheckoutConfirming,
  CheckoutFailed,
  CheckoutHeld,
  CheckoutLive
} from '@/components/submit/checkout-screens'
import { checkoutPageProblem } from '@/lib/billing/guardrails'
import { checkoutPage, toAccount } from '@/lib/billing/pages'
import { billing } from '@/lib/billing/runtime'
import { confirmReturn } from '@/lib/billing/service'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { submissionBadgeTargets } from '@/lib/submissions/presentation'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = generateBaseMetadata({
  title: 'Payment',
  description: 'Your payment for a listing on SERP.',
  path: '/submit/',
  noindex: true
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ order?: string | string[] }>
}

/**
 * `/submit/<id>/checkout/return/?order=<order id>` (#68, #70 screens 4c–4e and 4g): the
 * return after payment. It confirms the order's own checkout with the provider and applies a paid one
 * if the webhook hasn't yet, then shows where it stands: confirming (refreshing until settled),
 * live and in review, waiting for review after a failed check, or failed.
 */
export default async function CheckoutReturnPage({ params, searchParams }: Props) {
  const { id } = await params
  const orderId = (await searchParams).order
  const path = `/submit/${id}/checkout/return/${typeof orderId === 'string' ? `?order=${orderId}` : ''}`
  const { product, submission, user } = await checkoutPage(id, path)
  if (typeof orderId !== 'string' || !UUID.test(orderId)) redirect(`/submit/${id}/checkout/`)
  const deps = await billing()
  if (!deps) notFound()
  const order = await confirmReturn(deps, { orderId, userId: user.id })
  if (!order || order.submissionId !== submission.id) notFound()
  // What was charged: less than the price when a promotion code applied (#250).
  const details = {
    amountCents: order.chargedCents ?? order.amountCents,
    discountCents:
      order.attention !== 'amount_mismatch' && order.chargedCents !== null
        ? order.amountCents - order.chargedCents
        : 0,
    email: user.email,
    number: order.number
  }
  if (order.status === 'failed') {
    return (
      <CheckoutFailed
        amountCents={order.amountCents}
        backHref={`/submit/${id}/choose/`}
        orderNumber={order.number}
        product={product}
        startHref={`/submit/${id}/checkout/start/`}
      />
    )
  }
  if (order.status === 'pending' || order.outcome === null) {
    return <CheckoutConfirming amountCents={order.amountCents} product={product} />
  }
  if (order.outcome === 'published') {
    return (
      <CheckoutLive
        listingUrl={submissionBadgeTargets(submission.slug).listingUrl}
        order={details}
        product={product}
      />
    )
  }
  if (order.outcome === 'held') {
    return (
      <CheckoutHeld
        order={details}
        problem={checkoutPageProblem(order.checkProblem)}
        product={product}
        website={submission.website}
      />
    )
  }
  // A payment that couldn't apply was refunded: the account shows where the submission stands.
  toAccount(submission)
}
