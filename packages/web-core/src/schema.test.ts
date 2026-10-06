import { describe, expect, it } from 'vitest'
import { DEFAULT_SITE_LISTING_LOGO_FALLBACK_PATH } from './listing-logo-presentation'
import {
  generateWebsiteDetailSchema,
  type ListingPricing,
  type WebsiteMetadataLike
} from './schema'
import { SITE_LOGO_URL, SITE_PUBLIC_URL } from './seo-config'

const listing: WebsiteMetadataLike = {
  category: 'video-downloaders',
  description: 'Downloads videos.',
  name: 'Example Downloader',
  publishedAt: '2026-05-16',
  slug: 'example-downloader',
  website: 'https://example.com/'
}

function graphNode(schema: ReturnType<typeof generateWebsiteDetailSchema>, type: string) {
  const node = schema['@graph'].find(entry => entry['@type'] === type)
  if (!node) throw new Error(`missing ${type} node`)
  return node as Record<string, unknown>
}

function webPageNode(schema: ReturnType<typeof generateWebsiteDetailSchema>) {
  return graphNode(schema, 'WebPage')
}

function softwareNode(schema: ReturnType<typeof generateWebsiteDetailSchema>) {
  return graphNode(schema, 'SoftwareApplication')
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

describe('listing detail JSON-LD offer', () => {
  it('omits the offer when the pricing is unknown instead of claiming the product is free', () => {
    const schema = generateWebsiteDetailSchema(listing)
    const serialized = JSON.stringify(schema)

    expect(softwareNode(schema)).not.toHaveProperty('offers')
    expect(serialized).not.toContain('"Offer"')
    expect(serialized).not.toContain('"price"')
    // The node stays a valid SoftwareApplication: schema.org requires no property.
    expect(softwareNode(schema)).toMatchObject({
      '@id': `${SITE_PUBLIC_URL}/products/example-downloader/#software`,
      name: 'Example Downloader',
      url: 'https://example.com/'
    })
  })

  it('offers a free product at price 0', () => {
    const schema = generateWebsiteDetailSchema({ ...listing, pricing: { model: 'free' } })

    expect(softwareNode(schema).offers).toEqual({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock'
    })
  })

  it.each([
    ['19.99', 'EUR'],
    ['0.99', 'USD'],
    ['49', 'GBP']
  ])('offers a paid product at %s %s', (price, currency) => {
    const schema = generateWebsiteDetailSchema({
      ...listing,
      pricing: { model: 'paid', price, currency }
    })

    expect(softwareNode(schema).offers).toEqual({
      '@type': 'Offer',
      price,
      priceCurrency: currency,
      availability: 'https://schema.org/InStock'
    })
  })

  it.each(['Paid', 'subscription', 'freemium'])(
    'omits the offer for an unknown pricing model (%s)',
    model => {
      // Pricing will come from stored data, so a model outside the union must fail closed.
      const pricing = { model, price: '19.99', currency: 'USD' } as unknown as ListingPricing
      const schema = generateWebsiteDetailSchema({ ...listing, pricing })

      expect(softwareNode(schema)).not.toHaveProperty('offers')
    }
  )

  it.each([
    ['a zero price', '0', 'USD'],
    ['a negative price', '-5', 'USD'],
    ['a currency symbol in the price', '$19.99', 'USD'],
    ['a thousands separator', '1,299.00', 'USD'],
    ['leading zeros', '007', 'USD'],
    ['an empty price', '', 'USD'],
    ['a lowercase currency', '19.99', 'usd'],
    ['a currency symbol as the currency', '19.99', '$'],
    ['an empty currency', '19.99', '']
  ])('omits the offer for a paid product with %s', (_label, price, currency) => {
    const schema = generateWebsiteDetailSchema({
      ...listing,
      pricing: { model: 'paid', price, currency }
    })

    expect(softwareNode(schema)).not.toHaveProperty('offers')
  })
})
