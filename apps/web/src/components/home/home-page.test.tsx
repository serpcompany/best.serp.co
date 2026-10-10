import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePageCanonicalTags, homePageMetadata } from './home-page'

describe('homepage canonical URL', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves canonical and og:url out of metadata, where Next.js would add a slash', () => {
    expect(homePageMetadata().alternates).toBeUndefined()
    expect(homePageMetadata().openGraph?.url).toBeUndefined()
    expect(homePageMetadata().openGraph?.title).toBeTruthy()
  })

  it('sets an absolute title, so the root layout template adds no suffix', () => {
    expect(homePageMetadata().title).toEqual({
      absolute: 'SERP Directory of Products and Resources'
    })
  })

  it('renders both tags with the bare origin', () => {
    expect(renderToStaticMarkup(<HomePageCanonicalTags />)).toBe(
      '<link rel="canonical" href="https://best.serp.co"/><meta property="og:url" content="https://best.serp.co"/>'
    )
  })

  it("renders staging's own bare origin on staging (#359)", () => {
    const key = Symbol.for('__cloudflare-context__')
    const global = globalThis as Record<symbol, unknown>
    global[key] = { env: { SITE_ENVIRONMENT: 'staging' } }
    try {
      expect(renderToStaticMarkup(<HomePageCanonicalTags />)).toBe(
        '<link rel="canonical" href="https://staging.best.serp.co"/><meta property="og:url" content="https://staging.best.serp.co"/>'
      )
    } finally {
      delete global[key]
    }
  })
})
