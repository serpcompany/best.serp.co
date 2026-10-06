import { describe, expect, it } from 'vitest'
import { featuredImageView } from './featured-image'

const key = 'best.serp.co/submissions/sub_1/image/0123456789abcdef.png'

describe('the featured image a reviewer sees (#96 review round 2, B1)', () => {
  it('shows the hosted copy and sends back its key, or says why approval publishes none', () => {
    expect(featuredImageView({ imageKey: key, imageSlot: null }, 'https://cdn.serp.co')).toEqual({
      image: `https://cdn.serp.co/${key}`,
      key,
      note: "The website's social image, hosted. Approving publishes it as the listing's featured image."
    })
    expect(featuredImageView({ imageKey: null, imageSlot: null }, '/_media')).toMatchObject({
      image: null,
      key: null,
      note: expect.stringMatching(/no usable social image\. Approving publishes none\./u)
    })
    const slot = {
      attempts: 1,
      lastError: 'http_503',
      nextAttemptAt: null,
      sourceUrl: 'https://example.com/og.png'
    }
    expect(
      featuredImageView({ imageKey: null, imageSlot: { ...slot, status: 'pending' } }, '/_media')
        .note
    ).toMatch(/^The website's social image is waiting to be hosted \(the server answered HTTP 503/u)
    expect(
      featuredImageView(
        { imageKey: null, imageSlot: { ...slot, lastError: 'svg', status: 'failed' } },
        '/_media'
      )
    ).toMatchObject({ image: null, key: null, note: expect.stringMatching(/^Couldn't host/u) })
  })
})
