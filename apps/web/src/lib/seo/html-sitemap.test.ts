import { describe, expect, it } from 'vitest'
import {
  HTML_SITEMAP_PAGE_SIZE,
  htmlSitemapListingsPath,
  htmlSitemapPage,
  htmlSitemapPageCount,
  parseHtmlSitemapPageSegment
} from './html-sitemap'

const items = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

describe('the HTML sitemap’s numbered pages (#53)', () => {
  it('holds 200 links a page, and an empty list still has page 1', () => {
    expect(HTML_SITEMAP_PAGE_SIZE).toBe(200)
    expect(htmlSitemapPageCount(0)).toBe(1)
    expect(htmlSitemapPageCount(1)).toBe(1)
    expect(htmlSitemapPageCount(200)).toBe(1)
    expect(htmlSitemapPageCount(201)).toBe(2)
    expect(htmlSitemapPageCount(3422)).toBe(18)
  })

  it('slices each page in order, the last one partly full', () => {
    const list = items(401)
    expect(htmlSitemapPage(list, 1)).toEqual({
      items: items(200),
      page: 1,
      pageCount: 3,
      total: 401
    })
    expect(htmlSitemapPage(list, 2)?.items).toEqual(items(400).slice(200))
    expect(htmlSitemapPage(list, 3)?.items).toEqual([401])
  })

  it('has no page past the last, below 1, or between whole numbers', () => {
    expect(htmlSitemapPage(items(401), 4)).toBeNull()
    expect(htmlSitemapPage(items(200), 2)).toBeNull()
    expect(htmlSitemapPage(items(5), 0)).toBeNull()
    expect(htmlSitemapPage(items(5), 1.5)).toBeNull()
    expect(htmlSitemapPage([], 1)).toEqual({ items: [], page: 1, pageCount: 1, total: 0 })
  })

  it('reads a page segment from 2, without leading zeros; 1 is the bare URL', () => {
    expect(parseHtmlSitemapPageSegment('2')).toBe(2)
    expect(parseHtmlSitemapPageSegment('18')).toBe(18)
    for (const segment of ['1', '0', '01', '-2', '2.0', 'two', '', '1234567']) {
      expect(parseHtmlSitemapPageSegment(segment), segment).toBeNull()
    }
  })

  it('writes page 1 as the bare listings URL and later pages by number', () => {
    expect(htmlSitemapListingsPath(1)).toBe('/sitemap/listings/')
    expect(htmlSitemapListingsPath(2)).toBe('/sitemap/listings/2/')
  })
})
