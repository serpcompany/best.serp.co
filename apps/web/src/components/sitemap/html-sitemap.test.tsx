import { describe, expect, it } from 'vitest'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { htmlSitemapGroups, htmlSitemapListingsMetadata } from './html-sitemap'

const category = (slug: string, name: string, count: number): PublishedCategory => ({
  count,
  description: '',
  name,
  order: 0,
  slug
})
const bestPage = (slug: string, heading: string, poolSize: number) =>
  ({ heading, listSize: 10, poolSize, slug }) as PublishedBestPage

describe('the HTML sitemap’s groups (#53)', () => {
  const groups = htmlSitemapGroups({
    bestPages: [
      bestPage('writing-app', 'Best Writing Apps', 8),
      // Renders with 4 entries, noindex: not listed.
      bestPage('notes-app', 'Best Notes Apps', 4),
      bestPage('design-app', 'Best Design Apps', 5)
    ],
    categories: [category('writing', 'Writing Tools', 49), category('audio', 'Audio Tools', 0)],
    listingPageCount: 3,
    pages: [{ href: '/about/', label: 'About' }]
  })
  const byTitle = Object.fromEntries(groups.map(group => [group.title, group.links]))

  it('lists only indexable pages, under plain headings', () => {
    expect(groups.map(group => group.title)).toEqual(['Pages', 'Categories', 'Best', 'Products'])
    expect(byTitle.Categories).toEqual([
      { href: '/products/categories/writing/', label: 'Writing Tools' }
    ])
    expect(byTitle.Best).toEqual([
      { href: '/best/design-app/', label: 'Best Design Apps' },
      { href: '/best/writing-app/', label: 'Best Writing Apps' }
    ])
  })

  it('links each numbered listings page, page 1 as the bare URL', () => {
    expect(byTitle.Products?.map(link => link.href)).toEqual([
      '/sitemap/listings/',
      '/sitemap/listings/2/',
      '/sitemap/listings/3/'
    ])
  })

  it('leaves out a group with no link', () => {
    const empty = htmlSitemapGroups({
      bestPages: [],
      categories: [],
      listingPageCount: 1,
      pages: []
    })
    expect(empty.map(group => group.title)).toEqual(['Products'])
  })

  it('gives each numbered page its own title and canonical, indexable', () => {
    const second = htmlSitemapListingsMetadata(2)
    expect(second.title).toBe('Sitemap: Products - Page 2')
    expect(String(second.alternates?.canonical)).toBe('https://best.serp.co/sitemap/listings/2/')
    expect((second.robots as { index?: boolean }).index).not.toBe(false)
  })
})
