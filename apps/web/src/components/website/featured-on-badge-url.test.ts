import { describe, expect, it } from 'vitest'
import { buildFeaturedOnBadgeEmbedHtml } from './featured-on-badge-embed-panel'
import {
  getFeaturedOnBadgeListingUrl,
  getFeaturedOnBadgePreviewPathFromKey,
  getFeaturedOnBadgePublicUrlFromKey
} from './featured-on-badge-url'

describe('featured-on badge URL helpers', () => {
  it('builds local preview and public paths from relative badge keys', () => {
    expect(getFeaturedOnBadgePreviewPathFromKey('badge/featured-on-example-light.svg')).toBe(
      '/badge/featured-on-example-light.svg'
    )
    expect(getFeaturedOnBadgePublicUrlFromKey('badge/featured-on-example-light.svg')).toBe(
      '/badge/featured-on-example-light.svg'
    )
  })

  it('builds absolute public URLs from local public badge paths', () => {
    expect(
      getFeaturedOnBadgePublicUrlFromKey(
        'badge/browserextensions.io-featured-on-light.svg',
        'https://browserextensions.io/'
      )
    ).toBe('https://browserextensions.io/badge/browserextensions.io-featured-on-light.svg')
  })

  it('builds listing URLs with the configured detail suffix for copied badge embeds', () => {
    expect(
      getFeaturedOnBadgeListingUrl({
        listingBasePath: 'products',
        listingDetailSuffix: 'reviews',
        publicUrl: 'https://serp.co/',
        slug: 'launchbuzz.io'
      })
    ).toBe('https://serp.co/products/launchbuzz.io/reviews/')
  })

  it('builds listing URLs without a detail suffix when the site has none', () => {
    expect(
      getFeaturedOnBadgeListingUrl({
        listingBasePath: 'products',
        publicUrl: 'https://serp.software',
        slug: 'launchbuzz.io'
      })
    ).toBe('https://serp.software/products/launchbuzz.io/')
  })

  it('uses the route-aware listing URL in copied badge embed HTML', () => {
    const listingUrl = getFeaturedOnBadgeListingUrl({
      listingBasePath: 'products',
      listingDetailSuffix: 'reviews',
      publicUrl: 'https://serp.ai',
      slug: 'launchbuzz.io'
    })

    expect(
      buildFeaturedOnBadgeEmbedHtml({
        badgeUrl: 'https://serp.ai/badge/featured-on-serp.ai-light.svg',
        listingUrl,
        siteName: 'SERP AI'
      })
    ).toBe(`<a href="https://serp.ai/products/launchbuzz.io/reviews/" target="_blank" rel="noopener noreferrer" title="Featured on SERP AI">
  <img src="https://serp.ai/badge/featured-on-serp.ai-light.svg" alt="Featured on SERP AI" width="200" height="50" />
</a>`)
  })
})
