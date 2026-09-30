'use client'

import { Clock, SortAsc } from 'lucide-react'
import Link from 'next/link'
import { type ComponentType, useEffect, useMemo, useState } from 'react'
import type { WebsiteBrowseCardMetadata } from './content-query'
import { getRoute } from './routes'
import { siteCopy } from './site-copy'

export interface WebsitesListWithSortProps {
  initialWebsites: WebsiteBrowseCardMetadata[]
  emptyTitle?: string
  emptyDescription?: string
  trackSortChange?: (currentSort: string, nextSort: string, source?: string) => void
  slots: {
    Badge: ComponentType<any>
    Card: ComponentType<any>
    EmptyState: ComponentType<any>
    FaviconWithFallback: ComponentType<any>
    ToggleGroup: ComponentType<any>
    ToggleGroupItem: ComponentType<any>
  }
}

function stripHtmlTags(html: string | null | undefined): string {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, '').trim()
}

export function WebsitesListWithSort({
  initialWebsites,
  emptyTitle = siteCopy.categoryEmptyTitle,
  emptyDescription = siteCopy.categoryEmptyDescription,
  trackSortChange,
  slots: { Badge, Card, EmptyState, FaviconWithFallback, ToggleGroup, ToggleGroupItem }
}: WebsitesListWithSortProps) {
  const [sortBy, setSortBy] = useState<'name' | 'latest'>('name')
  const [isClient, setIsClient] = useState(false)

  useEffect(() => {
    setIsClient(true)
    const savedSortBy = localStorage.getItem('category-sort-by')
    if (savedSortBy && (savedSortBy === 'name' || savedSortBy === 'latest')) {
      setSortBy(savedSortBy)
    }
  }, [])

  useEffect(() => {
    if (isClient) {
      localStorage.setItem('category-sort-by', sortBy)
    }
  }, [sortBy, isClient])

  const sortedWebsites = useMemo(() => {
    const websites = [...initialWebsites]
    if (sortBy === 'latest') {
      return websites.sort((a, b) => {
        const dateA = new Date(a.publishedAt).getTime()
        const dateB = new Date(b.publishedAt).getTime()
        return dateB - dateA
      })
    }

    return websites.sort((a, b) => a.name.localeCompare(b.name))
  }, [initialWebsites, sortBy])

  const renderWebsite = (website: WebsiteBrowseCardMetadata) => (
    <Card
      key={website.slug}
      className="p-4 hover:bg-muted/50 transition-all duration-300 relative h-full hover:shadow-md"
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <FaviconWithFallback
            website={website.website}
            name={website.name}
            logoUrl={website.media?.logo}
            size={32}
          />
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">
              <Link
                href={getRoute('listing.detail', { slug: website.slug })}
                className="block after:absolute after:inset-0 after:content-[''] z-10 hover:text-primary transition-colors"
              >
                {website.name}
              </Link>
            </h3>
            {website.isUnofficial && (
              <Badge
                variant="outline"
                className="text-xs border-muted-foreground/20 bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
              >
                Unofficial
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {stripHtmlTags(website.description)}
          </p>
        </div>
      </div>
    </Card>
  )

  const emptyState = (
    <EmptyState
      title={emptyTitle}
      description={emptyDescription}
      actionLabel={siteCopy.submitLabel}
      actionHref={getRoute('submit')}
    />
  )

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">
          {initialWebsites.length > 0 && (
            <>
              Showing {sortedWebsites.length} {siteCopy.listingName.plural} in this category
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort by:</span>
          <ToggleGroup
            type="single"
            value={sortBy}
            onValueChange={(value: string) => {
              if (value && value !== sortBy) {
                trackSortChange?.(sortBy, value, 'category-sort')
                setSortBy(value as 'name' | 'latest')
              }
            }}
            className="bg-background border rounded-md"
          >
            <ToggleGroupItem
              value="name"
              className="px-3 py-2 h-10 data-[state=on]:bg-accent cursor-pointer"
            >
              <SortAsc className="size-4 mr-2" />
              <span className="text-sm">Name</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="latest"
              className="px-3 py-2 h-10 data-[state=on]:bg-accent cursor-pointer"
            >
              <Clock className="size-4 mr-2" />
              <span className="text-sm">Latest</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {sortedWebsites.length === 0 ? (
        emptyState
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 4xl:grid-cols-8 gap-4">
          {sortedWebsites.map(website => renderWebsite(website))}
        </div>
      )}
    </div>
  )
}
