import {
  buildSubmissionReviewPreview,
  type SubmissionReviewPreviewResourceRow,
  type SubmissionReviewPreviewRow
} from '@serpdirectory/data-ops/submissions'
import { z } from 'zod'

const reviewPreviewTokenPattern = /^[A-Za-z0-9_-]{43}$/

export const reviewPreviewAccessSchema = z.object({
  id: z.string().uuid(),
  token: z.string().regex(reviewPreviewTokenPattern)
})

export {
  buildSubmissionReviewPreview,
  type SubmissionReviewPreviewResourceRow,
  type SubmissionReviewPreviewRow
}
