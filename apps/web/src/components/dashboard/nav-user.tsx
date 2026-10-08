'use client'

import { EllipsisVertical, LogOut, type LucideIcon } from 'lucide-react'
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
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'

export interface DashboardUser {
  email: string
  name: string
}

export interface DashboardUserLink {
  title: string
  href: string
  icon: LucideIcon
}

/** Two letters for the avatar: from the name, else from the address. */
export function initials({ email, name }: DashboardUser): string {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}`.toUpperCase()
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

function UserSummary({ user }: { user: DashboardUser }) {
  const name = user.name.trim()
  return (
    <>
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials(user)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{name || user.email}</span>
        {name ? <span className="truncate text-xs text-muted-foreground">{user.email}</span> : null}
      </div>
    </>
  )
}

/**
 * dashboard-01's NavUser: the signed-in user at the foot of the sidebar, opening a menu with
 * `links` and Sign out.
 */
export function NavUser({
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
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <UserSummary user={user} />
            <EllipsisVertical className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            {/* Base UI requires a group label to sit in its group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <UserSummary user={user} />
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {links.length > 0 ? (
              <>
                <DropdownMenuGroup>
                  {links.map(link => (
                    <DropdownMenuItem key={link.title} render={<Link href={link.href} />}>
                      <link.icon />
                      {link.title}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem disabled={signingOut} closeOnClick={false} onClick={onSignOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
