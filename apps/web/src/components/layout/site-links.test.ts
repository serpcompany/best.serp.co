import { describe, expect, it } from 'vitest'
import { htmlSitemapPaths, sitemapRoutePaths } from '@/lib/site'
import {
  footerGroups,
  headerItems,
  isCurrentPage,
  isMenuActive,
  sitemapPageLinks
} from './site-links'

function productsMenu(bestIndexListed: boolean) {
  const menu = headerItems({ bestIndexListed }).find(item => item.kind === 'menu')
  if (menu?.kind !== 'menu') throw new Error('the header has a Products menu')
  return menu
}
const products = productsMenu(true)

describe('header link states (#259)', () => {
  it('marks only the exact page as current, with or without a trailing slash', () => {
    expect(isCurrentPage('/products/categories/', '/products/categories/')).toBe(true)
    expect(isCurrentPage('/products/categories', '/products/categories/')).toBe(true)
    expect(isCurrentPage('/products/categories/ai-agents/', '/products/categories/')).toBe(false)
    expect(isCurrentPage('/products/categories/', '/')).toBe(false)
  })

  it('marks the Products menu on its section, never on the homepage or other pages', () => {
    for (const path of [
      '/products/',
      '/products/vimeo-downloader/',
      '/products/categories/',
      '/products/categories/ai-agents/',
      '/best/',
      '/best/ai-photo-editor/',
      '/brands/'
    ]) {
      expect(isMenuActive(path, products), path).toBe(true)
    }
    for (const path of ['/', '/pricing/', '/about/', '/submit/']) {
      expect(isMenuActive(path, products), path).toBe(false)
    }
  })
})

describe('the Products menu (#347)', () => {
  it('links the best-page index beside Categories while the index lists a best page', () => {
    expect(products.links.map(link => [link.label, link.href]).slice(0, 3)).toEqual([
      ['All products', '/'],
      ['Categories', '/products/categories/'],
      ['Best', '/best/']
    ])
  })

  it('leaves Best out while the index lists none, so it never links a heading alone', () => {
    expect(productsMenu(false).links.map(link => link.label)).not.toContain('Best')
  })
})

describe('the HTML sitemap’s links (#53)', () => {
  it('puts a plain "Sitemap" link to /sitemap/ in the footer', () => {
    const links = footerGroups().flatMap(group => group.links)
    expect(links).toContainEqual({ href: '/sitemap/', label: 'Sitemap' })
  })

  it('lists exactly the pages sitemap’s static pages but its own, named as the nav names them', () => {
    const own = new Set<string>([htmlSitemapPaths.index, htmlSitemapPaths.listings])
    const listed = sitemapRoutePaths('pages').filter(path => !own.has(path))
    const links = sitemapPageLinks({ bestIndexListed: true })
    expect(links.map(link => link.href).sort()).toEqual([...listed].sort())
    expect(links[0]).toEqual({ href: '/', label: 'All products' })
    expect(links.every(link => link.label.length > 0)).toBe(true)
  })

  it('leaves the best index out while it lists nothing, as the pages sitemap does', () => {
    const hrefs = sitemapPageLinks({ bestIndexListed: false }).map(link => link.href)
    expect(hrefs).not.toContain(htmlSitemapPaths.index)
    expect(hrefs).not.toContain('/best/')
  })
})
