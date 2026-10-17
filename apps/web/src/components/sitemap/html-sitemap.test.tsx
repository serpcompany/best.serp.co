import { describe, expect, it } from 'vitest'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'
import { htmlSitemapListingsMetadata, htmlSitemapSections } from './html-sitemap'

const category = (slug: string, name: string, count: number): PublishedCategory => ({
  count,
  description: '',
  name,
  order: 0,
  slug
})
const bestPage = (slug: string, heading: string, poolSize: number, hub = 'writing') =>
  ({ heading, hub, listSize: 10, poolSize, slug }) as PublishedBestPage

describe('the HTML sitemap’s sections (#53)', () => {
  const sections = htmlSitemapSections({
    bestPages: [
      bestPage('writing-app', 'Best Writing Apps', 8),
      // Renders with 4 entries, noindex: not listed.
      bestPage('notes-app', 'Best Notes Apps', 4),
      bestPage('editor-app', 'Best Editor Apps', 5),
      bestPage('design-app', 'Best Design Apps', 5, 'design')
    ],
    categories: [
      category('writing', 'Writing Tools', 49),
      category('audio', 'Audio Tools', 0),
      category('design', 'Design Tools', 2)
    ],
    listingTotal: 401,
    pages: [{ href: '/about/', label: 'About' }]
  })
  const byTitle = Object.fromEntries(sections.map(section => [section.title, section]))

  it('lists only indexable pages, under plain headings', () => {
    expect(sections.map(section => section.title)).toEqual([
      'Pages',
      'Categories',
      'Best of',
      'Listings'
    ])
    expect(byTitle.Categories).toMatchObject({
      links: [
        { href: '/products/categories/design/', label: 'Design Tools' },
        { href: '/products/categories/writing/', label: 'Writing Tools' }
      ]
    })
  })

  it('groups the best pages under their hubs, the hubs by name and the pages by heading', () => {
    expect(byTitle['Best of']).toMatchObject({
      groups: [
        {
          links: [{ href: '/best/design-app/', label: 'Best Design Apps' }],
          title: 'Design Tools'
        },
        {
          links: [
            { href: '/best/editor-app/', label: 'Best Editor Apps' },
            { href: '/best/writing-app/', label: 'Best Writing Apps' }
          ],
          title: 'Writing Tools'
        }
      ]
    })
  })

  it('links each numbered listings page by its range, page 1 as the bare URL', () => {
    expect(byTitle.Listings).toMatchObject({
      links: [
        { href: '/sitemap/listings/', label: '1–200' },
        { href: '/sitemap/listings/2/', label: '201–400' },
        { href: '/sitemap/listings/3/', label: '401' }
      ]
    })
  })

  it('leaves out a section with no link', () => {
    const empty = htmlSitemapSections({
      bestPages: [],
      categories: [],
      listingTotal: 3,
      pages: []
    })
    expect(empty.map(section => section.title)).toEqual(['Listings'])
  })

  it('gives each numbered page its own title and canonical, indexable', () => {
    const second = htmlSitemapListingsMetadata(2)
    expect(second.title).toBe('Sitemap: Listings - Page 2')
    expect(String(second.alternates?.canonical)).toBe('https://best.serp.co/sitemap/listings/2/')
    expect((second.robots as { index?: boolean }).index).not.toBe(false)
  })
})
