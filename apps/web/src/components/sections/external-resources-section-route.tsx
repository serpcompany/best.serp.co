import { SiteCard, SiteCardHeader } from '@/components/directory/site-card'
import { CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import {
  type ExternalResourcesSectionProps,
  ExternalResourcesSection as SharedExternalResourcesSection
} from './external-resources-section'

export function ExternalResourcesSectionRoute(props: Omit<ExternalResourcesSectionProps, 'slots'>) {
  return (
    <SharedExternalResourcesSection
      {...props}
      slots={{
        Card: SiteCard,
        CardContent,
        CardDescription,
        CardHeader: SiteCardHeader,
        CardTitle
      }}
    />
  )
}
