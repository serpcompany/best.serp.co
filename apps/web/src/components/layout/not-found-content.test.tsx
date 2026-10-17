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

/** A best page that renders, under the Writing Tools hub. */
const bestPages = [
  { heading: 'Best Writing Apps', hub: 'writing-tools', slug: 'writing-app' } as PublishedBestPage,
  { heading: 'Best Design Apps', hub: 'design-tools', slug: 'design-app' } as PublishedBestPage
]
const categories = [
  { count: 3, description: '', name: 'Design Tools', order: 1, slug: 'design-tools' },
  { count: 49, description: '', name: 'Writing Tools', order: 0, slug: 'writing-tools' }
]
const newest = [
  { name: 'Quill', slug: 'quill.app' },
  { name: 'Inkpot', slug: 'inkpot.app' }
]
const none = { bestPages: [], categories: [], listingTotal: 0, newest: [] }

describe('the 404 page (#279, #53)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the homepage and the index pages, then a section for each kind of link', () => {
    const markup = renderToStaticMarkup(
      <NotFoundContent
        bestPages={bestPages}
        categories={categories}
        listingTotal={401}
        newest={newest}
      />
    )
    expect(markup).toMatch(/<p [^>]*>404<\/p><h1 [^>]*>Page not found<\/h1>/u)
    expect(hrefsIn(markup)).toEqual(
      [
        getRoute('home'),
        getRoute('category.index'),
        getRoute('best.index'),
        getRoute('brands'),
        getRoute('sitemap.index'),
        // Categories
        getRoute('category.page', { category: 'design-tools' }),
        getRoute('category.page', { category: 'writing-tools' }),
        // Best of, under each hub by name
        getRoute('best.page', { keyword: 'design-app' }),
        getRoute('best.page', { keyword: 'writing-app' }),
        // Newest
        getRoute('listing.detail', { slug: 'quill.app' }),
        getRoute('listing.detail', { slug: 'inkpot.app' }),
        // Listings: the HTML sitemap's numbered pages
        '/sitemap/listings/',
        '/sitemap/listings/2/',
        '/sitemap/listings/3/'
      ].map(path)
    )
    const headings = [...markup.matchAll(/<h2 [^>]*>([^<]+)<\/h2>/gu)].map(([, text]) => text)
    expect(headings).toEqual(['Categories', 'Best of', 'Newest', 'Listings'])
    expect(markup).toMatch(/<h3 [^>]*>Design Tools<\/h3>/u)
    expect(markup).toContain('>201–400</a>')
    expect(markup).toContain('>401</a>')
  })

  it('searches through the search page', () => {
    const markup = renderToStaticMarkup(<NotFoundContent {...none} categories={categories} />)
    expect(markup).toMatch(/<form [^>]*action="\/search\/?"[^>]*method="get"/u)
    expect(markup).toMatch(/<input [^>]*name="q"/u)
  })

  it('leaves out the best index while it lists nothing, and each section with nothing to link', () => {
    const markup = renderToStaticMarkup(<NotFoundContent {...none} />)
    expect(hrefsIn(markup)).toEqual(
      [
        getRoute('home'),
        getRoute('category.index'),
        getRoute('brands'),
        getRoute('sitemap.index')
      ].map(path)
    )
    expect(markup).not.toContain('<h2')
    expect(markup).not.toContain('border-t pt-11')
  })

  it('sets no robots directive, leaving Next.js’s one noindex tag', () => {
    const metadata = notFoundMetadata()
    expect(metadata).not.toHaveProperty('robots')
    expect(metadata.title).toBe('Page Not Found')
  })
})
