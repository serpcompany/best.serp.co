'use client'

import { Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useState } from 'react'
import { useSignOut } from '@/components/auth/sign-out-button'
import { Button, buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { HeaderAuthState } from '@/lib/auth/header-auth-state'
import { cn } from '@/lib/utils'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { siteCopy } from '../../lib/site/site-copy'
import { headerItems, type SiteLink } from './site-links'
import { isPathWithin } from './site-navigation-menu'
import { ThemeToggle } from './theme-toggle'

type MenuLinkProps = { link: SiteLink; onNavigate: () => void; pathname: string }

function MobileMenuLink({ link, onNavigate, pathname }: MenuLinkProps) {
  const active = isPathWithin(pathname, link.href)
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(buttonVariants({ variant: active ? 'secondary' : 'ghost' }), 'justify-start')}
    >
      {link.label}
    </Link>
  )
}

function MobileMenuGroup({
  label,
  links,
  ...linkProps
}: { label: string; links: readonly SiteLink[] } & Omit<MenuLinkProps, 'link'>) {
  const labelId = useId()
  return (
    <div className="flex flex-col gap-1">
      <p id={labelId} className="px-2.5 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col gap-1">
        {links.map(link => (
          <li key={link.href} className="flex flex-col">
            <MobileMenuLink link={link} {...linkProps} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Open until the visitor goes to another page. */
function useOpenUntilPathnameChanges(pathname: string) {
  const [open, setOpen] = useState(false)
  const [shownPathname, setShownPathname] = useState(pathname)
  if (shownPathname !== pathname) {
    setShownPathname(pathname)
    setOpen(false)
  }
  return [open, setOpen] as const
}

/**
 * The header's menu on phones (serplists' `PublicMobileNav`, #256): a Sheet from the left with
 * the header's links, the theme toggle, and the account and submit actions.
 */
export function SiteMobileNav({ authState }: { authState: HeaderAuthState }) {
  const pathname = usePathname()
  const [open, setOpen] = useOpenUntilPathnameChanges(pathname)
  const [signingOut, signOut] = useSignOut()
  const close = () => setOpen(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button className="-ml-2 md:hidden" size="icon" variant="ghost" />}>
        <Menu />
        <span className="sr-only">Open menu</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-72">
        <SheetHeader>
          <SheetTitle>{siteConfig.name}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <nav aria-label="Site" className="flex flex-col gap-4">
            {headerItems.map(item =>
              item.kind === 'menu' ? (
                <MobileMenuGroup
                  key={item.label}
                  label={item.label}
                  links={item.links}
                  onNavigate={close}
                  pathname={pathname}
                />
              ) : (
                <MobileMenuLink
                  key={item.link.href}
                  link={item.link}
                  onNavigate={close}
                  pathname={pathname}
                />
              )
            )}
          </nav>
          <Separator />
          <ThemeToggle />
          <div className="flex flex-col gap-2">
            {authState.isAuthenticated ? (
              <>
                <Link
                  href={getRoute('account')}
                  onClick={close}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  Account
                </Link>
                <Button variant="outline" disabled={signingOut} onClick={signOut}>
                  Sign out
                </Button>
              </>
            ) : authState.isConfigured ? (
              <Link
                href={getRoute('login')}
                onClick={close}
                className={buttonVariants({ variant: 'outline' })}
              >
                Sign up / Sign in
              </Link>
            ) : null}
            <Link href={getRoute('submit')} onClick={close} className={buttonVariants()}>
              {siteCopy.submitLabel}
            </Link>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
