import { describe, expect, it } from 'vitest'
import {
  decisionEmailNote,
  previewVerifiedOwner,
  stagedPreview,
  withCreatedTag
} from './review-view'

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

describe('a tag created from a suggested category (#406)', () => {
  it('joins the edits’ tags last, but never past the limit', () => {
    expect(withCreatedTag(['a'], 'b', 3)).toEqual(['a', 'b'])
    expect(withCreatedTag(['a', 'b'], 'a', 3)).toEqual(['a', 'b'])
    expect(withCreatedTag(['a', 'b', 'c'], 'd', 3)).toBeNull()
  })
})

describe('the email line a decision’s toast adds (#490)', () => {
  it('says what the decision’s email did, and warns when it didn’t go out', () => {
    const to = 'maya@example.com'
    expect(decisionEmailNote({ outcome: 'sent', to })).toEqual({
      text: 'Email sent to maya@example.com',
      warn: false
    })
    expect(decisionEmailNote({ outcome: 'no_account' })).toEqual({
      text: 'No email: no account on file',
      warn: false
    })
    expect(decisionEmailNote({ outcome: 'paid' })).toEqual({
      text: 'No email for paid listings yet',
      warn: false
    })
    expect(decisionEmailNote({ outcome: 'failed', to })).toEqual({
      text: 'Email to maya@example.com failed to send',
      warn: true
    })
    expect(decisionEmailNote({ outcome: 'pending', to })).toEqual({
      text: 'Email to maya@example.com is still pending',
      warn: true
    })
    expect(decisionEmailNote({ outcome: 'not_sent', to })).toEqual({
      text: 'Email to maya@example.com wasn’t sent',
      warn: true
    })
    // A decision that answers no email (a revision's, allow resubmission) adds no line.
    expect(decisionEmailNote(undefined)).toBeNull()
    expect(decisionEmailNote(null)).toBeNull()
  })
})
