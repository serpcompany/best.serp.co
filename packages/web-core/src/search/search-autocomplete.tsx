'use client'

import {
  DirectoryCommand,
  type DirectoryCommandItem
} from '@serpdirectory/design-system/shadcnblocks/directory-command'
import { logger } from '@serpdirectory/logging'
import { resolveCategories } from '@serpdirectory/web-core/categories'
import { getCategoryDisplayName } from '@serpdirectory/web-core/category-display'
import { getRoute } from '@serpdirectory/web-core/routes'
import { SEARCH_API_PATH, searchResponseSchema } from '@serpdirectory/web-core/search-contract'
import { ArrowRight, Clock, Search, TrendingUp } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAnalyticsEvents } from '../root-shell-client'
import { Favicon } from './favicon'

interface SearchSuggestion {
  type: 'website' | 'category' | 'recent' | 'trending'
  title: string
  description?: string
  url?: string
  category?: string
  website?: string
  icon?: React.ComponentType<{ className?: string }>
}

interface SearchAutocompleteProps {
  availableCategorySlugs: string[]
  searchQuery: string
  onSelect?: (suggestion: SearchSuggestion) => void
  isOpen: boolean
  onClose: () => void
  anchorRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * Renders a search autocomplete dropdown with suggestions, recent searches, and categories
 */
export function SearchAutocomplete({
  availableCategorySlugs,
  searchQuery,
  onSelect,
  isOpen,
  onClose,
  anchorRef
}: SearchAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { trackSearch, trackSearchAutocomplete } = useAnalyticsEvents()
  const availableCategoryKey = availableCategorySlugs.join('\0')
  const availableCategories = useMemo(() => {
    return resolveCategories(availableCategoryKey.split('\0').filter(Boolean))
  }, [availableCategoryKey])

  const getRecentSearches = useCallback((): string[] => {
    if (typeof window === 'undefined') return []
    const recent = localStorage.getItem('recentSearches')
    return recent ? JSON.parse(recent).slice(0, 3) : []
  }, [])

  const saveRecentSearch = useCallback(
    (query: string) => {
      if (typeof window === 'undefined') return
      const recent = getRecentSearches()
      const updated = [query, ...recent.filter(s => s !== query)].slice(0, 5)
      localStorage.setItem('recentSearches', JSON.stringify(updated))
    },
    [getRecentSearches]
  )

  useEffect(() => {
    let cancelled = false

    /** Fetches and filters search suggestions based on the current query */
    const fetchSuggestions = async () => {
      if (!searchQuery.trim()) {
        const recentSearches = getRecentSearches().map(search => ({
          type: 'recent' as const,
          title: search,
          icon: Clock
        }))
        const categoryMatches = availableCategories.slice(0, 3).map(cat => ({
          type: 'category' as const,
          title: `Browse ${getCategoryDisplayName(cat.slug)}`,
          description: `View all ${getCategoryDisplayName(cat.slug).toLowerCase()} listings`,
          icon: cat.icon,
          url: getRoute('category.page', { category: cat.slug })
        }))

        if (!cancelled) {
          setSuggestions([...recentSearches, ...categoryMatches])
          setSelectedIndex(-1)
          setLoading(false)
        }
        return
      }
      if (!cancelled) setLoading(true)
      try {
        const response = await fetch(
          `${SEARCH_API_PATH}?q=${encodeURIComponent(searchQuery)}&limit=5`
        )
        if (!response.ok) throw new Error('Failed to fetch search index')

        const searchResults = searchResponseSchema.parse(await response.json())
        const query = searchQuery.toLowerCase()
        const websiteMatches = searchResults
          .filter(item => {
            const searchableText = `${item.name} ${item.description} ${
              item.category
            } ${(item.categories || []).join(' ')}`.toLowerCase()
            return searchableText.includes(query)
          })
          .slice(0, 5)
          .map(item => ({
            type: 'website' as const,
            title: item.name,
            description: item.description,
            url: item.url,
            category: item.category,
            website: item.website
          }))
        const categoryMatches = availableCategories
          .filter(
            cat =>
              getCategoryDisplayName(cat.slug).toLowerCase().includes(query) ||
              cat.slug.includes(query)
          )
          .slice(0, 2)
          .map(cat => ({
            type: 'category' as const,
            title: `Browse ${getCategoryDisplayName(cat.slug)}`,
            description: `View all ${getCategoryDisplayName(cat.slug).toLowerCase()} listings`,
            icon: cat.icon,
            url: getRoute('category.page', { category: cat.slug })
          }))

        if (!cancelled) {
          setSuggestions([...websiteMatches, ...categoryMatches])
          setSelectedIndex(-1)
        }
      } catch (error) {
        logger.error('Error fetching suggestions:', {
          data: error,
          tags: { type: 'component' }
        })
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    const debounceTimer = setTimeout(fetchSuggestions, 150)
    return () => {
      cancelled = true
      clearTimeout(debounceTimer)
    }
  }, [availableCategories, searchQuery, getRecentSearches])

  useEffect(() => {
    if (!isOpen) return
    /** Handles keyboard navigation within the autocomplete dropdown */
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1))
          break
        case 'Enter':
          e.preventDefault()
          if (selectedIndex >= 0 && suggestions[selectedIndex]) {
            handleSuggestionClick(suggestions[selectedIndex])
          } else if (searchQuery.trim()) {
            trackSearch(searchQuery, 0, 'autocomplete-keyboard-enter')
            saveRecentSearch(searchQuery)
            router.push(`${getRoute('search')}?q=${encodeURIComponent(searchQuery)}`)
            onClose()
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, suggestions, searchQuery, router, onClose, saveRecentSearch])

  useEffect(() => {
    if (!isOpen) return
    /** Closes the dropdown when clicking outside */
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return

      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        anchorRef?.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose, anchorRef])

  /** Navigates to the selected suggestion and tracks the interaction */
  const handleSuggestionClick = (suggestion: SearchSuggestion) => {
    trackSearchAutocomplete(searchQuery, suggestion.title, `autocomplete-${suggestion.type}`)
    if (suggestion.type === 'recent') {
      saveRecentSearch(suggestion.title)
      trackSearch(suggestion.title, 0, 'autocomplete-recent')
      router.push(`${getRoute('search')}?q=${encodeURIComponent(suggestion.title)}`)
    } else if (suggestion.url) {
      router.push(suggestion.url)
    }

    onSelect?.(suggestion)
    onClose()
  }

  if (!isOpen || (!suggestions.length && !loading && searchQuery)) return null

  const commandItems: DirectoryCommandItem[] = suggestions.map((suggestion, index) => {
    const Icon = suggestion.icon || Search
    return {
      id: `${suggestion.type}-${suggestion.title}-${index}`,
      value: `${suggestion.type}-${suggestion.title}`,
      title: suggestion.title,
      description: suggestion.description,
      meta: suggestion.category
        ? `Category: ${getCategoryDisplayName(suggestion.category)}`
        : undefined,
      icon:
        suggestion.type === 'website' && suggestion.website ? (
          <Favicon
            website={suggestion.website}
            fallbackIcon={Icon}
            title={suggestion.title}
            className="h-4 w-4"
          />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        ),
      trailing: (
        <>
          {suggestion.type === 'recent' && (
            <div className="rounded bg-muted/30 px-1.5 py-0.5 text-xs text-muted-foreground">
              Recent
            </div>
          )}
          {suggestion.type === 'trending' && (
            <TrendingUp className="h-3 w-3 text-muted-foreground" />
          )}
          {suggestion.type === 'category' && (
            <div className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
              Category
            </div>
          )}
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </>
      )
    }
  })

  return (
    <div ref={dropdownRef} className="absolute top-full z-[100] mt-2 w-full">
      <DirectoryCommand
        items={commandItems}
        selectedIndex={selectedIndex}
        loading={loading}
        emptyLabel={searchQuery ? 'No suggestions found' : 'Start typing to search'}
        onHoverItem={setSelectedIndex}
        onSelectItem={(_, index) => {
          const suggestion = suggestions[index]
          if (suggestion) handleSuggestionClick(suggestion)
        }}
        footer={
          searchQuery ? (
            <div className="border-t px-4 py-2">
              <button
                type="button"
                onClick={() => {
                  trackSearch(searchQuery, 0, 'autocomplete-search-button')
                  saveRecentSearch(searchQuery)
                  router.push(`${getRoute('search')}?q=${encodeURIComponent(searchQuery)}`)
                  onClose()
                }}
                className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Search className="h-3 w-3" />
                Search for "{searchQuery}"
              </button>
            </div>
          ) : null
        }
      />
    </div>
  )
}
