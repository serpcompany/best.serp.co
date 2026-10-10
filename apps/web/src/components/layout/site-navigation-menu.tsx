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
import { type HeaderItem, isCurrentPage, isMenuActive } from './site-links'

/**
 * The header's navigation (serplists' `SiteNavigationMenu`, #256): a menu opens on hover or
 * click, and its links stay in the HTML while it is closed (`keepMounted`).
 */
export function SiteNavigationMenu({
  className,
  items
}: {
  className?: string
  /** `headerItems()`, built on the server (#347). */
  items: readonly HeaderItem[]
}) {
  const pathname = usePathname()
  return (
    <NavigationMenu aria-label="Site" className={className}>
      <NavigationMenuList>
        {items.map(item =>
          item.kind === 'link' ? (
            <NavigationMenuItem key={item.link.href}>
              <NavigationMenuLink
                active={isCurrentPage(pathname, item.link.href)}
                className={navigationMenuTriggerStyle()}
                render={<Link href={item.link.href} />}
              >
                {item.link.label}
              </NavigationMenuLink>
            </NavigationMenuItem>
          ) : (
            <NavigationMenuItem key={item.label}>
              <NavigationMenuTrigger
                className="data-active:bg-muted/50"
                data-active={isMenuActive(pathname, item) ? '' : undefined}
              >
                {item.label}
              </NavigationMenuTrigger>
              <NavigationMenuContent keepMounted>
                <ul className="grid w-56 gap-1">
                  {item.links.map(link => (
                    <li key={link.href}>
                      <NavigationMenuLink
                        active={isCurrentPage(pathname, link.href)}
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
