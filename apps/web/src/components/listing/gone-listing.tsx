import Link from 'next/link'
import { LinkGrid, LinkSection, LinkSections } from '@/components/layout/link-sections'
import { NotFoundActions, NotFoundLinks } from '@/components/layout/not-found-content'
import { PageContainer } from '@/components/layout/page-shell'
import { LLMGrid } from '@/components/llm/llm-grid'
import { buttonVariants } from '@/components/ui/button'
import type { PublishedBestPage, PublishedCategory, UnpublishedListing } from '@/db/contracts'
import type { NotFoundLinkTargets } from '@/lib/catalog/site-nav'
import type { WebsiteRelatedCardMetadata } from '@/lib/directory/content-query'
import { getRoute } from '@/lib/routing/routes'
import { cn } from '@/lib/utils'

/** How many of its category's live listings the 410 page shows as cards (#53). */
export const GONE_LISTING_ALTERNATIVES = 6

/**
 * How many of its category's live listings the 410 page reads (#53): the cards, then the rest as
 * plain links. 100 is the most one page of a category's listings holds, so it stays one cached read.
 */
export const GONE_LISTING_CATEGORY_LISTINGS = 100

/**
 * The page an unpublished listing's URL shows, with status 410 Gone (#64; screen 9's
 * "Unpublished (410)" state), in the owner's "Option A, Sections" (#53): the listing is gone, a
 * link to its hub and "Relist it", then the hub in three sections: up to
 * `GONE_LISTING_ALTERNATIVES` of its live listings as cards under its name, its best pages, and its
 * other live listings as links. `hub` is the listing's category only while that category's page
 * renders (`renderingCategory`, #347); without it the page links the directory, never a category
 * page that answers 404. With no alternative to show, it shows the 404 page's actions and links
 * instead (serp web-stack/404-pages.md): the homepage button, the search, the index pages and the
 * 404 page's sections.
 */
export function GoneListing({
  alternatives,
  bestPages,
  hub,
  links,
  listing,
  more
}: {
  alternatives: readonly WebsiteRelatedCardMetadata[]
  /** The hub's best pages that render (`categoryBestPages`). */
  bestPages: readonly Pick<PublishedBestPage, 'heading' | 'slug'>[]
  hub: Pick<PublishedCategory, 'name' | 'slug'> | null
  /** The 404 page's links, read only when there is no alternative. */
  links: NotFoundLinkTargets | null
  listing: Pick<UnpublishedListing, 'name'>
  /** The hub's live listings after the alternatives, as links. */
  more: readonly { name: string; slug: string }[]
}) {
  const categoryHref = hub
    ? getRoute('category.page', { category: hub.slug })
    : getRoute('listing.list')
  return (
    <>
      <section aria-labelledby="gone-listing-title">
        <PageContainer className="flex flex-col items-center gap-3 pt-14 pb-12 text-center">
          <h1
            id="gone-listing-title"
            className="text-3xl font-semibold tracking-tight text-balance wrap-break-word sm:text-4xl"
          >
            {listing.name} is no longer listed
          </h1>
          <p className="max-w-xl text-lg text-pretty text-foreground/80">
            This listing was removed from SERP. Browse other products in{' '}
            <Link href={categoryHref} className="underline underline-offset-4">
              {hub?.name ?? 'the directory'}
            </Link>
            .
          </p>
          <p className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
            Is this your product? Sign in to relist it on SERP.
            <Link
              href={getRoute('submit')}
              // `cn` drops the base's `border-transparent`, so the outline shows on a link.
              className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}
            >
              Relist it
            </Link>
          </p>
          {links ? <NotFoundActions bestPages={links.bestPages} /> : null}
        </PageContainer>
      </section>
      {hub && alternatives.length > 0 ? (
        <LinkSections>
          <LinkSection
            id="gone-listing-alternatives"
            title={
              <Link href={categoryHref} className="underline-offset-4 hover:underline">
                {hub.name}
              </Link>
            }
          >
            <LLMGrid items={[...alternatives]} analyticsSource="gone-listing" />
          </LinkSection>
          {bestPages.length > 0 ? (
            <LinkSection id="gone-listing-best" title="Best of">
              <LinkGrid
                links={bestPages.map(bestPage => ({
                  href: getRoute('best.page', { keyword: bestPage.slug }),
                  label: bestPage.heading
                }))}
              />
            </LinkSection>
          ) : null}
          {more.length > 0 ? (
            <LinkSection id="gone-listing-more" title={`More in ${hub.name}`}>
              <LinkGrid
                links={more.map(item => ({
                  href: getRoute('listing.detail', { slug: item.slug }),
                  label: item.name
                }))}
              />
            </LinkSection>
          ) : null}
        </LinkSections>
      ) : links ? (
        <NotFoundLinks {...links} />
      ) : null}
    </>
  )
}
