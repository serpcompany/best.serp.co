'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { getRoute } from '../lib/routing/routes'
import { useDebounce } from './use-debounce'

/**
 * Hook that manages search query state and navigation to search results
 */
export function useSearch() {
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearchQuery = useDebounce(searchQuery, 300)
  const router = useRouter()

  const handleSearch = useCallback(
    async (searchQuery: string): Promise<void> => {
      if (!searchQuery.trim()) return Promise.resolve()

      return new Promise<void>(resolve => {
        const searchUrl = `${getRoute('search')}?q=${encodeURIComponent(searchQuery)}`
        router.push(searchUrl)

        // Use setTimeout to give the router time to start the navigation
        // This is a workaround since Next.js router doesn't provide a callback
        setTimeout(() => {
          resolve()
        }, 100)
      })
    },
    [router]
  )

  return {
    searchQuery,
    setSearchQuery,
    debouncedSearchQuery,
    handleSearch
  }
}
