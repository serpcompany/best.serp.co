import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import {
  type ExternalResourcesSectionProps,
  ExternalResourcesSection as SharedExternalResourcesSection
} from './external-resources-section'

export function ExternalResourcesSectionRoute(props: Omit<ExternalResourcesSectionProps, 'slots'>) {
  return (
    <SharedExternalResourcesSection
      {...props}
      slots={{ Card, CardContent, CardDescription, CardHeader, CardTitle }}
    />
  )
}
