import { describe, expect, it } from 'vitest'
import { submissionRequestSchema, submissionSlug } from './submission-contract'

const valid = {
  category: 'seo-tools',
  content: 'A sufficiently complete product description.',
  description: 'A useful short description.',
  faqs: [],
  logoUrl: 'https://example.com/logo.png',
  name: 'Example',
  resourceLinks: [],
  videoUrl: '',
  website: 'https://www.Example.com/product'
}

describe('submission contract', () => {
  it('normalizes the future listing slug from the website host', () => {
    expect(submissionSlug(valid.website)).toBe('example.com')
  })

  it('accepts normalized repeatable fields and rejects non-http URLs', () => {
    expect(submissionRequestSchema.parse(valid)).toEqual(valid)
    expect(() =>
      submissionRequestSchema.parse({ ...valid, website: 'file:///etc/passwd' })
    ).toThrow()
  })
})
