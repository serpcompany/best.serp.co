import { describe, expect, it } from 'vitest'
import { headerItems, isCurrentPage, isMenuActive } from './site-links'

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
