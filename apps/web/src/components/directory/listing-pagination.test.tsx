import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ListingPagination,
  listingPageHref,
  PAGINATION_JUMP,
  paginatedMetadata,
  paginationEntries,
  paginationWindow,
  parseListingPageParam
} from './listing-pagination'

/** Fewest links from page 1 to each page, following only the bar's own page links. */
function hopsFromFirstPage(pageCount: number): Map<number, number> {
  const hops = new Map([[1, 0]])
  const queue = [1]
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const entry of paginationWindow(current, pageCount)) {
      if (entry === 'gap' || hops.has(entry)) continue
      hops.set(entry, (hops.get(current) ?? 0) + 1)
      queue.push(entry)
    }
  }
  return hops
}

/** Ascending pages, one gap wherever pages are skipped and none elsewhere. */
function expectGapsWhereSkipped(window: Array<number | 'gap'>, label: string): void {
  window.forEach((entry, index) => {
    const next = window[index + 1]
    if (entry === 'gap' || next === undefined) return
    if (next === 'gap') expect(Number(window[index + 2]) - entry, label).toBeGreaterThan(1)
    else expect(next - entry, label).toBe(1)
  })
  expect(window[0], label).not.toBe('gap')
}

/** Every page and page count up to a little past a 100-page list. */
function* everyWindow(): Generator<[page: number, pageCount: number]> {
  for (let pageCount = 1; pageCount <= 130; pageCount += 1) {
    for (let page = 1; page <= pageCount; page += 1) yield [page, pageCount]
  }
}

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

  it('shows the first, last, neighbouring, and ten-away pages', () => {
    expect(PAGINATION_JUMP).toBe(10)
    expect(paginationWindow(1, 1)).toEqual([1])
    expect(paginationWindow(3, 4)).toEqual([1, 2, 3, 4])
    expect(paginationWindow(1, 72)).toEqual([1, 2, 'gap', 11, 'gap', 72])
    expect(paginationWindow(5, 72)).toEqual([1, 'gap', 4, 5, 6, 'gap', 15, 'gap', 72])
    expect(paginationWindow(12, 57)).toEqual([1, 2, 'gap', 11, 12, 13, 'gap', 22, 'gap', 57])
    expect(paginationWindow(20, 57)).toEqual([
      1,
      'gap',
      10,
      'gap',
      19,
      20,
      21,
      'gap',
      30,
      'gap',
      57
    ])
    expect(paginationWindow(47, 57)).toEqual([1, 'gap', 37, 'gap', 46, 47, 48, 'gap', 57])
  })

  it('never repeats a page, and puts a gap exactly where pages are skipped', () => {
    for (const [page, pageCount] of everyWindow()) {
      const window = paginationWindow(page, pageCount)
      const pages = window.filter(entry => entry !== 'gap')
      expect(pages[0], `${page}/${pageCount}`).toBe(1)
      expect(pages.at(-1), `${page}/${pageCount}`).toBe(pageCount)
      for (const expected of [
        page - PAGINATION_JUMP,
        page - 1,
        page,
        page + 1,
        page + PAGINATION_JUMP
      ]) {
        if (expected >= 1 && expected <= pageCount) expect(pages).toContain(expected)
      }
      expectGapsWhereSkipped(window, `${page}/${pageCount}`)
    }
  })

  it('puts every page of 57 and 60 within a few links of page 1', () => {
    // /products/ had 57 pages in #331's crawl. Without jumps the bar chains the pages, and the
    // middle of a 57-page list is 28 links from page 1.
    for (const [pageCount, worst, worstPages] of [
      [57, 6, [16, 25, 34, 43, 52]],
      [60, 7, [26, 27, 35, 36, 44, 45]]
    ] as const) {
      const hops = hopsFromFirstPage(pageCount)
      expect(hops.size, `${pageCount} pages`).toBe(pageCount)
      const most = Math.max(...hops.values())
      expect(most, `${pageCount} pages`).toBe(worst)
      expect(
        [...hops]
          .filter(([, count]) => count === most)
          .map(([page]) => page)
          .sort((a, b) => a - b)
      ).toEqual(worstPages)
    }
  })

  it('keeps the small-screen bar to the neighbours window, one gap per skip', () => {
    expect(
      paginationEntries(20, 57)
        .filter(({ compact }) => compact)
        .map(({ entry }) => entry)
    ).toEqual([1, 'gap', 19, 20, 21, 'gap', 57])
    expect(
      paginationEntries(12, 57)
        .filter(({ compact }) => compact)
        .map(({ entry }) => entry)
    ).toEqual([1, 'gap', 11, 12, 13, 'gap', 57])
    for (const [page, pageCount] of everyWindow()) {
      const entries = paginationEntries(page, pageCount)
      expect(entries.map(({ entry }) => entry)).toEqual(paginationWindow(page, pageCount))
      const compact = entries.filter(item => item.compact).map(({ entry }) => entry)
      const neighbours = [1, page - 1, page, page + 1, pageCount].filter(
        (value, index, all) => value >= 1 && value <= pageCount && all.indexOf(value) === index
      )
      expect(compact.filter(entry => entry !== 'gap')).toEqual(neighbours)
      expectGapsWhereSkipped(compact, `${page}/${pageCount} compact`)
      // At most today's seven entries, which fit one row at 390 px (308 of 358 px, #331).
      expect(compact.length, `${page}/${pageCount}`).toBeLessThanOrEqual(7)
    }
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
    // Each anchor's markup up to its close; class names may hold `>` (`has-[>svg]`).
    const anchors = html.split('<a ').slice(1)
    const anchor = (href: string, rel: string) =>
      anchors.some(tag => tag.includes(`href="${href}"`) && tag.includes(`rel="${rel}"`))
    expect(anchor('/products/categories/other/', 'prev')).toBe(true)
    expect(anchor('/products/categories/other/?page=3', 'next')).toBe(true)
    expect(html).toContain('aria-current="page"')
  })

  it('links the jumps, hidden below sm with their extra gaps', () => {
    const html = renderToStaticMarkup(
      <ListingPagination basePath="/products/" page={20} pageCount={57} />
    )
    // Each item's markup from its `<li` on; the item's own classes are on its opening tag.
    const items = html.split('<li ').slice(1)
    const hidden = (tag: string) => tag.slice(0, tag.indexOf('>')).includes('hidden sm:block')
    const pageItem = (target: number) => {
      const href = target === 1 ? '/products/' : `/products/?page=${target}`
      const tag = items.find(
        candidate =>
          candidate.includes(`aria-label="Page ${target}"`) && candidate.includes(`href="${href}"`)
      )
      if (!tag) throw new Error(`No link to page ${target}`)
      return tag
    }
    for (const target of [10, 30]) expect(hidden(pageItem(target)), `page ${target}`).toBe(true)
    for (const target of [1, 19, 20, 21, 57]) {
      expect(hidden(pageItem(target)), `page ${target}`).toBe(false)
    }
    const gaps = items.filter(tag => tag.includes('data-slot="pagination-ellipsis"'))
    expect(gaps.map(hidden)).toEqual([false, true, false, true])
  })
})
