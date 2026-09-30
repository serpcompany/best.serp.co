import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSubmissionReviewPreview, reviewPreviewAccessSchema } from './review-preview'

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

describe('private submission review preview', () => {
  it('accepts only a UUID and a 256-bit base64url capability', () => {
    expect(
      reviewPreviewAccessSchema.parse({
        id: submission.id,
        token: 'a'.repeat(43)
      })
    ).toEqual({
      id: submission.id,
      token: 'a'.repeat(43)
    })
    expect(
      reviewPreviewAccessSchema.safeParse({ id: 'not-an-id', token: 'a'.repeat(43) }).success
    ).toBe(false)
    expect(
      reviewPreviewAccessSchema.safeParse({ id: submission.id, token: 'too-short' }).success
    ).toBe(false)
  })

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
        media: {
          logo: 'https://example.com/logo.png',
          video: 'https://example.com/video.mp4'
        },
        relatedWebsites: [],
        previousWebsite: null,
        nextWebsite: null
      })
    )
  })

  it('keeps the route D1-only, status-gated, and private to the capability', () => {
    const repository = readFileSync(
      resolve('apps/pornvideodownloaders.com/lib/submissions/review-preview-repository.ts'),
      'utf8'
    )
    const sharedOperations = readFileSync(resolve('packages/data-ops/src/submissions.ts'), 'utf8')
    const route = readFileSync(
      resolve('apps/pornvideodownloaders.com/app/admin/submissions/[id]/preview/[token]/page.tsx'),
      'utf8'
    )
    const nextConfig = readFileSync(resolve('apps/pornvideodownloaders.com/next.config.ts'), 'utf8')
    const breadcrumb = readFileSync(
      resolve('packages/design-system/components/custom/breadcrumb.tsx'),
      'utf8'
    )
    const websiteHero = readFileSync(
      resolve('packages/web-core/src/website/website-hero-route.tsx'),
      'utf8'
    )

    expect(repository).toContain('@serpdirectory/data-ops/submissions')
    expect(repository).toContain('createSiteDatabase(workerEnv.DB, siteId)')
    expect(repository).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
    expect(sharedOperations).toContain("eq(listingSubmissions.status, 'verified')")
    expect(sharedOperations).toContain('listingSubmissionNotifications.previewTokenHash')
    expect(sharedOperations).toContain('eq(listingSubmissions.siteId, siteId)')
    expect(repository).not.toMatch(/readFile|\\.json/)
    expect(route).toContain('JsonLd: PrivatePreviewJsonLd')
    expect(route).toContain('structuredData={false}')
    expect(breadcrumb).toContain('structuredData = true')
    expect(breadcrumb).toContain('{structuredData && (')
    expect(websiteHero).toContain('structuredData={structuredData}')
    expect(route).toContain("dynamic = 'force-dynamic'")
    expect(nextConfig).toContain("value: 'private, no-store, max-age=0'")
    expect(nextConfig).toContain("value: 'noindex, nofollow, noarchive'")
  })
})
