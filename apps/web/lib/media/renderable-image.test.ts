import { describe, expect, it } from 'vitest'
import { renderableImage } from './renderable-image'

const key = 'best.serp.co/listings/example.com/logo/0123456789abcdef.png'
const pending = 'best.serp.co/submissions/sub_1/logo/0123456789abcdef.png'

describe('renderableImage', () => {
  it('renders a hosted copy or an own-origin path, never another host’s URL', () => {
    expect(
      renderableImage({ key, url: 'https://example.com/logo.png' }, 'https://cdn.serp.co')
    ).toBe(`https://cdn.serp.co/${key}`)
    expect(renderableImage({ key: pending }, '/_media')).toBe(`/_media/${pending}`)
    expect(renderableImage({ url: '/listing-logos/example.com/logo.png' }, '/_media')).toBe(
      '/listing-logos/example.com/logo.png'
    )
    for (const url of ['https://example.com/logo.png', '//evil.example/x.png', '', null]) {
      expect(renderableImage({ key: null, url }, 'https://cdn.serp.co'), String(url)).toBeNull()
    }
    expect(renderableImage({ key: 'serp.co/x.png' }, 'https://cdn.serp.co')).toBeNull()
  })
})
