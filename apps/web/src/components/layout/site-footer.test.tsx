import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteFooter } from './site-footer'

beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the public footer', () => {
  it('shows the verified DR badge exactly as the owner gave it (#537)', () => {
    const markup = renderToStaticMarkup(<SiteFooter />)
    const links = [
      ...markup.matchAll(/<a [^>]*href="https:\/\/dr\.serp\.co\/[^"]*"[^>]*>.*?<\/a>/gu)
    ]
    expect(links).toHaveLength(1)
    const [link] = links[0] ?? []
    expect(link).toContain('href="https://dr.serp.co/sites/best.serp.co"')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
    const image = /<img [^>]*>/u.exec(link ?? '')?.[0] ?? ''
    expect(image).toContain('src="https://dr.serp.co/badge/best.serp.co?style=serp-dr-v3"')
    expect(image).toContain('alt="Verified DR 78 for best.serp.co"')
    expect(image).toContain('width="200"')
    expect(image).toContain('height="50"')
    expect(image).toContain('loading="lazy"')
    expect(image).toContain('decoding="async"')
  })
})
