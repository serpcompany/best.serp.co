import { Card, CardContent } from '@/components/directory/card'
import { Badge } from '@/components/ui/badge'
import type { GuideMetadata } from '../../lib/directory/content-query'
import { GuideCard as SharedGuideCard } from './guide-card'

interface GuideCardRouteProps {
  guide: GuideMetadata
  index?: number
}

export function GuideCardRoute({ guide, index = 0 }: GuideCardRouteProps) {
  return <SharedGuideCard guide={guide} index={index} slots={{ Badge, Card, CardContent }} />
}
