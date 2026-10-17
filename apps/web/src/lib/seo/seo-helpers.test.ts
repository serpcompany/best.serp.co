import { describe, expect, it } from 'vitest'
import { generateBaseMetadata } from './seo-config'
import {
  composeMetaDescription,
  META_DESCRIPTION_MAX_LENGTH,
  META_DESCRIPTION_MIN_LENGTH
} from './seo-helpers'

describe('composeMetaDescription', () => {
  const explore = [
    'Explore Kive in the SERP directory, with resource links, category details, and related entries.',
    'Explore Kive in the SERP directory.'
  ]

  it('pads a short description with the longest extra that fits', () => {
    const description = composeMetaDescription('AI Transforms Brand Content Creation with Kive', [
      explore,
      ['Category: AI Design.']
    ])
    expect(description).toBe(
      'AI Transforms Brand Content Creation with Kive. Explore Kive in the SERP directory, with resource links, category details, and related entries.'
    )
    expect(description.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_LENGTH)
  })

  it('falls back to a shorter extra and keeps padding until the minimum', () => {
    const base = 'Download 321Tube videos from the page you are watching privately.'
    const description = composeMetaDescription(base, [explore, ['Category: Video Downloaders.']])
    expect(description).toBe(
      `${base} Explore Kive in the SERP directory. Category: Video Downloaders.`
    )
  })

  it('leaves a description that is already long enough alone', () => {
    const base =
      'That viral thought-leadership post with the perfect carousel will be buried by tomorrow. Save LinkedIn posts before it goes.'
    expect(composeMetaDescription(base, [explore])).toBe(base)
  })

  it('truncates a description over the maximum at a word', () => {
    const base = `${'word '.repeat(40)}end.`
    const description = composeMetaDescription(base)
    expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_LENGTH)
    expect(description.endsWith('word...')).toBe(true)
  })
})

describe('generateBaseMetadata', () => {
  it('keeps noindex pages following their links', () => {
    const metadata = generateBaseMetadata({
      title: 'DMCA',
      description: 'DMCA policy.',
      path: '/legal/dmca/',
      noindex: true
    })
    expect(metadata.robots).toMatchObject({
      index: false,
      follow: true,
      googleBot: { index: false, follow: true }
    })
  })
})
