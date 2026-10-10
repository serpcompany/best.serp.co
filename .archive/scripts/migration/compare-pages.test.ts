import { describe, expect, it } from 'vitest'
import { outboundRels, redirectsToTranslated, translateLegacyPath } from './compare-pages'

describe('migration page comparison', () => {
  it('accepts a legacy redirect only to exactly the translated route on the same origin', () => {
    const baseline = 'https://best.serp.co'
    const translated = translateLegacyPath('/products/autoenhance.ai/reviews/')
    expect(translated).toBe('/products/autoenhance.ai/')
    expect(
      redirectsToTranslated('https://best.serp.co/products/autoenhance.ai/', baseline, translated)
    ).toBe(true)
    for (const location of [
      null,
      'https://best.serp.co/',
      'https://best.serp.co/products/autoenhance.ai/?x=1',
      'https://elsewhere.example/products/autoenhance.ai/'
    ]) {
      expect(redirectsToTranslated(location, baseline, translated), String(location)).toBe(false)
    }
  })

  it('compares the rel of links to other sites, including the listing outbound link', () => {
    const html = `
      <a href="/products/">Directory</a>
      <a href="https://best.serp.co/about/">About</a>
      <a target="_blank" rel="noopener noreferrer" href="https://serp.ly/x?via=best.serp.co">Visit</a>
      <a href="https://vendor.example/" rel="nofollow noopener noreferrer">Vendor</a>
      <a href="https://plain.example/">Plain</a>`
    expect(outboundRels(html, 'http://127.0.0.1:8787')).toEqual([
      '(none)',
      'nofollow noopener noreferrer',
      'noopener noreferrer'
    ])
  })
})
