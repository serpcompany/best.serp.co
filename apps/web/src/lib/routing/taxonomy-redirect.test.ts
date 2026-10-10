import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getTaxonomyRedirect, permanentRedirect } = vi.hoisted(() => ({
  getTaxonomyRedirect: vi.fn(),
  permanentRedirect: vi.fn((location: string) => {
    throw new Error(`308 ${location}`)
  })
}))

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ permanentRedirect }))
vi.mock('@/lib/catalog/repository', () => ({ getTaxonomyRedirect }))

const { movedTaxonomyLocation, redirectMovedTaxonomyPage, searchFromParams } = await import(
  './taxonomy-redirect'
)

beforeEach(() => {
  getTaxonomyRedirect.mockReset()
  permanentRedirect.mockClear()
})

describe('a moved hub, tag or best page (#341, design 2.2)', () => {
  it('rebuilds the query string from the page’s search params', () => {
    expect(searchFromParams({})).toBe('')
    expect(searchFromParams({ page: '2', utm_source: 'news letter' })).toBe(
      '?page=2&utm_source=news+letter'
    )
    expect(searchFromParams({ a: ['1', '2'], b: undefined })).toBe('?a=1&a=2')
  })

  it('points at the target’s canonical page and keeps every parameter but page', () => {
    expect(movedTaxonomyLocation({ kind: 'tag', slug: 'ai-avatar' }, {})).toBe(
      '/products/tags/ai-avatar/'
    )
    expect(
      movedTaxonomyLocation(
        { kind: 'best', slug: 'ai-chatbot' },
        { page: '3', utm_source: 'mail', ref: 'x&y' }
      )
    ).toBe('/best/ai-chatbot/?utm_source=mail&ref=x%26y')
    expect(movedTaxonomyLocation({ kind: 'category', slug: 'writing' }, { page: '2' })).toBe(
      '/products/categories/writing/'
    )
    expect(movedTaxonomyLocation({ kind: 'directory', slug: null }, {})).toBe('/products/')
  })

  it('answers one 308 when the URL moved, and returns for a 404 when it did not', async () => {
    getTaxonomyRedirect.mockResolvedValueOnce({ kind: 'best', slug: 'ai-copywriting' })
    await expect(
      redirectMovedTaxonomyPage('category', 'ai-copywriting-free', { page: '2' })
    ).rejects.toThrow('308 /best/ai-copywriting/')
    expect(getTaxonomyRedirect).toHaveBeenCalledWith('category', 'ai-copywriting-free')

    getTaxonomyRedirect.mockResolvedValueOnce(null)
    await expect(redirectMovedTaxonomyPage('tag', 'nothing-here', {})).resolves.toBeUndefined()
    expect(permanentRedirect).toHaveBeenCalledTimes(1)
  })
})
