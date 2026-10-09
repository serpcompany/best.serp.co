import { ExternalLink } from 'lucide-react'
import { ListingImage } from '@/components/listing/listing-image'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { WebsiteContentSection } from '@/components/website/website-content-section'
import type { ListingDetail } from '@/db/contracts'

/**
 * The listing preview on the review page (#64 screen 11): the product page's header (serplists'
 * `DetailPageLayout`, #273) and content in small, built from the staged content by
 * `buildSubmissionReviewPreview` (`lib/submissions/review-preview.ts`). It is a picture of the
 * page: Visit Site and the category are inert, and the category is the staged one's name.
 */
export function MiniListing({
  categoryName,
  listing
}: {
  categoryName: string | null
  listing: ListingDetail
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
        <h3 className="text-3xl font-semibold tracking-tight text-balance wrap-break-word">
          {listing.name}
        </h3>
        <p className="text-base whitespace-pre-line text-pretty wrap-anywhere text-muted-foreground">
          {listing.description}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
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
      <div className="max-w-3xl min-w-0">
        <WebsiteContentSection website={listing} />
      </div>
    </div>
  )
}
