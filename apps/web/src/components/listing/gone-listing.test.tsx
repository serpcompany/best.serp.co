import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderingCategory } from '@/lib/seo/taxonomy-indexing'
import { GoneListing } from './gone-listing'

/** Hrefs in the markup; next/link drops the trailing slash outside the app. */
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a [^>]*href="([^"]+)"/gu)].map(([, href]) =>
    (href ?? '').replace(/(.)\/$/u, '$1')
  )
}

describe('the 410 page links the hub only while its page renders (#347)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const categories = [
    { count: 12, description: '', name: 'Writing Tools', order: 0, slug: 'writing-tools' },
    // Its last public listing was unpublished: its page answers 404.
    { count: 0, description: '', name: 'Audio Tools', order: 1, slug: 'audio-tools' }
  ]
  const page = (category: string) =>
    renderToStaticMarkup(
      <GoneListing
        hub={renderingCategory(categories, category)}
        listing={{ name: 'Fixture Scribe' }}
      />
    )

  it('links the hub when its page renders', () => {
    const markup = page('writing-tools')
    expect(hrefs(markup)).toEqual([
      '/products/categories/writing-tools',
      '/products/categories/writing-tools',
      '/submit'
    ])
    expect(markup).toContain('Browse Writing Tools')
  })

  it('links the directory when the hub has no public listing', () => {
    const markup = page('audio-tools')
    expect(hrefs(markup)).toEqual(['/products', '/products', '/submit'])
    expect(markup).not.toContain('Audio Tools')
    expect(markup).toContain('the directory')
  })
})
