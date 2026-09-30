import { Badge } from '@serpdirectory/design-system/badge'
import type { GuideMetadata } from '../content-query'
import { Card, CardContent } from '../ui/card'
import { GuideCard as SharedGuideCard } from './guide-card'

interface GuideCardRouteProps {
  guide: GuideMetadata
  index?: number
}

export function GuideCardRoute({ guide, index = 0 }: GuideCardRouteProps) {
  return <SharedGuideCard guide={guide} index={index} slots={{ Badge, Card, CardContent }} />
}
