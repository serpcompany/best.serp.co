import { ExternalLink } from 'lucide-react'
import { ListingImage } from '@/components/listing/listing-image'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VerifiedOwnerBadge } from '@/components/website/verified-owner-badge'
import { WebsiteContentSection } from '@/components/website/website-content-section'
import { faqsToShow, WebsiteFaqsSection } from '@/components/website/website-faqs-section'
import { WebsiteResourcesSection } from '@/components/website/website-resources-section'
import type { ListingDetail } from '@/db/contracts'

/**
 * The listing preview on the review page (#64 screen 11): the product page's header (serplists'
 * `DetailPageLayout`, #273) and content in small, built from the staged content by
 * `buildSubmissionReviewPreview` (`lib/submissions/review-preview.ts`). It is a picture of the
 * page: Visit Site and the category are inert, and the category is the staged one's name. A
 * preview shows the Verified owner badge when the live page will: a revision's while its listing
 * has a current owner, a submission's when approval makes its signed-in submitter the owner.
 */
export function MiniListing({
  categoryName,
  listing,
  verifiedOwner = false
}: {
  categoryName: string | null
  listing: ListingDetail
  verifiedOwner?: boolean
}) {
  return (
    <div className="rounded-xl border p-6" data-slot="mini-listing">
      <div className="flex min-w-0 flex-col items-start gap-4">
        <ListingImage
          name={listing.name}
          src={listing.media?.logo}
          size={56}
          className="rounded-xl"
        />
        <h2 className="text-3xl font-semibold tracking-tight text-balance wrap-break-word">
          {listing.name}
        </h2>
        <p className="text-base whitespace-pre-line text-pretty wrap-anywhere text-muted-foreground">
          {listing.description}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          {verifiedOwner ? <VerifiedOwnerBadge /> : null}
          <Badge variant="outline">{categoryName ?? listing.category}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={buttonVariants()}>
            Visit Site
            <ExternalLink data-icon="inline-end" aria-hidden />
          </span>
        </div>
      </div>
      <Separator className="my-6" />
      {/* The content section draws the featured image approval would publish (#96 round 2 B1). */}
      <div className="flex max-w-3xl min-w-0 flex-col gap-12">
        <WebsiteContentSection website={listing} />
        {/* The staged links and FAQs, drawn as the product page draws them. */}
        <WebsiteResourcesSection website={{ resourceLinks: listing.resourceLinks }} />
        <WebsiteFaqsSection website={{ faqs: faqsToShow(listing.faqs, listing.content) }} />
      </div>
    </div>
  )
}
