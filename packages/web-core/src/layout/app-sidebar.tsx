'use client'

import { ScrollArea } from '@serpdirectory/design-system/scroll-area'
import {
  DirectoryNavigationItem,
  DirectoryNavigationSection,
  directoryNavigationInteractiveClassName
} from '@serpdirectory/design-system/shadcnblocks/directory-navigation'
import { ExternalLink, Trophy } from 'lucide-react'
import Link from 'next/link'
import { resolveCategories } from '../categories'
import { getCategoryDisplayName } from '../category-display'
import { externalResources } from '../external-resources'
import { getFeaturedCategoryRoute, getRoute } from '../routes'
import { siteConfig } from '../site-config'
import { FavoritesLink } from '../ui/favorites-link'

export interface AppSidebarProps {
  availableCategorySlugs?: string[]
  currentCategory?: string
  featuredCount?: number
  showFeaturedCategory?: boolean
}

export function AppSidebar({
  availableCategorySlugs,
  currentCategory,
  featuredCount = 0,
  showFeaturedCategory = featuredCount > 0
}: AppSidebarProps) {
  const showExternalResources =
    siteConfig.features.showExternalResources && externalResources.length > 0
  const availableCategories = resolveCategories(availableCategorySlugs || [])

  return (
    <div className="sticky top-16 hidden h-[calc(100vh-4rem)] w-[240px] max-w-[240px] min-w-[240px] border-r sm:block">
      <ScrollArea className="h-full">
        <div className="space-y-6 p-4">
          <h2 className="sr-only">Navigation</h2>

          {siteConfig.features.showFavorites ? (
            <DirectoryNavigationSection title="My Collection">
              <FavoritesLink />
            </DirectoryNavigationSection>
          ) : null}

          <DirectoryNavigationSection title="Categories">
            {showFeaturedCategory ? (
              <Link
                href={getFeaturedCategoryRoute()}
                className={directoryNavigationInteractiveClassName}
              >
                <DirectoryNavigationItem
                  icon={<Trophy className="h-4 w-4" />}
                  trailing={
                    featuredCount > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs">
                        {featuredCount}
                      </span>
                    ) : null
                  }
                >
                  Featured
                </DirectoryNavigationItem>
              </Link>
            ) : null}
            {availableCategories.map(category => {
              const isActive = category.slug === currentCategory

              return (
                <Link
                  key={category.slug}
                  href={getRoute('category.page', { category: category.slug })}
                  aria-current={isActive ? 'page' : undefined}
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem
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
            <DirectoryNavigationSection title="Resources">
              {externalResources.map(resource => (
                <Link
                  key={resource.slug}
                  href={resource.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={directoryNavigationInteractiveClassName}
                >
                  <DirectoryNavigationItem
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
  )
}
