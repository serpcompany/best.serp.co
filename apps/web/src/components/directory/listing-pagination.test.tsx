import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ListingPagination,
  listingPageHref,
  paginatedMetadata,
  paginationWindow,
  parseListingPageParam
} from './listing-pagination'

describe('listing pagination', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses only positive integer page parameters', () => {
    expect(parseListingPageParam(undefined)).toBe(1)
    expect(parseListingPageParam('3')).toBe(3)
    expect(parseListingPageParam(['4', '5'])).toBe(4)
    for (const invalid of ['0', '-1', '01', '2.5', 'two', '', '9999999']) {
      expect(parseListingPageParam(invalid), invalid).toBe(1)
    }
  })

  it('keeps page 1 on the bare URL and puts later pages in a query parameter', () => {
    expect(listingPageHref('/products/', 1)).toBe('/products/')
    expect(listingPageHref('/products/', 2)).toBe('/products/?page=2')
    expect(listingPageHref('/products/', 3, 'all-products')).toBe('/products/?page=3#all-products')
  })

  it('shows the first, last, and neighbouring pages', () => {
    expect(paginationWindow(1, 1)).toEqual([1])
    expect(paginationWindow(1, 72)).toEqual([1, 2, 'gap', 72])
    expect(paginationWindow(5, 72)).toEqual([1, 'gap', 4, 5, 6, 'gap', 72])
    expect(paginationWindow(3, 4)).toEqual([1, 2, 3, 4])
  })

  it('leaves page 1 metadata untouched and marks later pages noindex, follow', () => {
    const base = {
      alternates: { canonical: 'https://best.serp.co/products/' },
      openGraph: { url: 'https://best.serp.co/products/' },
      title: 'Products - SERP'
    }
    expect(paginatedMetadata(base, { basePath: '/products/', page: 1 })).toBe(base)
    expect(paginatedMetadata(base, { basePath: '/products/', page: 2 })).toMatchObject({
      alternates: { canonical: 'https://best.serp.co/products/?page=2' },
      openGraph: { url: 'https://best.serp.co/products/?page=2' },
      robots: { follow: true, index: false },
      title: 'Products - SERP - Page 2'
    })
  })

  it('renders crawlable anchors with prev/next relations', () => {
    expect(
      renderToStaticMarkup(<ListingPagination basePath="/products/" page={1} pageCount={1} />)
    ).toBe('')
    const html = renderToStaticMarkup(
      <ListingPagination basePath="/products/categories/other/" page={2} pageCount={3} />
    )
    expect(html).toContain('href="/products/categories/other/" rel="prev"')
    expect(html).toContain('href="/products/categories/other/?page=3" rel="next"')
    expect(html).toContain('aria-current="page"')
  })
})
