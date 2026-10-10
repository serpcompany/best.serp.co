import { ChevronRight } from 'lucide-react'
import type { PublishedCategory } from '@/db/contracts'
import { getCategoryIcon } from '../../lib/directory/categories'
import { getRoute } from '../../lib/routing/routes'
import { CardGrid } from '../layout/card-grid'
import { ListCard } from '../layout/list-card'
import { Badge } from '../ui/badge'

/**
 * Categories as linked cards with their listing counts (#268): the categories index, and the
 * homepage's hub grid (#347).
 */
export function CategoryCards({ categories }: { categories: readonly PublishedCategory[] }) {
  return (
    <CardGrid as="ul">
      {categories.map(category => {
        const Icon = getCategoryIcon(category.slug)
        return (
          <li key={category.slug}>
            <ListCard
              className="h-full"
              href={getRoute('category.page', { category: category.slug })}
              icon={<Icon />}
              meta={
                <>
                  <Badge variant="secondary">{category.count}</Badge>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </>
              }
              title={category.name}
            />
          </li>
        )
      })}
    </CardGrid>
  )
}
