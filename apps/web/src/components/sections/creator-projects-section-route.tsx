'use client'

import { SiteCard, SiteCardHeader } from '@/components/directory/site-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { analytics } from '../../lib/analytics/analytics'
import { Section } from '../layout/section'
import { CreatorProjectsSection as SharedCreatorProjectsSection } from './creator-projects-section'

export function CreatorProjectsSectionRoute() {
  return (
    <SharedCreatorProjectsSection
      onProjectClick={(name, url, destination, source) => {
        analytics.creatorProjectClick(name, url, destination, source)
      }}
      slots={{
        Badge,
        Button,
        Card: SiteCard,
        CardContent,
        CardDescription,
        CardHeader: SiteCardHeader,
        CardTitle,
        Section
      }}
    />
  )
}
