import { House } from 'lucide-react'
import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'
import { cn } from '@/lib/utils'

export type BreadcrumbTrailItem = { href?: string; label: ReactNode }

type PageBreadcrumbProps = {
  className?: string
  home?: boolean
  items: BreadcrumbTrailItem[]
}

/**
 * The trail over a detail page (serplists' `PageBreadcrumb`, #273): Home as an icon, then the
 * items; one with an `href` is a link and the one without is the page. It writes no JSON-LD: the
 * page's own graph carries the `BreadcrumbList`.
 */
export function PageBreadcrumb({ className, home = true, items }: PageBreadcrumbProps) {
  return (
    <Breadcrumb className={cn('mb-8', className)}>
      <BreadcrumbList>
        {home ? (
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/" />}>
              <House className="size-4" aria-hidden="true" />
              <span className="sr-only">Home</span>
            </BreadcrumbLink>
          </BreadcrumbItem>
        ) : null}
        {items.map((item, index) => (
          // The trail is static and ordered; a label may be a node, not a key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={index}>
            {home || index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              {item.href ? (
                <BreadcrumbLink render={<Link href={item.href} />}>{item.label}</BreadcrumbLink>
              ) : (
                <BreadcrumbPage className="line-clamp-1">{item.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
