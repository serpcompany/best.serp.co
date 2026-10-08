import type { SubmissionReview } from '@/db/admin-queries'
import { renderableImage } from '../media/renderable-image'

/** A submission's hosted featured image as the review screen shows it, and the key it approves. */
export interface FeaturedImageView {
  image: string | null
  key: string | null
}

/**
 * The featured image approval would publish (#96 round 2 B1): only the hosted copy the preview
 * shows, whose key the approval sends back; a waiting or failed image is never adopted.
 */
export function featuredImageView(
  review: Pick<SubmissionReview, 'imageKey'>,
  mediaBaseUrl: string
): FeaturedImageView {
  const image = renderableImage({ key: review.imageKey }, mediaBaseUrl)
  return review.imageKey && image ? { image, key: review.imageKey } : { image: null, key: null }
}
