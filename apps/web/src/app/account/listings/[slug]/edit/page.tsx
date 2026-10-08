import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { AccountCrumbs } from '@/components/account/account-shell'
import { ListingEdit } from '@/components/account/listing-edit'
import { requireAccountUser } from '@/lib/account/pages'
import { accountOperations } from '@/lib/account/runtime'
import { categoryChoices } from '@/lib/account/view'
import { getActiveCategories } from '@/lib/catalog/repository'
import { featureCopy } from '@/lib/feature-copy'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Edit listing',
  description: 'Edit your listing on SERP.',
  path: '/account/listings/',
  noindex: true
})

type EditPageProps = { params: Promise<{ slug: string }> }

/**
 * `/account/listings/<slug>/edit/` (#65; #70 screen 7): the owner edits a live listing as a
 * revision for review. While the listing's own submission is still in review, it is edited
 * there instead. Someone else's listing is a 404.
 */
export default async function AccountListingEditPage({
  params
}: EditPageProps): Promise<ReactElement> {
  const { slug } = await params
  const user = await requireAccountUser(`/account/listings/${slug}/edit/`)
  const listing = await (await accountOperations()).listing(user.id, slug)
  if (!listing) notFound()
  if (
    listing.submission &&
    (listing.submission.status === 'paid_pending_review' ||
      listing.submission.status === 'changes_requested')
  ) {
    redirect(`/account/submissions/${listing.submission.id}/`)
  }
  const categories = await getActiveCategories()
  const revision = listing.revision
  return (
    <>
      <AccountCrumbs
        crumbs={[
          { href: getRoute('account'), label: 'Account' },
          { href: '/account/listings/', label: 'Listings' },
          { href: `/account/listings/${listing.slug}/`, label: listing.name },
          { label: 'Edit' }
        ]}
      />
      <ListingEdit
        // A new revision state (saved, discarded, decided) starts the form from it again.
        key={revision ? `${revision.id}:${revision.status}:${revision.contentVersion}` : 'live'}
        categories={categoryChoices(categories, {
          name: revision?.categoryName ?? listing.categoryName,
          slug: revision?.categorySlug ?? listing.categorySlug
        })}
        faqsHint={featureCopy().faqsHint ?? ''}
        view={{
          categoryName: listing.categoryName,
          categorySlug: listing.categorySlug ?? '',
          content: listing.content,
          description: listing.description,
          faqs: listing.faqs,
          id: listing.id,
          live: listing.live,
          logoUrl: listing.logoUrl ?? '',
          name: listing.name,
          resourceLinks: listing.resourceLinks,
          revision,
          slug: listing.slug,
          website: listing.website
        }}
      />
    </>
  )
}
