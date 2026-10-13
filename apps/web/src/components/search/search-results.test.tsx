import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchResults } from './search-results'
import type { SearchWebsiteMetadata } from './search-utils'

const search = vi.hoisted(() => ({ results: [] as SearchWebsiteMetadata[] }))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('q=fixture') }))
vi.mock('./use-search', () => ({
  useSearch: () => ({ error: null, loading: false, results: search.results })
}))
// The filter menu renders its options only once it opens; render them closed, in place.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => children
  return {
    DropdownMenu: passThrough,
    DropdownMenuContent: passThrough,
    DropdownMenuTrigger: passThrough
  }
})

function result(
  slug: string,
  categories: string[],
  categoryNames?: Record<string, string>
): SearchWebsiteMetadata {
  return {
    categories,
    category: categories[0] ?? '',
    ...(categoryNames ? { categoryNames } : {}),
    description: `${slug} description.`,
    name: slug,
    publishedAt: '2026-07-04T00:00:00.000Z',
    slug,
    tags: [],
    url: `/products/${slug}/`,
    website: `https://${slug}.test/`
  }
}

afterEach(() => {
  search.results = []
})

describe('the search page names categories from D1 (#416)', () => {
  it("in its filter and its 'Results by category' buttons, and a slug D1 doesn't name from itself", () => {
    // More than three results, so the buttons show. One `audio` result came without names (a
    // cached older response); the others' names cover it.
    search.results = [
      result('fixture-one', ['audio'], { audio: 'Audio & Music' }),
      result('fixture-two', ['audio'], { audio: 'Audio & Music' }),
      result('fixture-three', ['audio']),
      result('fixture-four', ['retired-hub'], {})
    ]
    const markup = renderToStaticMarkup(<SearchResults />)
    const [toolbar = '', notice = ''] = markup.split('Results by category:')

    // The filter's options: the name, then the count.
    expect(toolbar).toMatch(/>Audio &amp; Music<\/span><span[^>]*>\(3\)<\/span>/u)
    expect(toolbar).toMatch(/>Retired Hub<\/span><span[^>]*>\(1\)<\/span>/u)
    // The buttons.
    expect(notice).toMatch(/<button[^>]*>Audio &amp; Music \(3\)<\/button>/u)
    expect(notice).toMatch(/<button[^>]*>Retired Hub \(1\)<\/button>/u)
    expect(markup).not.toMatch(/>Audio(?:<| \()/u)
  })
})
