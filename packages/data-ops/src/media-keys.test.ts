import { describe, expect, it } from 'vitest'
import {
  contentTypeForKey,
  isMediaKey,
  LOCAL_MEDIA_PATH,
  mediaKey,
  mediaUrl,
  parseMediaKey,
  resolveListingDetailMedia,
  resolveListingMedia,
  sha256Hex,
  validateMediaBaseUrl
} from './media-keys'

const sha = 'ab'.repeat(32)
const logoKey = `best.serp.co/listings/dr.serp.co/logo/${sha.slice(0, 16)}.png`

describe('media keys', () => {
  it('names an image by site, listing, kind, content hash, and format', () => {
    expect(mediaKey({ format: 'png', kind: 'logo', sha256: sha, slug: 'dr.serp.co' })).toBe(logoKey)
    expect(mediaKey({ format: 'jpeg', kind: 'image', sha256: sha, slug: 'a-b' })).toMatch(
      /^best\.serp\.co\/listings\/a-b\/image\/abababababababab\.jpg$/u
    )
    expect(() => mediaKey({ format: 'png', kind: 'logo', sha256: 'x', slug: 'a' })).toThrow(/SHA/u)
    expect(() => mediaKey({ format: 'png', kind: 'logo', sha256: sha, slug: '../a' })).toThrow(
      /slug/u
    )
  })

  it('parses only this site’s listing keys', () => {
    expect(parseMediaKey(logoKey)).toEqual({
      extension: 'png',
      hash: sha.slice(0, 16),
      kind: 'logo',
      slug: 'dr.serp.co'
    })
    expect(contentTypeForKey(logoKey)).toBe('image/png')
    for (const value of [
      'https://cdn.serp.co/best.serp.co/listings/x/logo/abababababababab.png',
      '/listing-logos/serpdownloaders.com/beeg-downloader.png',
      'serp.co/listings/x/logo/abababababababab.png',
      'best.serp.co/listings/x/video/abababababababab.png',
      'best.serp.co/listings/x/logo/abababababababab.svg',
      'best.serp.co/listings/x/logo/ABABABABABABABAB.png'
    ]) {
      expect(isMediaKey(value), value).toBe(false)
    }
  })

  it('builds URLs on the media host and leaves anything else unchanged', () => {
    expect(mediaUrl(logoKey, 'https://cdn.serp.co')).toBe(`https://cdn.serp.co/${logoKey}`)
    expect(mediaUrl(logoKey, LOCAL_MEDIA_PATH)).toBe(`/_media/${logoKey}`)
    expect(mediaUrl('https://example.com/a.png', 'https://cdn.serp.co')).toBe(
      'https://example.com/a.png'
    )
    const summary = { media: { logo: logoKey }, name: 'x' }
    expect(resolveListingMedia(summary, 'https://cdn-staging.serp.co')).toEqual({
      media: { logo: `https://cdn-staging.serp.co/${logoKey}` },
      name: 'x'
    })
    const noMedia: { media?: { logo?: string }; name: string } = { name: 'y' }
    expect(resolveListingMedia(noMedia, 'https://cdn.serp.co')).toEqual({ name: 'y' })
    const detail = resolveListingDetailMedia(
      {
        media: { images: [logoKey.replace('/logo/', '/image/'), '/x.png'], logo: logoKey },
        nextWebsite: { media: { logo: logoKey } },
        previousWebsite: null,
        relatedWebsites: [{ media: { logo: logoKey } }, {}]
      },
      'https://cdn.serp.co'
    )
    expect(detail.media?.images).toEqual([
      `https://cdn.serp.co/${logoKey.replace('/logo/', '/image/')}`,
      '/x.png'
    ])
    expect(detail.nextWebsite?.media?.logo).toBe(`https://cdn.serp.co/${logoKey}`)
    expect(detail.relatedWebsites).toEqual([
      { media: { logo: `https://cdn.serp.co/${logoKey}` } },
      {}
    ])
  })

  it('takes the media host as an https origin remotely and /_media locally, else fails closed', () => {
    expect(validateMediaBaseUrl('https://cdn.serp.co', 'production')).toBe('https://cdn.serp.co')
    expect(validateMediaBaseUrl('/_media', 'local')).toBe('/_media')
    for (const [value, runtime] of [
      [undefined, 'production'],
      ['', 'staging'],
      ['http://cdn.serp.co', 'production'],
      ['https://cdn.serp.co/', 'production'],
      ['https://cdn.serp.co/best.serp.co', 'production'],
      ['/_media', 'staging'],
      ['https://cdn.serp.co', 'local']
    ] as const) {
      expect(() => validateMediaBaseUrl(value, runtime), `${value} ${runtime}`).toThrow(
        /MEDIA_BASE_URL/u
      )
    }
  })

  it('hashes bytes as lowercase hex SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
