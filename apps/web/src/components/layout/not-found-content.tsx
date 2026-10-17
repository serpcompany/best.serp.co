import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import type { NotFoundLinkTargets } from '@/lib/catalog/site-nav'
import { getRoute } from '@/lib/routing/routes'
import { htmlSitemapListingPageLinks } from '@/lib/seo/html-sitemap'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'
import { siteCopy } from '@/lib/site/site-copy'
import {
  bestPageGroups,
  categoryLinks,
  LinkGrid,
  LinkGroups,
  LinkSection,
  LinkSections,
  sectionLinkClassName
} from './link-sections'
import { PageContainer } from './page-shell'
import { SearchField } from './search-field'
import { productLinks, type SiteLink } from './site-links'

/**
 * The 404 page's metadata, built per request (its URLs carry this environment's origin, #359).
 * Its robots directive is `null`: Next.js already writes `noindex` on a not-found response, and a
 * second, different tag leaves crawlers to pick one (#53; serp web-stack/404-pages.md). Leaving
 * the key out would keep a layout's own directive, which `/admin` and `/account` set; `null`
 * clears it, so every 404 carries Next.js's one tag.
 */
export function notFoundMetadata(): Metadata {
  return {
    ...generateBaseMetadata({
      title: 'Page Not Found',
      description: `The page you are looking for does not exist. Browse ${siteConfig.name} to explore the directory.`,
      path: '/404',
      noindex: true
    }),
    robots: null
  }
}

/**
 * The index pages (#53): the header's Products menu less its first link (the homepage, which the
 * 404 page's button offers), then the HTML sitemap.
 */
function indexPageLinks(bestIndexListed: boolean): SiteLink[] {
  return [
    ...productLinks({ bestIndexListed }).filter(link => link.href !== getRoute('home')),
    { href: getRoute('sitemap.index'), label: 'Sitemap' }
  ]
}

/**
 * What the 404 page offers under its message: "Go to the homepage" beside the site's search, then
 * the index pages in one centered row. The 410 page shows it too when its listing's category has
 * no other live listing.
 */
export function NotFoundActions({ bestPages }: Pick<NotFoundLinkTargets, 'bestPages'>) {
  return (
    <>
      <div className="mt-5 flex w-full max-w-2xl flex-col gap-3 sm:flex-row sm:items-center">
        <Link href={getRoute('home')} className={buttonVariants({ size: 'lg' })}>
          Go to the homepage
        </Link>
        {/* The search page's GET form (`search-page-form.tsx`), without its current query. */}
        <search className="w-full sm:flex-1">
          <form action={getRoute('search')} method="get">
            <SearchField
              name="q"
              autoComplete="off"
              aria-label="Search"
              groupClassName="h-9"
              submitLabel="Search"
              placeholder={siteCopy.listingSearchPlaceholder}
            />
          </form>
        </search>
      </div>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-6 gap-y-2">
        {indexPageLinks(bestPages.length > 0).map(link => (
          <li key={link.href}>
            <Link href={link.href} className={sectionLinkClassName}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * The 404 page's sections (#53, "Option A, Sections"; serp web-stack/404-pages.md): every category
 * with a public listing, every best page that renders under its hub, the newest listings, then the
 * HTML sitemap's numbered listing pages. A section with nothing to link is left out. The 410 page
 * shows them too when its listing's category has no other live listing.
 */
export function NotFoundLinks({
  bestPages,
  categories,
  listingTotal,
  newest
}: NotFoundLinkTargets) {
  const bestGroups = bestPageGroups(bestPages, categories)
  const listingPages = htmlSitemapListingPageLinks(listingTotal)
  if (!categories.length && !bestGroups.length && !newest.length && !listingPages.length) {
    return null
  }
  return (
    <LinkSections>
      {categories.length ? (
        <LinkSection id="not-found-categories" title="Categories">
          <LinkGrid links={categoryLinks(categories)} />
        </LinkSection>
      ) : null}
      {bestGroups.length ? (
        <LinkSection id="not-found-best" title="Best of">
          <LinkGroups groups={bestGroups} />
        </LinkSection>
      ) : null}
      {newest.length ? (
        <LinkSection id="not-found-newest" title="Newest">
          <LinkGrid
            links={newest.map(listing => ({
              href: getRoute('listing.detail', { slug: listing.slug }),
              label: listing.name
            }))}
          />
        </LinkSection>
      ) : null}
      {listingPages.length ? (
        <LinkSection id="not-found-listings" title="Listings">
          <LinkGrid links={listingPages} />
        </LinkSection>
      ) : null}
    </LinkSections>
  )
}

/**
 * The 404 page's content (serp.co's `not-found.tsx`, #279; #53, "Option A, Sections"): a small
 * "404" over the heading and its sentence, its actions (the homepage button beside the site's
 * search, then the index pages), then the 404 page's sections. `app/not-found.tsx` and `app/(dashboard)/not-found.tsx`
 * place it.
 */
export function NotFoundContent(targets: NotFoundLinkTargets) {
  return (
    <>
      <section aria-labelledby="not-found-title">
        <PageContainer className="flex flex-col items-center gap-3 pt-16 pb-12 text-center sm:pt-20 sm:pb-16">
          <p className="text-sm font-medium text-muted-foreground tabular-nums">404</p>
          <h1
            id="not-found-title"
            className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            Page not found
          </h1>
          <p className="max-w-xl text-lg text-pretty text-foreground/80">
            There is no page at this address. It may have moved, or the link may be mistyped.
          </p>
          <NotFoundActions bestPages={targets.bestPages} />
        </PageContainer>
      </section>
      <NotFoundLinks {...targets} />
    </>
  )
}
