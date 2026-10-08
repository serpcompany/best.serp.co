import type { ComponentProps } from 'react'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { Badge } from '@/components/ui/badge'
import { FavoriteButton } from '../favorites/favorite-button'
import { ListingImage } from '../listing/listing-image'
import { VerifiedOwnerBadge } from './verified-owner-badge'
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
  const BreadcrumbSlot = (props: ComponentProps<typeof SiteBreadcrumb>) => (
    <SiteBreadcrumb {...props} structuredData={structuredData} />
  )

  return (
    <SharedWebsiteHero
      website={website}
      breadcrumbItems={breadcrumbItems}
      slots={{
        Badge,
        Breadcrumb: BreadcrumbSlot,
        FavoriteButton,
        ListingImage,
        VerifiedOwnerBadge
      }}
    />
  )
}
