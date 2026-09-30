import { Badge } from '@serpdirectory/design-system/badge'
import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import type { ComponentProps } from 'react'
import { FaviconWithFallback } from '../ui/favicon-with-fallback'
import { FavoriteButton } from '../ui/favorite-button'
import {
  WebsiteHero as SharedWebsiteHero,
  type WebsiteHeroProps as SharedWebsiteHeroProps
} from './website-hero'

export interface WebsiteHeroRouteProps {
  website: SharedWebsiteHeroProps['website']
  breadcrumbItems: SharedWebsiteHeroProps['breadcrumbItems']
  structuredData?: boolean
}

export function WebsiteHeroRoute({
  website,
  breadcrumbItems,
  structuredData = true
}: WebsiteHeroRouteProps) {
  const BreadcrumbSlot = (props: ComponentProps<typeof Breadcrumb>) => (
    <Breadcrumb {...props} structuredData={structuredData} />
  )

  return (
    <SharedWebsiteHero
      website={website}
      breadcrumbItems={breadcrumbItems}
      slots={{ Badge, Breadcrumb: BreadcrumbSlot, FavoriteButton, FaviconWithFallback }}
    />
  )
}
