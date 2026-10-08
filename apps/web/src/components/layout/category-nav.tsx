'use client'

import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { ScrollArea } from '@/components/ui/scroll-area'
import { withDubVia } from '../../lib/analytics/dub-via'
import { resolveCategories } from '../../lib/directory/categories'
import { getCategoryDisplayName } from '../../lib/directory/category-display'
import { getRoute } from '../../lib/routing/routes'
import { externalResources } from '../../lib/site/external-resources'
import { siteConfig } from '../../lib/site/site-config'
import { FavoritesLink } from '../favorites/favorites-link'
import {
  DirectoryNavigationItem,
  DirectoryNavigationSection,
  directoryNavigationInteractiveClassName
} from './directory-navigation'

export interface CategoryNavProps {
  availableCategorySlugs?: string[]
  currentCategory?: string
}

export function CategoryNav({ availableCategorySlugs, currentCategory }: CategoryNavProps) {
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
                  href={withDubVia(resource.url)}
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
