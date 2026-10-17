import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { type BreadcrumbTrailItem, PageBreadcrumb } from './page-breadcrumb'
import { PageContainer } from './page-shell'

type DetailPageLayoutProps = {
  /** The visitor's actions on the record (the save button), at the header panel's right. */
  actions?: ReactNode
  /** A badge beside the title (Claimed). */
  badge?: ReactNode
  breadcrumbs?: BreadcrumbTrailItem[]
  /** The main column: the record's own content. */
  children?: ReactNode
  /** The main call to action (Visit Site): first and sticky, atop the desktop column or under the
   * header on phones. */
  cta?: ReactNode
  description?: ReactNode
  /** The block for the record's makers (the badge card): the column's foot, after `sidebar`. */
  end?: ReactNode
  /** Full-width sections under the content (Featured in, Related). */
  lower?: ReactNode
  /** The logo, about the height of the title and description. */
  media?: ReactNode
  /** Chips under the description (categories and tags). */
  meta?: ReactNode
  /** Under `cta` in the column that sticks on desktop (Alternatives); after the content on phones. */
  sidebar?: ReactNode
  title: ReactNode
}

/**
 * One listing's page (#273; the hero is #535's "Design 2, wide header"): the breadcrumb, then a
 * full-width header panel (the logo, the `h1` with its badge, the description and chips on the
 * left; the visitor's actions on the right), then the content beside a desktop column whose top,
 * `cta` and `sidebar`, sticks under the site header while the content scrolls, and whose foot,
 * `end`, waits level with the end of the content, so the sticky top never covers it. `lower`
 * runs full width beneath. On phones the column folds into the page in the same order: `cta`
 * pinned under the site header from the top of the page, the content, `sidebar`, `end` (two
 * across on tablets), then `lower`. Sticky positioning only: no script. The header is a `div`:
 * the site header stays the page's only `<header>`.
 */
export function DetailPageLayout({
  actions,
  badge,
  breadcrumbs,
  children,
  cta,
  description,
  end,
  lower,
  media,
  meta,
  sidebar,
  title
}: DetailPageLayoutProps) {
  return (
    <PageContainer width="shell" className="py-8 sm:py-10" data-slot="detail-page">
      {breadcrumbs ? <PageBreadcrumb className="mb-5" items={breadcrumbs} /> : null}

      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr_auto_auto] lg:gap-x-12 lg:gap-y-0">
        <div
          className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3.5 rounded-xl bg-muted/50 p-5 ring-1 ring-foreground/10 sm:gap-x-5 sm:p-8 lg:col-span-2"
          data-slot="detail-page-header"
        >
          {media ? <div className="col-start-1 row-start-1 sm:row-span-2">{media}</div> : null}
          <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[2rem]/9 font-semibold tracking-tight text-balance wrap-anywhere sm:text-[2.5rem]/11">
              {title}
            </h1>
            {badge}
          </div>
          {description ? (
            <p className="col-span-3 row-start-2 mt-3 max-w-176 text-base/snug whitespace-pre-line text-pretty wrap-anywhere text-muted-foreground sm:col-span-1 sm:col-start-2 sm:mt-0.5">
              {description}
            </p>
          ) : null}
          {meta ? (
            <div className="col-span-3 row-start-3 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground sm:col-span-1 sm:col-start-2 sm:mt-4">
              {meta}
            </div>
          ) : null}
          {actions ? (
            <div className="col-start-3 row-start-1 flex items-center gap-2 justify-self-end sm:row-span-3">
              {actions}
            </div>
          ) : null}
        </div>

        {/* Phones: pinned under the site header (h-14 and its border) on a band of the page's
            background, so the content scrolls beneath it. */}
        {cta ? (
          <div className="sticky top-[57px] z-40 -mx-4 -mt-6 -mb-2 flex flex-col bg-background/95 px-4 py-2 backdrop-blur-md md:-mx-6 md:px-6 lg:hidden">
            {cta}
          </div>
        ) : null}

        <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-2 lg:mt-8">
          {children}
        </div>

        {/* The column: its children join the desktop grid; on tablets two across. */}
        {sidebar || end || cta ? (
          <div
            className={cn(
              'flex flex-col gap-8 md:grid md:grid-cols-2 md:items-start lg:contents',
              !sidebar && !end && 'max-lg:hidden'
            )}
          >
            {cta || sidebar ? (
              <div
                className={cn('lg:col-start-2 lg:row-start-2 lg:mt-8', !sidebar && 'max-lg:hidden')}
              >
                <div className="flex flex-col gap-4 lg:sticky lg:top-20">
                  {cta ? <div className="hidden flex-col lg:flex">{cta}</div> : null}
                  {sidebar}
                </div>
              </div>
            ) : null}
            {end ? <div className="lg:col-start-2 lg:row-start-3 lg:mt-8">{end}</div> : null}
          </div>
        ) : null}

        {lower ? (
          <div className="flex min-w-0 flex-col gap-12 lg:col-span-2 lg:row-start-4 lg:mt-14">
            {lower}
          </div>
        ) : null}
      </div>
    </PageContainer>
  )
}
