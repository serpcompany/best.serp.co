import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchResponseSchema } from '@/lib/directory/search-contract'

const { getAutocompleteWithCategories } = vi.hoisted(() => ({
  getAutocompleteWithCategories: vi.fn()
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/catalog/repository', () => ({
  getAutocompleteWithCategories,
  MAX_SEARCH_LIMIT: 100
}))

const { GET } = await import('./route')

beforeEach(() => {
  getAutocompleteWithCategories.mockReset()
})

describe('the search API names categories from D1 (#416)', () => {
  it("sends D1's name for each category slug of a result that D1 knows", async () => {
    getAutocompleteWithCategories.mockResolvedValue({
      categories: [
        { count: 3, description: '', name: 'Audio & Music', order: 0, slug: 'audio' },
        { count: 9, description: '', name: 'Image & Design', order: 1, slug: 'image-design' }
      ],
      listings: [
        {
          categories: ['audio', 'retired-hub'],
          category: 'audio',
          description: 'Makes music.',
          name: 'Fixture Tunes',
          publishedAt: '2026-07-04T00:00:00.000Z',
          slug: 'fixture-tunes.test',
          website: 'https://fixture-tunes.test/'
        }
      ]
    })
    const response = await GET(new Request('https://best.serp.co/api/search?q=tunes'))
    const [result] = searchResponseSchema.parse(await response.json())
    expect(result?.categoryNames).toEqual({ audio: 'Audio & Music' })
    expect(result?.categories).toEqual(['audio', 'retired-hub'])
    // One read, so D1 access is set up once per request (#421 review).
    expect(getAutocompleteWithCategories).toHaveBeenCalledExactlyOnceWith('tunes', 20)
  })

  it('reads nothing for an empty query', async () => {
    const response = await GET(new Request('https://best.serp.co/api/search?q=%20'))
    expect(await response.json()).toEqual([])
    expect(getAutocompleteWithCategories).not.toHaveBeenCalled()
  })
})
