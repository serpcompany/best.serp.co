import { Layers3, LayoutGrid, Link2, Map as MapIcon } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { CategoryCards } from '@/components/category-routes/category-cards'
import { buttonVariants } from '@/components/ui/button'
import type { NotFoundLinkTargets } from '@/lib/catalog/site-nav'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'
import { siteCopy } from '@/lib/site/site-copy'
import { CardGrid } from './card-grid'
import { ListCard } from './list-card'
import { PageSection } from './page-shell'
import { SearchField } from './search-field'
import { SectionHeader } from './section-header'
import { productLinks } from './site-links'

/**
 * The 404 page's metadata, built per request (its URLs carry this environment's origin, #359).
 * It sets no robots directive: Next.js already writes `noindex` on a not-found response, and a
 * second, different tag left crawlers to pick one (#53; serp web-stack/404-pages.md).
 */
export function notFoundMetadata(): Metadata {
  const { robots: _robots, ...metadata } = generateBaseMetadata({
    title: 'Page Not Found',
    description: `The page you are looking for does not exist. Browse ${siteConfig.name} to explore the directory.`,
    path: '/404',
    noindex: true
  })
  return metadata
}

// serp.co's page icons (`components/icons.ts`): Layers3 is its brands icon, Map its sitemap's.
const linkIcons: Record<string, typeof Layers3> = {
  [getRoute('category.index')]: LayoutGrid,
  [getRoute('brands')]: Layers3,
  [getRoute('sitemap.index')]: MapIcon
}

/**
 * The index pages (#53): the header's Products menu less its first link (the homepage, which the
 * 404 page's button offers), then the HTML sitemap.
 */
function popularPages(bestIndexListed: boolean) {
  return [
    ...productLinks({ bestIndexListed }).filter(link => link.href !== getRoute('home')),
    { href: getRoute('sitemap.index'), label: 'Sitemap' }
  ]
}

/**
 * The 404 page's links (#53; serp web-stack/404-pages.md): every index page and the HTML sitemap,
 * then every category with a public listing. The 410 page shows them too when its listing's
 * category has no other live listing.
 */
export function NotFoundLinks({ bestPages, categories }: NotFoundLinkTargets) {
  return (
    <>
      <PageSection aria-label="Popular pages" className="border-t" spacing="spacious">
        <CardGrid as="ul" columns={2}>
          {popularPages(bestPages.length > 0).map(link => {
            const Icon = linkIcons[link.href] ?? Link2
            return (
              <li key={link.href} className="min-w-0">
                <ListCard
                  className="h-full"
                  href={link.href}
                  icon={<Icon />}
                  orientation="vertical"
                  title={link.label}
                  titleAs="h2"
                />
              </li>
            )
          })}
        </CardGrid>
      </PageSection>
      {categories.length > 0 ? (
        <PageSection aria-labelledby="not-found-categories" className="border-t" spacing="spacious">
          <SectionHeader id="not-found-categories" title="Categories" />
          <CategoryCards categories={categories} />
        </PageSection>
      ) : null}
    </>
  )
}

/**
 * The 404 page's content (serp.co's `not-found.tsx`, #279; #53): a large "404", the heading and
 * its sentence, the site's search, the homepage button, then the 404 page's links.
 * `app/not-found.tsx` and `app/(dashboard)/not-found.tsx` place it.
 */
export function NotFoundContent(targets: NotFoundLinkTargets) {
  return (
    <>
      <PageSection aria-labelledby="not-found-title">
        <div className="flex flex-col items-center pt-20 pb-24 text-center sm:pt-28 sm:pb-32">
          <p
            aria-hidden="true"
            className="text-[7rem] leading-none font-semibold tracking-tight text-muted-foreground sm:text-[11rem]"
          >
            404
          </p>
          <h1
            id="not-found-title"
            className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
          >
            Page not found
          </h1>
          <p className="mt-5 max-w-xl text-lg text-foreground/80 sm:text-xl">
            There is no page at this address. It may have moved, or the link may be mistyped.
          </p>
          {/* The search page's GET form (`search-page-form.tsx`), without its current query. */}
          <search className="mt-10 w-full max-w-md">
            <form action={getRoute('search')} method="get">
              <SearchField
                name="q"
                autoComplete="off"
                aria-label="Search"
                submitLabel="Search"
                placeholder={siteCopy.listingSearchPlaceholder}
              />
            </form>
          </search>
          <div className="mt-6 flex w-full flex-col justify-center gap-4 sm:w-auto sm:flex-row">
            <Link href={getRoute('home')} className={buttonVariants({ size: 'lg' })}>
              Go to the homepage
            </Link>
          </div>
        </div>
      </PageSection>
      <NotFoundLinks {...targets} />
    </>
  )
}
