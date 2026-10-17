import { describe, expect, it } from 'vitest'
import {
  BEST_PAGE_INDEX_MIN_ENTRIES,
  TAG_INDEX_MIN_LISTINGS,
  TAG_LINK_MIN_LISTINGS
} from '@/lib/site'
import {
  bestPageEntryCount,
  categoryBestPages,
  isBestPageIndexable,
  isTagIndexable,
  isTagLinked,
  linkedCategories,
  renderingCategory
} from './taxonomy-indexing'

const tagOnly = (tag: string, poolSize: number, listSize = 10) => ({
  category: null,
  listSize,
  poolSize,
  tag
})

describe('taxonomy robots predicates (#341, design 2.3)', () => {
  it('keeps the thresholds of section 7, question 7', () => {
    expect([TAG_INDEX_MIN_LISTINGS, BEST_PAGE_INDEX_MIN_ENTRIES, TAG_LINK_MIN_LISTINGS]).toEqual([
      10, 5, 3
    ])
  })

  it('counts a best page’s entries as its pool, up to its list size', () => {
    expect(bestPageEntryCount({ listSize: 10, poolSize: 170 })).toBe(10)
    expect(bestPageEntryCount({ listSize: 10, poolSize: 3 })).toBe(3)
    expect(bestPageEntryCount({ listSize: 10, poolSize: 0 })).toBe(0)
  })

  it('indexes a best page from 5 entries; 1 to 4 render noindex', () => {
    expect(isBestPageIndexable({ listSize: 10, poolSize: 5 })).toBe(true)
    expect(isBestPageIndexable({ listSize: 5, poolSize: 50 })).toBe(true)
    expect(isBestPageIndexable({ listSize: 10, poolSize: 4 })).toBe(false)
    expect(isBestPageIndexable({ listSize: 10, poolSize: 0 })).toBe(false)
  })

  it('indexes a tag from 10 listings unless an indexable best page ranks it alone', () => {
    const tag = { count: 10, slug: 'ai-chatbots' }
    expect(isTagIndexable(tag, [])).toBe(true)
    expect(isTagIndexable({ ...tag, count: 9 }, [])).toBe(false)
    // A tag-only best page takes the tag's keyword.
    expect(isTagIndexable(tag, [tagOnly('ai-chatbots', 10)])).toBe(false)
    // One that ranks the tag within a category does not.
    expect(isTagIndexable(tag, [{ ...tagOnly('ai-chatbots', 10), category: 'marketing' }])).toBe(
      true
    )
    // Neither does one too small to be indexed, nor one on another tag.
    expect(isTagIndexable(tag, [tagOnly('ai-chatbots', 4)])).toBe(true)
    expect(isTagIndexable(tag, [tagOnly('ai-seo', 10)])).toBe(true)
  })

  it('links a tag from the index at 3 listings', () => {
    expect(isTagLinked({ count: 3 })).toBe(true)
    expect(isTagLinked({ count: 2 })).toBe(false)
  })
})

describe('whether a category page renders (#347 review)', () => {
  const categories = [
    { count: 12, name: 'Writing', slug: 'writing' },
    { count: 0, name: 'Audio', slug: 'audio' }
  ]

  it('returns a category with a public listing', () => {
    expect(renderingCategory(categories, 'writing')).toEqual(categories[0])
  })

  it('returns null for a category with no public listing, an unknown one, or none', () => {
    expect(renderingCategory(categories, 'audio')).toBeNull()
    expect(renderingCategory(categories, 'retired')).toBeNull()
    expect(renderingCategory(categories, null)).toBeNull()
  })
})

describe('what the 404 page, the 410 page and the HTML sitemap link (#53)', () => {
  it('links the categories whose pages render, by name', () => {
    const linked = linkedCategories([
      { count: 3, name: 'Writing Tools', slug: 'writing' },
      { count: 0, name: 'Audio Tools', slug: 'audio' },
      { count: 1, name: 'Design Tools', slug: 'design' }
    ])
    expect(linked.map(category => category.slug)).toEqual(['design', 'writing'])
  })

  it('links every best page of a hub that has an entry, in the index’s order', () => {
    const page = (slug: string, hub: string, poolSize = 3) => ({
      hub,
      listSize: 10,
      poolSize,
      slug
    })
    const pages = [
      page('writing-tag', 'writing'),
      page('empty-writing', 'writing', 0),
      page('writing-app', 'writing'),
      page('design-app', 'design')
    ]
    expect(categoryBestPages(pages, 'writing').map(bestPage => bestPage.slug)).toEqual([
      'writing-tag',
      'writing-app'
    ])
    expect(categoryBestPages(pages, 'audio')).toEqual([])
  })
})
