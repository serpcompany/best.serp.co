import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedBestPage, PublishedCategory } from '@/db/contracts'

vi.mock('server-only', () => ({}))
const getBestPages = vi.fn<() => Promise<PublishedBestPage[]>>()
const getActiveCategories = vi.fn<() => Promise<PublishedCategory[]>>()
vi.mock('./repository', () => ({
  getActiveCategories: () => getActiveCategories(),
  getBestPages: () => getBestPages()
}))

const { linksBestIndex, notFoundLinkTargets } = await import('./site-nav')

const page = (poolSize: number): PublishedBestPage => ({
  category: null,
  heading: 'Best Note Taking Apps',
  hub: 'writing',
  intro: '',
  keyword: 'note taking app',
  lastModifiedAt: '2026-10-01T00:00:00.000Z',
  listSize: 10,
  order: 0,
  poolSize,
  slug: 'note-taking-app',
  tag: 'note-taking',
  title: 'Best Note Taking Apps'
})

describe('whether the header links the best-page index (#347)', () => {
  beforeEach(() => {
    getBestPages.mockReset()
  })

  it('links it once the index lists a best page with an entry', async () => {
    getBestPages.mockResolvedValue([page(0), page(3)])
    expect(await linksBestIndex()).toBe(true)
  })

  it('leaves it out while the index lists none: before the taxonomy is published', async () => {
    getBestPages.mockResolvedValue([])
    expect(await linksBestIndex()).toBe(false)
    getBestPages.mockResolvedValue([page(0)])
    expect(await linksBestIndex()).toBe(false)
  })

  it('leaves it out, instead of failing the page, when the read fails', async () => {
    getBestPages.mockRejectedValue(new Error('D1 unavailable'))
    expect(await linksBestIndex()).toBe(false)
  })
})

const category = (slug: string, name: string, count: number): PublishedCategory => ({
  count,
  description: '',
  name,
  order: 0,
  slug
})

describe('what the 404 page links (#53)', () => {
  beforeEach(() => {
    getBestPages.mockReset()
    getActiveCategories.mockReset()
  })

  it('reads the categories with a public listing, by name, and the best pages that render', async () => {
    getActiveCategories.mockResolvedValue([
      category('writing', 'Writing Tools', 49),
      category('audio', 'Audio Tools', 0),
      category('design', 'Design Tools', 3)
    ])
    getBestPages.mockResolvedValue([page(0), page(3)])
    const targets = await notFoundLinkTargets()
    expect(targets.categories.map(item => item.slug)).toEqual(['design', 'writing'])
    expect(targets.bestPages).toEqual([page(3)])
  })

  it('leaves out what a failed read would have linked, instead of failing the 404', async () => {
    getActiveCategories.mockRejectedValue(new Error('D1 unavailable'))
    getBestPages.mockRejectedValue(new Error('D1 unavailable'))
    expect(await notFoundLinkTargets()).toEqual({ bestPages: [], categories: [] })
  })
})
