'use client'

import { ChevronsUpDown, LogOut } from 'lucide-react'
import Link from 'next/link'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'

export interface DashboardUser {
  email: string
  name: string
}

export interface DashboardUserLink {
  title: string
  href: string
}

/** serplists' `useUserInitial`: the name's first letter, else the address's. */
export function userInitial({ email, name }: DashboardUser): string {
  return (name.trim().charAt(0) || email.charAt(0)).toUpperCase()
}

/**
 * serplists' `SidebarAccountMenu` (`AccountMenu.tsx`): the signed-in user at the foot of the
 * sidebar, opening a menu with their name and address, `links`, and Sign out. A user without a
 * name shows their address in its place.
 */
export function SidebarAccountMenu({
  user,
  links = [],
  onSignOut,
  signingOut = false
}: {
  user: DashboardUser
  links?: readonly DashboardUserLink[]
  onSignOut: () => void
  signingOut?: boolean
}) {
  const { isMobile } = useSidebar()
  const name = user.name.trim()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            aria-label="Account menu"
            size="lg"
            className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
          />
        }
      >
        <Avatar size="sm">
          <AvatarFallback>{userInitial(user)}</AvatarFallback>
        </Avatar>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate font-medium">{name || user.email}</span>
          {name ? (
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          ) : null}
        </span>
        <ChevronsUpDown className="ml-auto" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        side={isMobile ? 'bottom' : 'right'}
        sideOffset={8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="truncate text-sm font-medium text-popover-foreground">
              {name || user.email}
            </span>
            {name ? (
              <span className="truncate text-sm font-normal text-muted-foreground">
                {user.email}
              </span>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {links.length > 0 ? (
          <>
            <DropdownMenuGroup>
              {links.map(link => (
                <DropdownMenuItem key={link.href} render={<Link href={link.href} />}>
                  {link.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {/* Kept open while signing out, so the disabled item says so until the page leaves. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={signingOut}
          closeOnClick={false}
          onClick={onSignOut}
        >
          <LogOut />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
