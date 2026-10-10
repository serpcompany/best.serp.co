import type { Metadata } from 'next'
import { CheckoutHandoff } from '@/components/submit/checkout-screens'
import { checkoutPage, checkoutPayable, toAccount } from '@/lib/billing/pages'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { site } from '@/lib/site'

export const dynamic = 'force-dynamic'
export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Checkout',
    description: 'Pay for your listing on SERP.',
    path: '/submit/',
    noindex: true
  })
}

/**
 * `/submit/<id>/checkout/` (#68, #70 screen 4a): the handoff to checkout. The choose and badge
 * steps' "$49" links and the draft reminder's "Complete checkout" open it.
 */
export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { product, submission } = await checkoutPage(id, `/submit/${id}/checkout/`)
  if (!checkoutPayable(submission)) toAccount(submission)
  return (
    <CheckoutHandoff
      amountCents={site.submissions.paidListingPriceCents}
      backHref={`/submit/${id}/choose/`}
      product={product}
      startHref={`/submit/${id}/checkout/start/`}
    />
  )
}
