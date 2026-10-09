import { ListingImage } from '@/components/listing/listing-image'
import { WebsiteContentSection } from '@/components/website/website-content-section'
import type { ListingDetail } from '@/db/contracts'
import { ProductLogo } from './product-cell'

/**
 * The listing preview on the review page (#64 screen 11): the site's listing layout in small,
 * built from the staged content by `buildSubmissionReviewPreview` (`lib/submissions/
 * review-preview.ts`), with the listing's own content section.
 */
export function MiniListing({
  categoryName,
  listing
}: {
  categoryName: string | null
  listing: ListingDetail
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="relative border-b border-border/50 bg-gradient-to-b from-muted/30 to-background">
        <div className="relative flex flex-col gap-4 p-6 sm:flex-row sm:items-start">
          <div className="inline-block w-fit rounded-2xl border border-border/50 bg-card p-2.5 shadow-lg">
            <ProductLogo
              className="rounded-xl"
              logoUrl={listing.media?.logo}
              name={listing.name}
              size={56}
              website={listing.website}
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-3xl font-bold tracking-tight">{listing.name}</h3>
            <p className="text-muted-foreground">{listing.description}</p>
          </div>
        </div>
      </div>
      {listing.media?.images?.[0] ? (
        // The hosted featured image approval would publish (#96 round 2 B1).
        <div className="max-w-xl border-b">
          <ListingImage kind="image" name={listing.name} src={listing.media.images[0]} />
        </div>
      ) : null}
      <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_200px]">
        <div className="min-w-0 text-sm leading-7">
          <WebsiteContentSection website={listing} />
        </div>
        <div className="space-y-3">
          <div className="rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground">
            Visit Site
          </div>
          <div className="rounded-xl border border-border/50 p-4">
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Category
            </p>
            <span className="mt-1 inline-flex rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium">
              {categoryName ?? listing.category}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
