import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCategoryRouteMetadata } from './category-page'

// The year in titles and descriptions is the request's (#521).
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00.000Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})

describe('category and tag page metadata (#521)', () => {
  it('titles a category {N}+ Best {Category} Tools in {Year} from its live count', async () => {
    const metadata = await generateCategoryRouteMetadata({
      category: { description: 'Make and edit music.', name: 'Audio & Music', slug: 'audio' },
      count: 123
    })
    expect(metadata.title).toBe('123+ Best Audio & Music Tools in 2026')
    expect(metadata.openGraph?.title).toBe('123+ Best Audio & Music Tools in 2026')
    expect(metadata.twitter?.title).toBe('123+ Best Audio & Music Tools in 2026')
    expect(String(metadata.description)).toMatch(/^123\+ best Audio & Music Tools in 2026\. /u)
  })

  it('titles a tag {N}+ Best {Tag} in {Year}', async () => {
    const metadata = await generateCategoryRouteMetadata({
      category: { description: 'Write lyrics.', name: 'AI Lyrics Generators', slug: 'ai-lyrics' },
      count: 6,
      kind: 'tag'
    })
    expect(metadata.title).toBe('6+ Best AI Lyrics Generators in 2026')
    expect(String(metadata.description)).toMatch(/^6\+ best AI Lyrics Generators in 2026\. /u)
  })

  it('steps a long category name down, keeping the full words in the description', async () => {
    const name = 'Customer Relationship Management'
    const metadata = await generateCategoryRouteMetadata({
      category: { description: 'Track customers.', name, slug: 'crm' },
      count: 1234
    })
    expect(metadata.title).toBe(`Best ${name} Tools`)
    expect(String(metadata.description)).toMatch(new RegExp(`^1234\\+ best ${name} Tools in 2026`))
  })
})
