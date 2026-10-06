import { describe, expect, it } from 'vitest'
import { featuredImageView } from './featured-image'

const key = 'best.serp.co/submissions/sub_1/image/0123456789abcdef.png'

describe('the featured image a reviewer sees (#96 review round 2, B1)', () => {
  it('shows the hosted copy and sends back its key, or adopts none', () => {
    expect(featuredImageView({ imageKey: key }, 'https://cdn.serp.co')).toEqual({
      image: `https://cdn.serp.co/${key}`,
      key
    })
    expect(featuredImageView({ imageKey: null }, '/_media')).toEqual({ image: null, key: null })
  })
})
