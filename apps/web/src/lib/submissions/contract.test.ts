import {
  VERIFICATION_COOLDOWN_SECONDS as DATA_COOLDOWN,
  SUBMISSION_LIMITS,
  VERIFICATION_MAX_ATTEMPTS
} from '@/db/submissions'
import { describe, expect, it } from 'vitest'
import { parseLocalDraft } from '../../components/submit/draft-storage'
import {
  checksLeft,
  checksPaused,
  descriptionLengthMessage,
  draftExpiresInDays,
  fieldErrors,
  newDraftSchema,
  nextStepPath,
  normalizeWebsiteInput,
  SUBMISSION_FIELD_LIMITS,
  VERIFICATION_ATTEMPT_LIMIT,
  VERIFICATION_COOLDOWN_SECONDS,
  verificationInstant
} from './contract'

const valid = {
  categorySlug: 'tools',
  content: '',
  description: 'One sentence.',
  logoUrl: 'https://example.com/logo.png',
  name: 'Example',
  website: 'https://example.com/'
}

describe('submit contract', () => {
  it('matches the limits the data layer enforces', () => {
    expect(SUBMISSION_FIELD_LIMITS).toEqual(SUBMISSION_LIMITS)
    expect(VERIFICATION_ATTEMPT_LIMIT).toBe(VERIFICATION_MAX_ATTEMPTS)
    expect(VERIFICATION_COOLDOWN_SECONDS).toBe(DATA_COOLDOWN)
  })

  it('requires name, URL, short description, category, and logo; long content is optional', () => {
    expect(newDraftSchema.safeParse(valid).success).toBe(true)
    const result = newDraftSchema.safeParse({
      categorySlug: '',
      description: 'x'.repeat(161),
      logoUrl: 'not a url',
      name: ' ',
      website: 'ftp://example.com'
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(fieldErrors(result.error)).toEqual({
      categorySlug: 'Choose a primary category.',
      description: descriptionLengthMessage(161),
      logoUrl: 'Add a logo. Use the one from your site or paste an image link.',
      name: 'Enter the product name.',
      website: 'Enter your website address, starting with https://.'
    })
    expect(descriptionLengthMessage(178)).toBe('Keep it to 160 characters or fewer. It’s 178 now.')
  })

  it('adds https:// to a bare domain and knows the next step', () => {
    expect(normalizeWebsiteInput(' quillmate.app ')).toBe('https://quillmate.app')
    expect(normalizeWebsiteInput('http://a.example')).toBe('http://a.example')
    expect(normalizeWebsiteInput('')).toBe('')
    expect(nextStepPath({ id: 'x', status: 'draft' })).toBe('/submit/x/choose/')
    expect(nextStepPath({ id: 'x', status: 'pending_badge' })).toBe('/submit/x/badge/')
    expect(nextStepPath({ id: 'x', status: 'verified' })).toBe('/submit/x/badge/')
    expect(nextStepPath({ id: 'x', status: 'approved' })).toBe('/account/')
  })

  it('counts draft days and badge checks', () => {
    const now = new Date('2026-10-06T12:00:00.000Z')
    expect(draftExpiresInDays('2026-10-06T12:00:00.000Z', now)).toBe(30)
    expect(draftExpiresInDays('2026-09-06T13:00:00.000Z', now)).toBe(1)
    expect(draftExpiresInDays('2026-08-01T00:00:00.000Z', now)).toBe(0)
    expect(draftExpiresInDays(null, now)).toBeNull()
    expect(verificationInstant('2026-10-06 12:00:00')).toBe(Date.parse('2026-10-06T12:00:00Z'))
    expect(
      checksLeft({ lastVerificationError: 'link_not_followed', verificationAttempts: 3 })
    ).toBe(7)
    for (const code of ['badge_missing', 'link_not_followed', 'nofollow', 'wrong_destination']) {
      expect(checksPaused({ lastVerificationError: code, verificationAttempts: 10 }), code).toBe(
        true
      )
    }
    // A connection problem after the tenth miss does not pause checks.
    expect(checksPaused({ lastVerificationError: 'fetch_timeout', verificationAttempts: 10 })).toBe(
      false
    )
  })
})

describe('local submit draft', () => {
  it('restores only well-formed, recent drafts and never more than the form holds', () => {
    const now = Date.parse('2026-10-06T12:00:00.000Z')
    const stored = JSON.stringify({
      categorySlug: 'tools',
      content: 'Long',
      description: 'Short',
      filled: { name: 'og:site_name', token: 'x' },
      logoChoice: 'site-icon',
      logoUrl: 'https://example.com/i.png',
      name: 'Example',
      savedAt: now - 1000,
      siteIcon: 'https://example.com/i.png',
      socialImage: 'javascript:alert(1)',
      website: 'https://example.com'
    })
    expect(parseLocalDraft(stored, now)).toEqual({
      categorySlug: 'tools',
      content: 'Long',
      description: 'Short',
      filled: { name: 'og:site_name' },
      logoChoice: 'site-icon',
      logoUrl: 'https://example.com/i.png',
      name: 'Example',
      savedAt: now - 1000,
      siteIcon: 'https://example.com/i.png',
      socialImage: null,
      website: 'https://example.com'
    })
    expect(parseLocalDraft(stored, now + 31 * 86_400_000)).toBeNull()
    expect(parseLocalDraft('{not json', now)).toBeNull()
    expect(parseLocalDraft(JSON.stringify({ savedAt: now }), now)).toBeNull()
  })
})
