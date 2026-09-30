'use client'

import { ArrowUp } from 'lucide-react'
import Script from 'next/script'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'

interface GoogleTagManagerProps {
  gtmId?: string
}

export function GoogleTagManagerScript({ gtmId }: GoogleTagManagerProps) {
  if (!gtmId) {
    return null
  }

  return (
    <Script
      id="google-tag-manager"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `
          (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer','${gtmId}');
        `
      }}
    />
  )
}

export function GoogleTagManagerNoScript({ gtmId }: GoogleTagManagerProps) {
  if (!gtmId) {
    return null
  }

  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${gtmId}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
        title="Google Tag Manager"
      />
    </noscript>
  )
}

export function AnalyticsTracker() {
  return null
}

export function useAnalyticsEvents() {
  const noop = (..._args: unknown[]) => {}

  return {
    trackAccountDeleteCancel: noop,
    trackAccountDeleteStart: noop,
    trackAccountDeleteSuccess: noop,
    trackFetchMetadataError: noop,
    trackFetchMetadataSuccess: noop,
    trackFormError: noop,
    trackFormStepComplete: noop,
    trackFormStepStart: noop,
    trackLoadMore: noop,
    trackProfileModalOpen: noop,
    trackProfileUpdateError: noop,
    trackProfileUpdateSuccess: noop,
    trackProfileVisibilityToggle: noop,
    trackSearch: noop,
    trackSearchAutocomplete: noop,
    trackShowAll: noop,
    trackShowLess: noop,
    trackSortChange: noop,
    trackSubmitError: noop,
    trackSubmitSuccess: noop
  }
}

export interface FavoritesContextValue {
  favorites: string[]
  isFavorite: (slug: string) => boolean
  addFavorite: (slug: string) => void
  removeFavorite: (slug: string) => void
  toggleFavorite: (slug: string) => void
  isLoading: boolean
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null)
const STORAGE_KEY = 'llms-txt-hub-favorites'

interface FavoritesProviderProps {
  children: ReactNode
}

export function FavoritesProvider({ children }: FavoritesProviderProps) {
  const [favorites, setFavorites] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) {
          setFavorites(parsed)
        }
      }
    } catch {
    } finally {
      setIsLoading(false)
    }
  }, [])

  const saveFavoritesToStorage = useCallback((newFavorites: string[]) => {
    if (typeof window === 'undefined') return

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newFavorites))
    } catch {
    }
  }, [])

  const isFavorite = useCallback(
    (slug: string): boolean => {
      return favorites.includes(slug)
    },
    [favorites]
  )

  const addFavorite = useCallback(
    (slug: string) => {
      if (!favorites.includes(slug)) {
        const newFavorites = [...favorites, slug]
        setFavorites(newFavorites)
        saveFavoritesToStorage(newFavorites)
      }
    },
    [favorites, saveFavoritesToStorage]
  )

  const removeFavorite = useCallback(
    (slug: string) => {
      if (favorites.includes(slug)) {
        const newFavorites = favorites.filter((fav) => fav !== slug)
        setFavorites(newFavorites)
        saveFavoritesToStorage(newFavorites)
      }
    },
    [favorites, saveFavoritesToStorage]
  )

  const toggleFavorite = useCallback(
    (slug: string) => {
      if (favorites.includes(slug)) {
        removeFavorite(slug)
      } else {
        addFavorite(slug)
      }
    },
    [favorites, addFavorite, removeFavorite]
  )

  const value: FavoritesContextValue = {
    favorites,
    isFavorite,
    addFavorite,
    removeFavorite,
    toggleFavorite,
    isLoading,
  }

  return (
    <FavoritesContext.Provider value={value}>
      {children}
    </FavoritesContext.Provider>
  )
}

export function useFavorites(): FavoritesContextValue {
  const context = useContext(FavoritesContext)

  if (!context) {
    return {
      favorites: [],
      isFavorite: () => false,
      addFavorite: () => {},
      removeFavorite: () => {},
      toggleFavorite: () => {},
      isLoading: true,
    }
  }

  return context
}

export function BackToTop() {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const toggleVisibility = () => {
      const scrolled = window.scrollY
      const pageHeight = document.documentElement.scrollHeight
      const viewportHeight = window.innerHeight
      const isPageLongEnough = pageHeight > viewportHeight * 1.5
      const hasScrolledEnough = scrolled > 400

      setIsVisible(isPageLongEnough && hasScrolledEnough)
    }

    window.addEventListener('scroll', toggleVisibility, { passive: true })
    toggleVisibility()

    return () => window.removeEventListener('scroll', toggleVisibility)
  }, [])

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    })
  }

  if (!isVisible) {
    return null
  }

  return (
    <button
      type="button"
      onClick={scrollToTop}
      className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full p-0 shadow-lg transition-all duration-200 hover:shadow-xl"
      aria-label="Back to top"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  )
}
