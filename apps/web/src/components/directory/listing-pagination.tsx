import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import type { Metadata } from 'next'
import type { ComponentProps, ReactElement } from 'react'
import { buttonVariants } from '@/components/ui/button'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem
} from '@/components/ui/pagination'
import { cn } from '@/lib/utils'
import { SITE_PUBLIC_URL } from '../../lib/seo/seo-config'

/**
 * Directory and category listings are paginated with a `?page=N` query parameter on the
 * existing URL (`/products/?page=2`, `/products/categories/other/?page=3`). Page 1 is the
 * bare URL, so every existing URL, canonical, and sitemap entry is unchanged; pages 2+
 * are linked with plain anchors for crawlers, canonicalize to themselves, and are
 * `noindex, follow` so they pass link equity without competing with page 1.
 */
export const LISTING_PAGE_PARAM = 'page'

export interface ListingPageInfo {
  page: number
  pageCount: number
}

/** Strictly parses `?page=`; anything but a positive integer means page 1. */
export function parseListingPageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && /^[1-9]\d{0,5}$/u.test(raw) ? Number(raw) : 1
}

export function listingPageHref(basePath: string, page: number, fragment?: string): string {
  const path = page <= 1 ? basePath : `${basePath}?${LISTING_PAGE_PARAM}=${page}`
  return fragment ? `${path}#${fragment}` : path
}

/** Page 1 keeps its metadata; later pages get their own title, canonical, and robots. */
export function paginatedMetadata(
  metadata: Metadata,
  { basePath, page }: { basePath: string; page: number }
): Metadata {
  if (page <= 1) return metadata
  const canonical = `${SITE_PUBLIC_URL}${listingPageHref(basePath, page)}`
  const title = typeof metadata.title === 'string' ? `${metadata.title} - Page ${page}` : undefined
  return {
    ...metadata,
    ...(title ? { title } : {}),
    alternates: { ...metadata.alternates, canonical },
    openGraph: metadata.openGraph
      ? { ...metadata.openGraph, ...(title ? { title } : {}), url: canonical }
      : undefined,
    robots: { follow: true, googleBot: { follow: true, index: false }, index: false }
  }
}

/** First, last, and the pages around the current one, with gaps in between. */
export function paginationWindow(page: number, pageCount: number): Array<number | 'gap'> {
  const pages = new Set([1, pageCount, page - 1, page, page + 1])
  const visible = [...pages].filter(value => value >= 1 && value <= pageCount).sort((a, b) => a - b)
  return visible.flatMap((value, index) => {
    const previous = visible[index - 1]
    return previous !== undefined && value - previous > 1 ? ['gap' as const, value] : [value]
  })
}

/**
 * Stock `PaginationLink` renders Base UI's client `Button` around an anchor, which mismatches on
 * hydration when a server component renders it (#186). This is the same plain anchor, styled
 * with `buttonVariants`: outline for the current page, ghost otherwise.
 */
function PageLink({
  active = false,
  className,
  size = 'icon',
  ...props
}: ComponentProps<'a'> & { active?: boolean; size?: 'default' | 'icon' }) {
  return (
    <a
      aria-current={active ? 'page' : undefined}
      data-slot="pagination-link"
      data-active={active}
      className={cn(buttonVariants({ size, variant: active ? 'outline' : 'ghost' }), className)}
      {...props}
    />
  )
}

interface ListingPaginationProps extends ListingPageInfo {
  basePath: string
  /** Optional in-page anchor appended to page links (for example the directory list). */
  fragment?: string
  label?: string
}

export function ListingPagination({
  basePath,
  fragment,
  label = 'Directory pages',
  page,
  pageCount
}: ListingPaginationProps): ReactElement | null {
  if (pageCount <= 1) return null
  const href = (target: number) => listingPageHref(basePath, target, fragment)

  return (
    <Pagination aria-label={label} className="mt-8">
      <PaginationContent className="flex-wrap justify-center">
        {page > 1 ? (
          <PaginationItem>
            <PageLink
              aria-label="Go to previous page"
              className="pl-1.5!"
              href={href(page - 1)}
              rel="prev"
              size="default"
            >
              <ChevronLeftIcon data-icon="inline-start" />
              <span className="hidden sm:block">Previous</span>
            </PageLink>
          </PaginationItem>
        ) : null}
        {paginationWindow(page, pageCount).map((entry, index) =>
          entry === 'gap' ? (
            // The window has at most a leading and a trailing gap, so position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <PaginationItem key={`gap-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={entry}>
              <PageLink active={entry === page} aria-label={`Page ${entry}`} href={href(entry)}>
                {entry}
              </PageLink>
            </PaginationItem>
          )
        )}
        {page < pageCount ? (
          <PaginationItem>
            <PageLink
              aria-label="Go to next page"
              className="pr-1.5!"
              href={href(page + 1)}
              rel="next"
              size="default"
            >
              <span className="hidden sm:block">Next</span>
              <ChevronRightIcon data-icon="inline-end" />
            </PageLink>
          </PaginationItem>
        ) : null}
      </PaginationContent>
    </Pagination>
  )
}
