'use client'
import { Button } from '@serpdirectory/design-system/button'
import {
  DirectoryApplicationActions,
  DirectoryApplicationHeader,
  DirectoryApplicationHeaderBar,
  DirectoryApplicationHeaderGroup,
  DirectoryApplicationNav
} from '@serpdirectory/design-system/shadcnblocks/directory-application-shell'
import { getRoute } from '@serpdirectory/web-core/routes'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { siteCopy } from '@serpdirectory/web-core/site-copy'
import { Menu, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { useSearch } from '../hooks/use-search'
import { useAnalyticsEvents } from '../root-shell-client'
import type { HeaderAuthState } from './header-auth-state'
import { NavLink } from './header-nav-link'
import { DesktopSearchForm, MobileSearchOverlay } from './header-search'
import { MobileDrawer } from './mobile-drawer'

/**
 * Main header component with navigation, search, and user actions
 *
 * @returns JSX.Element - Header component
 */
export function Header({
  activeCategorySlugs = [],
  authState,
  desktopSignOutButton,
  featuredCount = 0,
  mobileSignOutButton
}: {
  activeCategorySlugs?: string[]
  authState?: HeaderAuthState
  desktopSignOutButton?: ReactNode
  featuredCount?: number
  mobileSignOutButton?: ReactNode
}) {
  const [showMobileSearch, setShowMobileSearch] = useState(false)
  const [showMobileDrawer, setShowMobileDrawer] = useState(false)
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [showMobileAutocomplete, setShowMobileAutocomplete] = useState(false)
  const { searchQuery, setSearchQuery, handleSearch } = useSearch()
  const { trackSearch } = useAnalyticsEvents()
  const isAuthenticated = authState?.isAuthenticated ?? false
  const isAuthConfigured = authState?.isConfigured ?? true

  // Auto-focus mobile search input when it appears and handle escape key
  useEffect(() => {
    if (!showMobileSearch) {
      return undefined
    }

    // Prevent body scroll when search is open.
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = ''
    }
  }, [showMobileSearch])

  /**
   * Handles form submission for search
   *
   * @param e - Form event
   */
  const onSubmit = (e: FormEvent<Element>) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      // Track search submission
      trackSearch(
        searchQuery,
        0,
        showMobileSearch ? 'header-mobile-search' : 'header-desktop-search'
      )
      handleSearch(searchQuery)
      setSearchQuery('')
      setShowAutocomplete(false)
      setShowMobileAutocomplete(false)
      if (showMobileSearch) {
        setShowMobileSearch(false)
        setShowMobileAutocomplete(false)
      }
    }
  }

  /**
   * Handles desktop search input focus
   */
  const handleInputFocus = () => {
    setShowAutocomplete(true)
  }

  /**
   * Handles mobile search input focus
   */
  const handleMobileInputFocus = () => {
    setShowMobileAutocomplete(true)
  }

  /**
   * Handles desktop search input change
   *
   * @param e - Input change event
   */
  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
    if (!showAutocomplete) setShowAutocomplete(true)
  }

  /**
   * Handles mobile search input change
   *
   * @param e - Input change event
   */
  const handleMobileSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
    if (!showMobileAutocomplete) setShowMobileAutocomplete(true)
  }

  return (
    <>
      <DirectoryApplicationHeader>
        <DirectoryApplicationHeaderBar>
          {/* Logo + Menu - Left */}
          <DirectoryApplicationHeaderGroup>
            {/* Mobile menu toggle */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowMobileDrawer(true)}
              className="block sm:hidden p-2 hover:bg-muted rounded-md transition-colors -ml-2 shadow-none active:scale-100"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Link
              href={getRoute('home')}
              className="group text-lg font-bold whitespace-nowrap tracking-tight"
            >
              <span className="inline transition-colors">{siteConfig.name}</span>
            </Link>
          </DirectoryApplicationHeaderGroup>

          {/* Search - Center (prominent on desktop) */}
          <DesktopSearchForm
            availableCategorySlugs={activeCategorySlugs}
            searchQuery={searchQuery}
            onSearchChange={handleSearchChange}
            onInputFocus={handleInputFocus}
            onSubmit={onSubmit}
            showAutocomplete={showAutocomplete}
            onAutocompleteClose={() => setShowAutocomplete(false)}
            onAutocompleteSelect={() => {
              setShowAutocomplete(false)
              setSearchQuery('')
            }}
          />

          {/* Navigation + Actions - Right */}
          <DirectoryApplicationActions>
            {/* Desktop navigation */}
            <DirectoryApplicationNav>
              {siteConfig.features.showProjects ? (
                <NavLink href={getRoute('projects')}>{siteCopy.networkLabel}</NavLink>
              ) : null}
              {siteConfig.features.showDocs ? (
                <NavLink href={getRoute('docs.list')}>{siteCopy.docsLabel}</NavLink>
              ) : null}
              {siteConfig.features.showGuides ? (
                <NavLink href={getRoute('guides.list')}>Posts</NavLink>
              ) : null}
              {/* <NavLink href={getRoute('news')}>News</NavLink> */}
            </DirectoryApplicationNav>

            {/* Mobile search icon */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden text-muted-foreground hover:text-foreground shadow-none active:scale-100"
              onClick={() => setShowMobileSearch(!showMobileSearch)}
              aria-label="Toggle search"
            >
              <Search className="h-5 w-5" />
            </Button>

            <Button
              asChild
              className="inline-flex items-center justify-center rounded-none text-sm font-bold h-9 px-4 bg-foreground text-background hover:bg-foreground/90 transition-all duration-200 press-effect shadow-none active:scale-100"
            >
              <Link
                href={getRoute('submit')}
                aria-label={siteCopy.submitLabel}
                title={siteCopy.submitLabel}
              >
                <Plus className="h-4 w-4 sm:hidden" />
                <span className="hidden sm:inline">{siteCopy.submitLabel}</span>
              </Link>
            </Button>

            {siteConfig.features.showAuth && isAuthenticated ? (
              <>
                <Button
                  asChild
                  variant="outline"
                  className="hidden sm:inline-flex items-center justify-center rounded-none text-sm font-bold h-9 px-4 border border-border hover:bg-accent transition-colors shadow-none active:scale-100"
                >
                  <Link href={getRoute('account')}>Account</Link>
                </Button>
                {desktopSignOutButton}
              </>
            ) : siteConfig.features.showAuth && isAuthConfigured ? (
              <Button
                asChild
                variant="outline"
                className="hidden sm:inline-flex items-center justify-center rounded-none text-sm font-bold h-9 px-4 border border-border hover:bg-accent transition-colors shadow-none active:scale-100"
              >
                <Link href={getRoute('login')}>Sign up / Sign in</Link>
              </Button>
            ) : null}
          </DirectoryApplicationActions>
        </DirectoryApplicationHeaderBar>

        {/* Mobile search overlay */}
        <MobileSearchOverlay
          availableCategorySlugs={activeCategorySlugs}
          showMobileSearch={showMobileSearch}
          searchQuery={searchQuery}
          onSearchChange={handleMobileSearchChange}
          onInputFocus={handleMobileInputFocus}
          onSubmit={onSubmit}
          showMobileAutocomplete={showMobileAutocomplete}
          onMobileSearchClose={() => {
            setShowMobileSearch(false)
            setShowMobileAutocomplete(false)
          }}
          onAutocompleteSelect={() => {
            setShowMobileAutocomplete(false)
            setShowMobileSearch(false)
            setSearchQuery('')
          }}
        />
      </DirectoryApplicationHeader>

      {/* Mobile Drawer */}
      <MobileDrawer
        availableCategorySlugs={activeCategorySlugs}
        isOpen={showMobileDrawer}
        onClose={() => setShowMobileDrawer(false)}
        featuredCount={featuredCount}
        showFeaturedCategory={featuredCount > 0}
        authState={authState}
        signOutButton={mobileSignOutButton}
      />
    </>
  )
}
