import { Layers3, LayoutGrid, Link2 } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'
import { CardGrid } from './card-grid'
import { ListCard } from './list-card'
import { PageSection } from './page-shell'
import { productLinks } from './site-links'

/** The 404 page's metadata, built per request (its URLs carry this environment's origin, #359). */
export function notFoundMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Page Not Found',
    description: `The page you are looking for does not exist. Browse ${siteConfig.name} to explore the directory.`,
    path: '/404',
    noindex: true
  })
}

// serp.co's page icons (`components/icons.ts`): Layers3 is its brands icon.
const linkIcons: Record<string, typeof Layers3> = {
  [getRoute('category.index')]: LayoutGrid,
  [getRoute('brands')]: Layers3
}

/**
 * The header's Products menu, less its first link (the homepage the button already offers) and
 * "Best" (#347), which the menu gained after this page's two-card grid was designed.
 */
const popularPages = productLinks.filter(
  link => link.href !== getRoute('home') && link.href !== getRoute('best.index')
)

/**
 * The 404 page's content (serp.co's `not-found.tsx`, #279): a large "404", the heading and its
 * sentence, the homepage button, then the popular pages. best.serp.co has no HTML sitemap, so
 * serp.co's second button goes. `app/not-found.tsx` and `app/(dashboard)/not-found.tsx` place it.
 */
export function NotFoundContent() {
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
          <div className="mt-10 flex w-full flex-col justify-center gap-4 sm:w-auto sm:flex-row">
            <Link href={getRoute('home')} className={buttonVariants({ size: 'lg' })}>
              Go to the homepage
            </Link>
          </div>
        </div>
      </PageSection>
      <PageSection aria-label="Popular pages" className="border-t" spacing="spacious">
        <CardGrid as="ul" columns={2}>
          {popularPages.map(link => {
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
    </>
  )
}
