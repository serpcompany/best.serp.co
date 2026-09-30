'use client'

import { useMemo } from 'react'
import { useFavorites } from '../root-shell-client'

export function useFavoritesFilter<TWebsite extends { slug: string }>(
  websites: readonly TWebsite[]
) {
  const { favorites } = useFavorites()

  const favoriteWebsites = useMemo(() => {
    return websites.filter(website => favorites.includes(website.slug))
  }, [websites, favorites])

  return {
    favoriteWebsites,
    hasFavorites: favorites.length > 0,
    favoritesCount: favorites.length
  }
}
