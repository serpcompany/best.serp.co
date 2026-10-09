import { describe, expect, it } from 'vitest'
import { previewVerifiedOwner, stagedPreview } from './review-view'

const staged = {
  categorySlug: 'tools',
  content: 'Staged content.',
  createdAt: '2026-10-09T00:00:00.000Z',
  description: 'A staged listing.',
  id: 'sub_staged',
  logoKey: null,
  logoUrl: 'https://staged.example/logo.png',
  name: 'Staged Tool',
  resourceLinks: [],
  slug: 'staged.example',
  videoUrl: null,
  website: 'https://staged.example/'
}

describe('the admin review preview (#296)', () => {
  it('carries the staged FAQs approval publishes, and none when there are none', () => {
    const faqs = [{ answer: 'Yes.', question: 'Is there a free plan?' }]
    expect(stagedPreview({ ...staged, faqs }, 'https://cdn.example')).toMatchObject({
      listing: { faqs }
    })
    const without = stagedPreview({ ...staged, faqs: [] }, 'https://cdn.example')
    expect('listing' in without && without.listing.faqs).toBeFalsy()
  })

  it('shows Verified owner as the live page will', () => {
    const submitter = { email: 'maya@example.com' }
    // A listing that exists already follows its current owner, whoever submitted it.
    expect(previewVerifiedOwner({ listing: { verifiedOwner: true }, submitter: null })).toBe(true)
    expect(previewVerifiedOwner({ listing: { verifiedOwner: false }, submitter })).toBe(false)
    // An unpublished submission gets an owner at approval when its submitter is signed in.
    expect(previewVerifiedOwner({ listing: null, submitter })).toBe(true)
    expect(previewVerifiedOwner({ listing: null, submitter: null })).toBe(false)
  })
})
