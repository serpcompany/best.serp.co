'use client'

import { ExternalLink, X } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useRef } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { HeaderAuthState } from '@/lib/auth/header-auth-state'
import { cn } from '@/lib/utils'
import { withDubVia } from '../../lib/analytics/dub-via'
import { resolveCategories } from '../../lib/directory/categories'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import { getRoute } from '../../lib/routing/routes'
import { externalResources } from '../../lib/site/external-resources'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { FavoritesLink } from '../favorites/favorites-link'
import {
  DirectoryNavigationItem,
  DirectoryNavigationSection,
  directoryNavigationInteractiveClassName
} from './directory-navigation'

interface MobileDrawerProps {
  availableCategorySlugs?: string[]
  authState?: HeaderAuthState
  isOpen: boolean
  onClose: () => void
  signOutButton?: ReactNode
}

/**
 * Mobile navigation drawer component
 */
export function MobileDrawer({
  availableCategorySlugs,
  authState,
  isOpen,
  onClose,
  signOutButton
}: MobileDrawerProps) {
  const pathname = usePathname()
  const drawerRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const isAuthenticated = authState?.isAuthenticated ?? false
  const isAuthConfigured = authState?.isConfigured ?? true
  const showExternalResources =
    siteConfig.features.showExternalResources && externalResources.length > 0
  const availableCategories = resolveCategories(availableCategorySlugs || [])

  // Close drawer when route changes
  useEffect(() => {
    if (isOpen) {
      onClose()
    }
  }, [pathname])

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }

    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  const getFocusableElements = () => {
    const drawer = drawerRef.current
    if (!drawer) return []

    return Array.from(
      drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => !element.hasAttribute('disabled'))
  }

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null
      window.requestAnimationFrame(() => {
        getFocusableElements()[0]?.focus()
      })
      return
    }

    if (previousFocusRef.current?.isConnected) {
      previousFocusRef.current.focus()
    }
  }, [isOpen])

  // Handle escape key and keep keyboard focus inside the open drawer.
  useEffect(() => {
    /**
     * Handles drawer keyboard commands.
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
        return
      }

      if (e.key !== 'Tab' || !isOpen) {
        return
      }

      const focusableElements = getFocusableElements()
      if (focusableElements.length === 0) {
        e.preventDefault()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement?.focus()
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  /**
   * Checks if current page is a category page
   */
  const isCategoryPage = (slug: string) =>
    pathname === getRoute('category.page', { category: slug })

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        className={cn(
          'fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity sm:hidden border-none p-0',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            onClose()
          }
        }}
        tabIndex={-1}
        aria-label="Close menu"
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        aria-hidden={!isOpen}
        aria-label="Menu"
        aria-modal={isOpen}
        className={cn(
          'fixed top-0 left-0 h-full w-[280px] bg-background border-r z-[70] transition-transform duration-300 sm:hidden',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        inert={!isOpen}
        ref={drawerRef}
        role="dialog"
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold text-lg">Menu</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-muted rounded-md transition-colors"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Drawer Content */}
        <ScrollArea className="h-[calc(100%-64px)] overscroll-contain">
          <div className="p-4 space-y-6">
            {/* Main Navigation */}
            <DirectoryNavigationSection title="Navigation" titleClassName="mb-3">
              {siteConfig.features.showAuth && isAuthenticated ? (
                <Link
                  href={getRoute('account')}
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem className="py-1.5">Account</DirectoryNavigationItem>
                </Link>
              ) : siteConfig.features.showAuth && isAuthConfigured ? (
                <Link href={getRoute('login')} className={directoryNavigationInteractiveClassName}>
                  <DirectoryNavigationItem className="py-1.5">
                    Sign up / Sign in
                  </DirectoryNavigationItem>
                </Link>
              ) : null}
              {siteConfig.features.showProjects ? (
                <Link
                  href={getRoute('projects')}
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem className="py-1.5">
                    {siteCopy.networkLabel}
                  </DirectoryNavigationItem>
                </Link>
              ) : null}
              {siteConfig.features.showDocs ? (
                <Link
                  href={getRoute('docs.list')}
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem className="py-1.5">
                    {siteCopy.docsLabel}
                  </DirectoryNavigationItem>
                </Link>
              ) : null}
              {siteConfig.features.showGuides ? (
                <Link
                  href={getRoute('guides.list')}
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem className="py-1.5">Posts</DirectoryNavigationItem>
                </Link>
              ) : null}
              <Link href={getRoute('submit')} className={directoryNavigationInteractiveClassName}>
                <DirectoryNavigationItem className="py-1.5">
                  {siteCopy.submitLabel}
                </DirectoryNavigationItem>
              </Link>
              {siteConfig.features.showAuth && isAuthenticated ? signOutButton : null}
            </DirectoryNavigationSection>

            {/* My Collection Section */}
            {siteConfig.features.showFavorites ? (
              <DirectoryNavigationSection title="My Collection" titleClassName="mb-3">
                <FavoritesLink isMobile />
              </DirectoryNavigationSection>
            ) : null}

            {/* Categories */}
            <DirectoryNavigationSection title="Categories" titleClassName="mb-3">
              {availableCategories.map(category => {
                const isActive = isCategoryPage(category.slug)

                return (
                  <Link
                    key={category.slug}
                    href={getRoute('category.page', { category: category.slug })}
                    aria-current={isActive ? 'page' : undefined}
                    className={directoryNavigationInteractiveClassName}
                  >
                    <DirectoryNavigationItem
                      className="py-1.5"
                      icon={<category.icon className="h-4 w-4" />}
                      active={isActive}
                    >
                      {getCategoryDisplayName(category.slug)}
                    </DirectoryNavigationItem>
                  </Link>
                )
              })}
            </DirectoryNavigationSection>

            {showExternalResources ? (
              <DirectoryNavigationSection title="Resources" titleClassName="mb-3">
                {externalResources.map(resource => (
                  <Link
                    key={resource.slug}
                    href={withDubVia(resource.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={directoryNavigationInteractiveClassName}
                  >
                    <DirectoryNavigationItem
                      className="py-1.5"
                      icon={<resource.icon className="h-4 w-4 flex-shrink-0" />}
                      trailing={
                        <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                      }
                    >
                      {resource.name}
                    </DirectoryNavigationItem>
                  </Link>
                ))}
              </DirectoryNavigationSection>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </>
  )
}
