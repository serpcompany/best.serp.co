import Link from 'next/link'
import * as React from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'

/**
 * Represents a breadcrumb navigation item data
 */
export interface BreadcrumbItemData {
  name: string
  href: string
}

export interface SiteBreadcrumbProps {
  items: BreadcrumbItemData[]
  homeHref?: string
  baseUrl?: string
  structuredData?: boolean
}

/**
 * The JSON-LD URL of a breadcrumb link. The homepage is written as the bare origin
 * (`https://example.com`, not `https://example.com/`), per the SERP URL trailing-slash standard.
 */
function absoluteHref(href: string, baseUrl: string | undefined): string {
  if (!baseUrl) return href
  const origin = baseUrl.replace(/\/+$/u, '')
  return href === '/' ? origin : `${origin}${href}`
}

/**
 * The site's breadcrumb: the stock Breadcrumb with a Home link and optional JSON-LD
 *
 * @param props - Component properties
 * @param props.items - Array of breadcrumb items to display
 * @param props.homeHref - Optional custom home link (defaults to '/')
 * @param props.baseUrl - Optional base URL for JSON-LD (defaults to window.location.origin)
 * @param props.structuredData - Set false for private routes that must not emit JSON-LD
 * @returns React component with breadcrumb navigation and optional structured data
 */
export function SiteBreadcrumb({
  items,
  homeHref = '/',
  baseUrl,
  structuredData = true
}: SiteBreadcrumbProps) {
  return (
    <div className="mb-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href={homeHref} />}>Home</BreadcrumbLink>
          </BreadcrumbItem>
          {items.map((item, index) => (
            <React.Fragment key={item.href}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {index === items.length - 1 ? (
                  <BreadcrumbPage>{item.name}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={item.href} />}>{item.name}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {structuredData && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Required for JSON-LD
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'BreadcrumbList',
              itemListElement: [
                {
                  '@type': 'ListItem',
                  position: 1,
                  name: 'Home',
                  item: absoluteHref(homeHref, baseUrl)
                },
                ...items.map((item, index) => ({
                  '@type': 'ListItem',
                  position: index + 2,
                  name: item.name,
                  item: absoluteHref(item.href, baseUrl)
                }))
              ]
            })
          }}
        />
      )}
    </div>
  )
}
