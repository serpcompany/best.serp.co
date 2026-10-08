'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { analytics } from '../../lib/analytics/analytics'
import { Section } from '../layout/section'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/directory/card'
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
        Card,
        CardContent,
        CardDescription,
        CardHeader,
        CardTitle,
        Section
      }}
    />
  )
}
