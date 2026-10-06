import { describe, expect, it } from 'vitest'
import {
  cacheControlForKey,
  contentTypeForKey,
  isListingMediaKey,
  isMediaKey,
  isPendingMediaKey,
  LOCAL_MEDIA_PATH,
  listingKeyForPendingKey,
  MEDIA_CACHE_CONTROL,
  mediaKey,
  mediaUrl,
  parseMediaKey,
  resolveListingDetailMedia,
  resolveListingMedia,
  SUBMISSION_MEDIA_CACHE_CONTROL,
  sha256Hex,
  validateMediaBaseUrl
} from './media-keys'

const sha = 'ab'.repeat(32)
const logoKey = `best.serp.co/listings/dr.serp.co/logo/${sha.slice(0, 16)}.png`

describe('media keys', () => {
  it("keeps a revision's pending logo under its own prefix (#96 review round 4, S1)", () => {
    const pending = mediaKey({ format: 'png', kind: 'logo', revisionId: 'rev_1', sha256: sha })
    expect(pending).toBe(`best.serp.co/revisions/rev_1/logo/${sha.slice(0, 16)}.png`)
    expect(parseMediaKey(pending)).toMatchObject({ owner: 'rev_1', scope: 'revisions', slug: '' })
    expect(isPendingMediaKey(pending)).toBe(true)
    expect(isPendingMediaKey(logoKey)).toBe(false)
    expect(isListingMediaKey(pending)).toBe(false)
    expect(listingKeyForPendingKey(pending, 'dr.serp.co')).toBe(logoKey)
    expect(cacheControlForKey(pending)).toBe(SUBMISSION_MEDIA_CACHE_CONTROL)
    expect(cacheControlForKey(logoKey)).toBe(MEDIA_CACHE_CONTROL)
    expect(() =>
      mediaKey({ format: 'png', kind: 'logo', revisionId: '../x', sha256: sha })
    ).toThrow(/revision id/u)
  })

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

  it('parses only this site’s listing and submission keys', () => {
    expect(parseMediaKey(logoKey)).toEqual({
      extension: 'png',
      hash: sha.slice(0, 16),
      kind: 'logo',
      owner: 'dr.serp.co',
      scope: 'listings',
      slug: 'dr.serp.co'
    })
    const pending = mediaKey({ format: 'png', kind: 'logo', sha256: sha, submissionId: 'sub_Ab-1' })
    expect(pending).toBe(`best.serp.co/submissions/sub_Ab-1/logo/${sha.slice(0, 16)}.png`)
    expect(parseMediaKey(pending)).toMatchObject({
      owner: 'sub_Ab-1',
      scope: 'submissions',
      slug: ''
    })
    expect(isMediaKey(pending)).toBe(true)
    // A submission's image never stands in a listing row; approval copies it to the listing path.
    expect(isListingMediaKey(pending)).toBe(false)
    expect(isListingMediaKey(logoKey)).toBe(true)
    expect(listingKeyForPendingKey(pending, 'dr.serp.co')).toBe(logoKey)
    expect(() => listingKeyForPendingKey(logoKey, 'dr.serp.co')).toThrow(/not a pending/u)
    expect(() => listingKeyForPendingKey(pending, '../x')).toThrow(/slug/u)
    expect(() =>
      mediaKey({ format: 'png', kind: 'logo', sha256: sha, submissionId: '../x' })
    ).toThrow(/submission id/u)
    expect(contentTypeForKey(logoKey)).toBe('image/png')
    for (const value of [
      'https://cdn.serp.co/best.serp.co/listings/x/logo/abababababababab.png',
      '/listing-logos/serpdownloaders.com/beeg-downloader.png',
      'serp.co/listings/x/logo/abababababababab.png',
      'best.serp.co/listings/x/video/abababababababab.png',
      'best.serp.co/listings/x/logo/abababababababab.svg',
      'best.serp.co/listings/x/logo/ABABABABABABABAB.png',
      'best.serp.co/listings/X/logo/abababababababab.png',
      'best.serp.co/uploads/x/logo/abababababababab.png',
      'best.serp.co/submissions/_x/logo/abababababababab.png'
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
