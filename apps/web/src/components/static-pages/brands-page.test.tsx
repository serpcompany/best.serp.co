import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNetworkBrands } from '@/lib/site/network-brands'
import BrandsPage from './brands-page'

describe('/brands/ page (#193)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every brand with its name as the link text (#166), its logo, and its description', () => {
    const brands = getNetworkBrands()
    const markup = renderToStaticMarkup(<BrandsPage />)
    const links = [...markup.matchAll(/<h2[^>]*><a [^>]*href="([^"]+)"[^>]*>([^<]+)<svg/gu)].map(
      ([, href, text]) => ({ href, text })
    )
    const logos = [...markup.matchAll(/<img alt="" [^>]*src="([^"]+)"/gu)].map(([, src]) => src)

    expect(links).toEqual(brands.map(brand => ({ href: brand.url, text: brand.name })))
    expect(logos).toEqual(brands.map(brand => brand.imageSrc))
    for (const brand of brands) {
      expect(markup).toContain(brand.description.replaceAll("'", '&#x27;'))
    }
    expect(markup).toContain(`"numberOfItems":${brands.length}`)
  })
})
