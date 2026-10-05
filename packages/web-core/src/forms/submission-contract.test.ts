import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { submissionRequestSchema } from './submission-contract'

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
  it('leaves slug normalization (and the Public Suffix List) out of the browser bundle', () => {
    const source = readFileSync(new URL('./submission-contract.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '(?:@serpdirectory\/utils\/url-key|tldts)'/u)
  })

  it('accepts normalized repeatable fields and rejects non-http URLs', () => {
    expect(submissionRequestSchema.parse(valid)).toEqual(valid)
    expect(() =>
      submissionRequestSchema.parse({ ...valid, website: 'file:///etc/passwd' })
    ).toThrow()
  })
})
