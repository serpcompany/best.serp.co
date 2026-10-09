'use client'

import { useSearchParams } from 'next/navigation'
import { SearchField } from '@/components/layout/search-field'
import { getRoute } from '../../lib/routing/routes'

/**
 * The search page's own field (#259): a GET form to `/search/` in a `<search>` landmark, holding
 * the current query, now that the header has no search.
 */
export function SearchPageForm() {
  const query = useSearchParams().get('q') ?? ''
  return (
    <search className="w-full max-w-xl">
      <form action={getRoute('search')} method="get">
        <SearchField
          key={query}
          name="q"
          defaultValue={query}
          autoComplete="off"
          aria-label="Search"
          placeholder="Search the directory..."
        />
      </form>
    </search>
  )
}
