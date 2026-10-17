import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedBestPage } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'
import { NotFoundContent, notFoundMetadata } from './not-found-content'

// next/link drops the trailing slash outside the app (no `trailingSlash` config here).
const path = (href: string) => href.replace(/(.)\/$/u, '$1')
const hrefsIn = (markup: string) =>
  [...markup.matchAll(/<a [^>]*href="([^"]+)"/gu)].map(([, href]) => path(href ?? ''))

/** A best page that renders; only its presence matters to the 404 page today. */
const bestPages = [{ slug: 'design-app' } as PublishedBestPage]
const categories = [
  { count: 3, description: '', name: 'Design Tools', order: 1, slug: 'design-tools' },
  { count: 49, description: '', name: 'Writing Tools', order: 0, slug: 'writing-tools' }
]

describe('the 404 page (#279, #53)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the page, offers the homepage, the index pages, the sitemap and every category', () => {
    const markup = renderToStaticMarkup(
      <NotFoundContent bestPages={bestPages} categories={categories} />
    )
    expect(markup).toMatch(/<h1 [^>]*>Page not found<\/h1>/u)
    expect(hrefsIn(markup)).toEqual(
      [
        getRoute('home'),
        getRoute('category.index'),
        getRoute('best.index'),
        getRoute('brands'),
        getRoute('sitemap.index'),
        getRoute('category.page', { category: 'design-tools' }),
        getRoute('category.page', { category: 'writing-tools' })
      ].map(path)
    )
  })

  it('searches through the search page', () => {
    const markup = renderToStaticMarkup(<NotFoundContent bestPages={[]} categories={categories} />)
    expect(markup).toMatch(/<form [^>]*action="\/search\/?"[^>]*method="get"/u)
    expect(markup).toMatch(/<input [^>]*name="q"/u)
  })

  it('leaves out the best index while it lists nothing, and the categories when none render', () => {
    const markup = renderToStaticMarkup(<NotFoundContent bestPages={[]} categories={[]} />)
    expect(hrefsIn(markup)).toEqual(
      [
        getRoute('home'),
        getRoute('category.index'),
        getRoute('brands'),
        getRoute('sitemap.index')
      ].map(path)
    )
    expect(markup).not.toContain('not-found-categories')
  })

  it('sets no robots directive, leaving Next.js’s one noindex tag', () => {
    const metadata = notFoundMetadata()
    expect(metadata).not.toHaveProperty('robots')
    expect(metadata.title).toBe('Page Not Found')
  })
})
