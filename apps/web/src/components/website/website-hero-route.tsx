import { Badge } from '@/components/ui/badge'
import { Breadcrumb } from '@/components/layout/breadcrumb'
import type { ComponentProps } from 'react'
import { FavoriteButton } from '../ui/favorite-button'
import { ListingImage } from '../ui/listing-image'
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
  const BreadcrumbSlot = (props: ComponentProps<typeof Breadcrumb>) => (
    <Breadcrumb {...props} structuredData={structuredData} />
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
