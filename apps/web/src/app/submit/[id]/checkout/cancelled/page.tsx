import { site } from '@serpdirectory/site-config'
import type { Metadata } from 'next'
import { CheckoutCancelled } from '@/components/submit/checkout-screens'
import { checkoutPage, checkoutPayable, toAccount } from '@/lib/billing/pages'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = generateBaseMetadata({
  title: 'Checkout cancelled',
  description: 'Your checkout was cancelled.',
  path: '/submit/',
  noindex: true
})

/** `/submit/<id>/checkout/cancelled/` (#68, #70 screen 4f): back from checkout without paying. */
export default async function CheckoutCancelledPage({
  params
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { product, submission } = await checkoutPage(id, `/submit/${id}/checkout/cancelled/`)
  if (!checkoutPayable(submission)) toAccount(submission)
  return (
    <CheckoutCancelled
      amountCents={site.submissions.paidListingPriceCents}
      backHref={`/submit/${id}/choose/`}
      product={product}
      startHref={`/submit/${id}/checkout/start/`}
    />
  )
}
