import { ArrowRight, BadgeCheck, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle
} from '@/components/ui/item'
import type { UnpublishedListing } from '@/db/contracts'
import { getRoute } from '@/lib/routing/routes'

/**
 * The page an unpublished listing's URL shows, with status 410 Gone (#64; screen 9's
 * "Unpublished (410)" state): the listing is gone, a link to its category, and "Relist it".
 */
export function GoneListing({ listing }: { listing: UnpublishedListing }) {
  const categoryHref = listing.category
    ? getRoute('listing.withCategory', { category: listing.category })
    : getRoute('listing.list')
  const categoryName = listing.categoryName ?? 'the directory'
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-16">
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <EyeOff />
          </EmptyMedia>
          <EmptyTitle>{listing.name} is no longer listed</EmptyTitle>
          <EmptyDescription>
            This listing was removed from SERP. Browse other products in{' '}
            <Link href={categoryHref} className="underline underline-offset-4">
              {categoryName}
            </Link>
            .
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link href={categoryHref}>
              Browse {listing.categoryName ?? 'products'}
              <ArrowRight />
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
      <Item variant="muted">
        <ItemMedia variant="icon">
          <BadgeCheck />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Is this your product?</ItemTitle>
          <ItemDescription>Sign in to relist it on SERP.</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" asChild>
            <Link href={getRoute('submit')}>Relist it</Link>
          </Button>
        </ItemActions>
      </Item>
    </section>
  )
}
