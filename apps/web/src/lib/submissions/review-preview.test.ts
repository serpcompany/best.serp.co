import { describe, expect, it } from 'vitest'
import { buildSubmissionReviewPreview } from './review-preview'

const submission = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'example.com',
  name: 'Example',
  description: 'An example submission.',
  website: 'https://example.com',
  content: 'Long-form example content.',
  category_slug: 'adult',
  logo_url: 'https://example.com/logo.png',
  video_url: 'https://example.com/video.mp4',
  created_at: '2026-07-30 06:00:00'
}

describe('submission review preview', () => {
  it('maps an unpublished D1 submission into the public listing-detail model', () => {
    expect(
      buildSubmissionReviewPreview(submission, [
        { label: 'Documentation', url: 'https://example.com/docs', sort_order: 0 }
      ])
    ).toEqual(
      expect.objectContaining({
        slug: 'example.com',
        name: 'Example',
        category: 'adult',
        categories: ['adult'],
        publishedAt: '2026-07-30',
        resourceLinks: [{ label: 'Documentation', url: 'https://example.com/docs' }],
        // The submitted logo source is never rendered: no hosted copy, no logo (#96 S9).
        media: { video: 'https://example.com/video.mp4' },
        relatedWebsites: [],
        previousWebsite: null,
        nextWebsite: null
      })
    )
  })

  it('shows the submission’s hosted logo copy, never its source (#96 review S9)', () => {
    const logoKey = `best.serp.co/submissions/${submission.id}/logo/${'a'.repeat(16)}.png`
    const imageKey = `best.serp.co/submissions/${submission.id}/image/${'b'.repeat(16)}.png`
    expect(
      buildSubmissionReviewPreview({ ...submission, image_key: imageKey, logo_key: logoKey }, [])
        .media
    ).toEqual({ images: [imageKey], logo: logoKey, video: 'https://example.com/video.mp4' })
    expect(
      buildSubmissionReviewPreview({ ...submission, logo_key: 'https://example.com/x.png' }, [])
        .media?.logo
    ).toBeUndefined()
  })
})
