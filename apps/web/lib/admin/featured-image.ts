import type { SubmissionReview } from '@serpdirectory/data-ops/admin-queries'
import { renderableImage } from '../media/renderable-image'
import { describeMediaFailure } from './logo-note'

/** What the review screen shows of a submission's featured image, and the key it approves. */
export interface FeaturedImageView {
  image: string | null
  key: string | null
  note: string
}

/**
 * The featured image approval would publish (#96 round 2 B1): only the hosted copy shown here,
 * whose key the approval sends back; a waiting or failed image is never adopted.
 */
export function featuredImageView(
  review: Pick<SubmissionReview, 'imageKey' | 'imageSlot'>,
  mediaBaseUrl: string
): FeaturedImageView {
  const image = renderableImage({ key: review.imageKey }, mediaBaseUrl)
  if (review.imageKey && image) {
    return {
      image,
      key: review.imageKey,
      note: "The website's social image, hosted. Approving publishes it as the listing's featured image."
    }
  }
  const slot = review.imageSlot
  const note = !slot
    ? 'No featured image: the website has no usable social image. Approving publishes none.'
    : slot.status === 'pending'
      ? `The website's social image is waiting to be hosted${slot.lastError ? ` (${describeMediaFailure(slot.lastError)})` : ''}. Approving now publishes no featured image; reload once it is hosted to review it.`
      : `Couldn't host the website's social image: ${describeMediaFailure(slot.lastError ?? 'unknown error')}. Approving publishes no featured image.`
  return { image: null, key: null, note }
}
