import {
  ExternalResourcesSection as SharedExternalResourcesSection,
  type ExternalResourcesSectionProps,
} from './external-resources-section'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card'

export function ExternalResourcesSectionRoute(
  props: Omit<ExternalResourcesSectionProps, 'slots'>
) {
  return (
    <SharedExternalResourcesSection
      {...props}
      slots={{ Card, CardContent, CardDescription, CardHeader, CardTitle }}
    />
  )
}
