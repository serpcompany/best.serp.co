import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectNavigation } from './project-navigation'

const listing = (slug: string) => ({ name: slug, slug, website: `https://${slug}.example` })

/**
 * Each list item's role in the two-column grid: an empty placeholder, or the card it links
 * (next/link drops the trailing slash outside the app, which has no `trailingSlash` config here).
 */
function items(markup: string): string[] {
  return [...markup.matchAll(/<li ([^>]*)>(.*?)<\/li>/gu)].map(([, attributes, body]) =>
    body ? (body.match(/href="([^"]+)"/u)?.[1] ?? 'card') : attributes
  )
}

describe('ProjectNavigation (#273)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('links the previous and next listings, in that order', () => {
    const markup = renderToStaticMarkup(
      <ProjectNavigation previousWebsite={listing('alpha')} nextWebsite={listing('gamma')} />
    )
    expect(items(markup)).toEqual(['/products/alpha', '/products/gamma'])
    expect(markup).toContain('Previous')
    expect(markup).toContain('Next')
  })

  it('keeps the next listing in the right column when there is no previous one', () => {
    const markup = renderToStaticMarkup(
      <ProjectNavigation previousWebsite={null} nextWebsite={listing('gamma')} />
    )
    // An empty, hidden placeholder takes the left column from the small breakpoint up.
    expect(items(markup)).toEqual(['class="max-sm:hidden" aria-hidden="true"', '/products/gamma'])
  })
})
