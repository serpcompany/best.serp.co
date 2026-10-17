import { ArrowRight, BadgeCheck, EyeOff } from 'lucide-react'
import Link from 'next/link'
import { NotFoundLinks } from '@/components/layout/not-found-content'
import { PageSection } from '@/components/layout/page-shell'
import { Section } from '@/components/layout/section'
import { LLMGrid } from '@/components/llm/llm-grid'
import { buttonVariants } from '@/components/ui/button'
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
import type { PublishedBestPage, PublishedCategory, UnpublishedListing } from '@/db/contracts'
import type { NotFoundLinkTargets } from '@/lib/catalog/site-nav'
import type { WebsiteRelatedCardMetadata } from '@/lib/directory/content-query'
import { getRoute } from '@/lib/routing/routes'

/** How many of its category's live listings the 410 page shows as alternatives (#53). */
export const GONE_LISTING_ALTERNATIVES = 6

/**
 * The page an unpublished listing's URL shows, with status 410 Gone (#64; screen 9's
 * "Unpublished (410)" state): the listing is gone, a link to its hub (and the hub's best pages,
 * #53), "Relist it", then up to `GONE_LISTING_ALTERNATIVES` live listings from the hub as
 * alternatives. `hub` is the listing's category only while that category's page renders
 * (`renderingCategory`, #347); without it the page links the directory, never a category page that
 * answers 404. With no alternative to show, it shows the 404 page's links instead (serp
 * web-stack/404-pages.md).
 */
export function GoneListing({
  alternatives,
  bestPages,
  hub,
  links,
  listing
}: {
  alternatives: readonly WebsiteRelatedCardMetadata[]
  /** The hub's best pages that render (`categoryBestPages`). */
  bestPages: readonly Pick<PublishedBestPage, 'heading' | 'slug'>[]
  hub: Pick<PublishedCategory, 'name' | 'slug'> | null
  /** The 404 page's links, shown when there is no alternative. */
  links: NotFoundLinkTargets
  listing: Pick<UnpublishedListing, 'name'>
}) {
  const categoryHref = hub
    ? getRoute('category.page', { category: hub.slug })
    : getRoute('listing.list')
  const categoryName = hub?.name ?? 'the directory'
  return (
    <>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-16">
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <EyeOff />
            </EmptyMedia>
            <EmptyTitle>
              <h2>{listing.name} is no longer listed</h2>
            </EmptyTitle>
            <EmptyDescription>
              This listing was removed from SERP. Browse other products in{' '}
              <Link href={categoryHref} className="underline underline-offset-4">
                {categoryName}
              </Link>
              .
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="max-w-none flex-row flex-wrap justify-center">
            <Link href={categoryHref} className={buttonVariants({ variant: 'outline' })}>
              Browse {hub?.name ?? 'products'}
              <ArrowRight />
            </Link>
            {bestPages.map(bestPage => (
              <Link
                key={bestPage.slug}
                href={getRoute('best.page', { keyword: bestPage.slug })}
                className={buttonVariants({ variant: 'outline' })}
              >
                {bestPage.heading}
                <ArrowRight />
              </Link>
            ))}
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
            <Link href={getRoute('submit')} className={buttonVariants({ size: 'sm' })}>
              Relist it
            </Link>
          </ItemActions>
        </Item>
      </section>
      {alternatives.length > 0 ? (
        <PageSection spacing="spacious" className="border-t">
          <Section title="Alternatives" titleId="gone-listing-alternatives">
            <LLMGrid items={[...alternatives]} analyticsSource="gone-listing" />
          </Section>
        </PageSection>
      ) : (
        <NotFoundLinks {...links} />
      )}
    </>
  )
}
