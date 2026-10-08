import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LISTING_LOGO_FALLBACK_PATH } from '../../lib/directory/listing-logo-presentation'
import { ListingImage } from './listing-image'

const hosted = 'https://cdn.serp.co/best.serp.co/listings/acme/logo/0123456789abcdef.png'

function image(markup: string): Record<string, string> {
  const tag = markup.match(/<img\b[^>]*>/u)?.[0] ?? ''
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map(([, name, value]) => [
      name,
      value?.replaceAll('&#x27;', "'").replaceAll('&amp;', '&')
    ])
  )
}

describe('ListingImage (#122)', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => vi.unstubAllGlobals())

  it('renders the tile on the server when there is no image', () => {
    for (const src of [undefined, null, '', '   ', '/not-an-image']) {
      const img = image(renderToStaticMarkup(<ListingImage name="Acme" src={src} size={40} />))
      expect(img.src, String(src)).toBe(LISTING_LOGO_FALLBACK_PATH)
      expect(img.alt).toBe('Acme fallback logo')
      expect(img['data-fallback']).toBe('')
      expect(img.width).toBe('40')
    }
  })

  it('renders a logo with its fixed box and the pre-hydration tile cover', () => {
    const img = image(renderToStaticMarkup(<ListingImage name="Acme" src={hosted} size={72} />))
    expect(img.src).toBe(hosted)
    expect(img.alt).toBe('Acme logo')
    expect(img['data-listing-image']).toBe('logo')
    expect(img).not.toHaveProperty('data-fallback')
    expect(img.referrerPolicy).toBe('no-referrer')
    expect(img.style).toContain('width:72px')
    expect(img.style).toContain('height:72px')
    // Drawn only for a broken image, so the icon and alt text never show before hydration.
    expect(img.class).toContain("after:bg-[url('/listing-logos/favicon-fallback-512x512.png')]")
    expect(img.class).toContain("after:content-['']")
    // Every engine (Safari draws no ::after on an <img>): the alt text is transparent and clipped.
    expect(img.class).toContain('text-transparent')
    expect(img.class).toContain('overflow-hidden')
  })

  it('renders a featured image in a fixed 1200x630 box, as the tile would be', () => {
    const markup = renderToStaticMarkup(
      <ListingImage kind="image" name="Acme" src={hosted.replace('/logo/', '/image/')} />
    )
    expect(markup).toMatch(/padding-bottom:52\.5%/u)
    const img = image(markup)
    expect(img.alt).toBe('Acme featured image')
    expect(img['data-listing-image']).toBe('image')
    expect(img.class).toContain('after:bg-[url(')
    expect(img.class).toContain('text-transparent')
    expect(img.class).toContain('overflow-hidden')

    const tile = image(renderToStaticMarkup(<ListingImage kind="image" name="Acme" src={null} />))
    expect(tile.src).toBe(LISTING_LOGO_FALLBACK_PATH)
    expect(tile.alt).toBe('')
  })
})
