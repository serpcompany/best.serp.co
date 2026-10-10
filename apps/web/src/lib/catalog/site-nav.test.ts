import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedBestPage } from '@/db/contracts'

vi.mock('server-only', () => ({}))
const getBestPages = vi.fn<() => Promise<PublishedBestPage[]>>()
vi.mock('./repository', () => ({ getBestPages: () => getBestPages() }))

const { linksBestIndex } = await import('./site-nav')

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
