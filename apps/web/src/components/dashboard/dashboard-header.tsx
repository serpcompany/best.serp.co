'use client'

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
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

export interface DashboardCrumb {
  label: string
  /** Omit on the current page. */
  href?: string
}

/**
 * The dashboards' top bar: serplists' `AppShell` header (sticky, with the sidebar trigger),
 * then this site's breadcrumb (only the current page below `md`) where serplists has the public
 * site navigation, and `actions` on the right. The bar takes the inset's background, and its
 * corners in the account's inset variant. The page's own `<h1>` lives in the content
 * (`DashboardPageHeader`).
 */
export function DashboardHeader({
  crumbs,
  actions
}: {
  crumbs: readonly DashboardCrumb[]
  actions?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b bg-inherit px-4 md:group-has-data-[variant=inset]/sidebar-wrapper:rounded-t-xl">
      <SidebarTrigger className="-ml-1" />
      <Separator
        orientation="vertical"
        className="mx-2 data-vertical:self-center data-[orientation=vertical]:h-4"
      />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <Fragment key={crumb.href ?? crumb.label}>
                <BreadcrumbItem className={last ? undefined : 'hidden md:block'}>
                  {last || !crumb.href ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<Link href={crumb.href} />}>
                      {crumb.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {last ? null : <BreadcrumbSeparator className="hidden md:block" />}
              </Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}
