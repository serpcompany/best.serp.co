import { describe, expect, it } from 'vitest'
import { siteConfig } from '../site/site-config'
import { withDubVia } from './dub-via'

describe('withDubVia (#169)', () => {
  it.each([
    ['https://serp.ly/vimeo-downloader', 'https://serp.ly/vimeo-downloader?via=best.serp.co'],
    ['https://serp.ly/@serp/youtube', 'https://serp.ly/@serp/youtube?via=best.serp.co'],
    ['https://SERP.ly/x?utm_source=a#top', 'https://serp.ly/x?utm_source=a&via=best.serp.co#top'],
    ['http://serp.ly/x', 'http://serp.ly/x?via=best.serp.co'],
    // An existing query keeps its exact encoding.
    ['https://serp.ly/x?q=a%20b~c', 'https://serp.ly/x?q=a%20b~c&via=best.serp.co'],
    ['https://serp.ly/x?', 'https://serp.ly/x?via=best.serp.co']
  ])('adds the partner ID to %s', (url, expected) => {
    expect(withDubVia(url, 'best.serp.co')).toBe(expected)
  })

  it.each([
    'https://serp.ly/x?via=someone-else',
    'https://vendor.example.com/pricing?plan=pro#buy',
    'https://www.serp.ly/x',
    'https://serp.ly.example.com/x',
    'mailto:hello@serp.ly',
    'not a url',
    '/products/x/'
  ])('leaves %s unchanged', url => {
    expect(withDubVia(url, 'best.serp.co')).toBe(url)
  })

  it('leaves links unchanged without a partner ID', () => {
    expect(withDubVia('https://serp.ly/x', null)).toBe('https://serp.ly/x')
    expect(withDubVia('https://serp.ly/x', ' ')).toBe('https://serp.ly/x')
  })

  it("defaults to the site's configured partner ID", () => {
    expect(siteConfig.dubPartnerId).toBe('best.serp.co')
    expect(withDubVia('https://serp.ly/x')).toBe('https://serp.ly/x?via=best.serp.co')
  })
})
