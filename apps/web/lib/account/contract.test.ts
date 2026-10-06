import { describe, expect, it } from 'vitest'
import { resubmitRequestSchema } from './contract'

describe('the resubmit request (#65)', () => {
  const details = {
    categorySlug: 'tools',
    content: '',
    description: 'A plain description.',
    expectedContentVersion: 2,
    logoUrl: 'https://quillmate.app/logo.png',
    name: 'Quillmate'
  }

  it('takes FAQs and links together, or neither', () => {
    expect(resubmitRequestSchema.safeParse(details).success).toBe(true)
    expect(
      resubmitRequestSchema.safeParse({ ...details, faqs: [], resourceLinks: [] }).success
    ).toBe(true)
    expect(resubmitRequestSchema.safeParse({ ...details, faqs: [] }).success).toBe(false)
    expect(resubmitRequestSchema.safeParse({ ...details, resourceLinks: [] }).success).toBe(false)
  })
})
