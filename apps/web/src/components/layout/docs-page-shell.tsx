import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'
import { cn } from '@/lib/utils'

/** A breadcrumb step: its name and path. */
export type Crumb = { name: string; path: string }

/** A short label above a title (serp.co's `Eyebrow`). */
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        'inline-flex items-center gap-2 font-mono text-sm uppercase tracking-wide text-muted-foreground',
        className
      )}
    >
      {children}
      <span aria-hidden="true" className="inline-block h-3.5 w-2 bg-primary" />
    </p>
  )
}

/**
 * serp.co's `PageShell` (#276): a hero with the page title, then the content. `wide` holds cards
 * and grids on the page grid, `prose` a centered article, `docs` an article beside a sidebar
 * (`aside`), and `sidebar` other content beside one. On best.serp.co `SiteChrome` owns the page's
 * `<main>` and its header is sticky, not fixed, so the shell is a `div` without serp.co's top
 * offset.
 */
export function PageShell({
  title,
  description,
  eyebrow,
  updated,
  breadcrumbs,
  actions,
  layout = 'wide',
  align = layout === 'docs' || layout === 'sidebar' ? 'left' : 'center',
  titleSize = 'lg',
  aside,
  children
}: {
  title: string
  description?: ReactNode
  /** Short label above the title. */
  eyebrow?: string
  updated?: string
  /** Trail above the title, ending with this page. */
  breadcrumbs?: readonly Crumb[]
  /** Buttons under the description. */
  actions?: ReactNode
  layout?: 'wide' | 'prose' | 'docs' | 'sidebar'
  align?: 'center' | 'left'
  titleSize?: 'lg' | 'md'
  aside?: ReactNode
  children: ReactNode
}) {
  const centered = align === 'center'
  return (
    <div className="flex-1">
      <header className="border-b">
        <div className="mx-auto w-full max-w-7xl xl:border-x">
          <div
            className={cn(
              'flex flex-col gap-5 px-4 pt-14 pb-14 sm:px-6 sm:pt-20 sm:pb-20 lg:px-8',
              centered ? 'items-center text-center' : 'items-start'
            )}
          >
            {breadcrumbs ? <Breadcrumbs crumbs={breadcrumbs} /> : null}
            {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
            <h1
              className={cn(
                'max-w-4xl text-foreground',
                titleSize === 'lg'
                  ? 'text-display text-[2.75rem] sm:text-6xl'
                  : 'text-headline text-3xl sm:text-4xl lg:text-5xl'
              )}
            >
              {title}
            </h1>
            {description ? (
              <div className="max-w-2xl text-lg text-muted-foreground sm:text-xl">
                {description}
              </div>
            ) : null}
            {updated ? (
              <Badge
                variant="outline"
                className="h-auto gap-2 bg-background/40 px-3 py-1 font-mono font-normal text-muted-foreground uppercase"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                Effective {updated}
              </Badge>
            ) : null}
            {actions ? (
              <div
                className={cn(
                  'mt-3 flex flex-wrap gap-3',
                  centered ? 'justify-center' : 'justify-start'
                )}
              >
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-7xl xl:border-x">
        {layout === 'docs' || layout === 'sidebar' ? (
          <div className="grid grid-cols-1 gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-16 lg:px-8 lg:py-16">
            {aside ? <aside className="lg:sticky lg:top-8 lg:self-start">{aside}</aside> : <div />}
            {layout === 'docs' ? (
              <article className="prose-docs">{children}</article>
            ) : (
              <div className="min-w-0">{children}</div>
            )}
          </div>
        ) : layout === 'prose' ? (
          <div className="px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
            <article className="prose-docs mx-auto">{children}</article>
          </div>
        ) : (
          <div className="px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:py-20">{children}</div>
        )}
      </div>
    </div>
  )
}

function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  const last = crumbs.length - 1
  return (
    <Breadcrumb className="max-w-full">
      <BreadcrumbList className="gap-x-2 gap-y-1">
        {crumbs.map((crumb, index) =>
          index < last ? (
            <Fragment key={crumb.path}>
              <BreadcrumbItem>
                <BreadcrumbLink
                  render={<Link href={crumb.path} />}
                  className="rounded-sm hover:underline"
                >
                  {crumb.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator>/</BreadcrumbSeparator>
            </Fragment>
          ) : (
            <BreadcrumbItem key={crumb.path} className="min-w-0 max-w-full">
              <BreadcrumbPage className="min-w-0 truncate">{crumb.name}</BreadcrumbPage>
            </BreadcrumbItem>
          )
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
