'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle
} from '@/components/ui/navigation-menu'
import { type HeaderItem, headerItems } from './site-links'

const withoutTrailingSlash = (path: string) => path.replace(/\/+$/u, '') || '/'

/** Whether `pathname` is `href` or a page under it, with or without trailing slashes. */
export function isPathWithin(pathname: string, href: string): boolean {
  const path = withoutTrailingSlash(pathname)
  const base = withoutTrailingSlash(href)
  return base === '/' ? path === '/' : path === base || path.startsWith(`${base}/`)
}

function isItemActive(pathname: string, item: HeaderItem): boolean {
  return item.kind === 'link'
    ? isPathWithin(pathname, item.link.href)
    : item.links.some(link => isPathWithin(pathname, link.href))
}

/**
 * The header's navigation (serplists' `SiteNavigationMenu`, #256): a menu opens on hover or
 * click, and its links stay in the HTML while it is closed (`keepMounted`).
 */
export function SiteNavigationMenu({ className }: { className?: string }) {
  const pathname = usePathname()
  return (
    <NavigationMenu aria-label="Site" className={className}>
      <NavigationMenuList>
        {headerItems.map(item =>
          item.kind === 'link' ? (
            <NavigationMenuItem key={item.link.href}>
              <NavigationMenuLink
                active={isItemActive(pathname, item)}
                className={navigationMenuTriggerStyle()}
                render={<Link href={item.link.href} />}
              >
                {item.link.label}
              </NavigationMenuLink>
            </NavigationMenuItem>
          ) : (
            <NavigationMenuItem key={item.label}>
              <NavigationMenuTrigger data-active={isItemActive(pathname, item) ? '' : undefined}>
                {item.label}
              </NavigationMenuTrigger>
              <NavigationMenuContent keepMounted>
                <ul className="grid w-56 gap-1">
                  {item.links.map(link => (
                    <li key={link.href}>
                      <NavigationMenuLink
                        active={isPathWithin(pathname, link.href)}
                        closeOnClick
                        render={<Link href={link.href} />}
                      >
                        {link.label}
                      </NavigationMenuLink>
                    </li>
                  ))}
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
          )
        )}
      </NavigationMenuList>
    </NavigationMenu>
  )
}
