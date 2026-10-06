import { describe, expect, it } from 'vitest'
import { DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH } from './listing-logo-presentation'
import { generateWebsiteDetailSchema, type WebsiteMetadataLike } from './schema'
import { SITE_LOGO_URL, SITE_PUBLIC_URL } from './seo-config'

const listing: WebsiteMetadataLike = {
  category: 'video-downloaders',
  description: 'Downloads videos.',
  name: 'Example Downloader',
  publishedAt: '2026-05-16',
  slug: 'example-downloader',
  website: 'https://example.com/'
}

function webPageNode(schema: ReturnType<typeof generateWebsiteDetailSchema>) {
  const node = schema['@graph'].find(entry => entry['@type'] === 'WebPage')
  if (!node) throw new Error('missing WebPage node')
  return node as Record<string, unknown>
}

describe('listing detail JSON-LD image', () => {
  it('uses an absolute URL for a listing logo served by the site', () => {
    const schema = generateWebsiteDetailSchema({
      ...listing,
      media: { logo: '/listing-logos/example.png' }
    })

    expect(webPageNode(schema).primaryImageOfPage).toEqual({
      '@type': 'ImageObject',
      url: `${SITE_PUBLIC_URL}/listing-logos/example.png`
    })
  })

  it('keeps a remote listing logo as is', () => {
    const logo = 'https://imagedelivery.net/account/example/public'
    const schema = generateWebsiteDetailSchema({ ...listing, media: { logo } })

    expect(webPageNode(schema).primaryImageOfPage).toEqual({ '@type': 'ImageObject', url: logo })
  })

  it.each([
    ['no media', undefined],
    ['no logo', { images: ['/images/screenshot.png'] }],
    ['an unusable logo', { logo: 'not-an-image' }]
  ])('omits the image for a listing with %s instead of the generic fallback', (_label, media) => {
    const schema = generateWebsiteDetailSchema({ ...listing, media })
    const serialized = JSON.stringify(schema)

    expect(webPageNode(schema)).not.toHaveProperty('primaryImageOfPage')
    expect(serialized).not.toContain(DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH)
    // The only image left is the site publisher logo on the TechArticle.
    expect(serialized.match(/"ImageObject"/gu)).toHaveLength(1)
    expect(serialized).toContain(JSON.stringify(SITE_LOGO_URL))
  })
})
