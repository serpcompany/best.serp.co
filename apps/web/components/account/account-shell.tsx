'use client'

import { Avatar, AvatarFallback } from '@serpdirectory/design-system/avatar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@serpdirectory/design-system/breadcrumb-primitives'
import { Button } from '@serpdirectory/design-system/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@serpdirectory/design-system/dropdown-menu'
import { Separator } from '@serpdirectory/design-system/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar
} from '@serpdirectory/design-system/sidebar'
import { getRoute } from '@serpdirectory/web-core/routes'
import {
  Box,
  CircleUser,
  EllipsisVertical,
  ExternalLink,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  PlusCircle,
  Settings
} from 'lucide-react'
import Link from 'next/link'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { signOut } from '@/components/auth/sign-in-api'

/**
 * The account dashboard shell from the #70 mockups (screen 5): shadcn dashboard-01, a
 * `Sidebar variant="inset"` that is a Sheet on mobile, a header with the trigger and
 * breadcrumb, and NavUser with sign-out. Only Overview exists until #65 builds the other
 * pages, so their entries are shown but disabled.
 */

export interface AccountUser {
  email: string
  name: string
}

const NAV = [
  { href: getRoute('account'), icon: LayoutDashboard, title: 'Overview' },
  { icon: FileText, title: 'Submissions' },
  { icon: Box, title: 'Listings' },
  { icon: MessageSquare, title: 'Messages' },
  { icon: Settings, title: 'Settings' }
] as const

export function AccountShell({ children, user }: { children: ReactNode; user: AccountUser }) {
  return (
    <SidebarProvider
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 64)',
          '--header-height': 'calc(var(--spacing) * 12)'
        } as CSSProperties
      }
    >
      <AccountSidebar user={user} />
      <SidebarInset>
        <AccountHeader />
        <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}

function SerpMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M 127.62 540.68 C 255.64 429.97 383.70 319.31 511.76 208.65 C 639.74 319.23 767.70 429.86 895.69 540.45 C 895.70 631.71 895.73 722.97 895.64 814.23 C 719.72 662.17 543.76 510.14 367.81 358.10 C 398.86 414.80 429.83 471.54 460.92 528.22 C 349.85 623.79 238.69 719.27 127.67 814.91 C 127.66 723.50 127.67 632.09 127.62 540.68 Z"
      />
    </svg>
  )
}

function AccountSidebar({ user }: { user: AccountUser }) {
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
              <Link href={getRoute('account')}>
                <SerpMark className="!size-5" />
                <span className="text-base font-semibold">SERP</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="flex items-center gap-2">
                <SidebarMenuButton
                  asChild
                  tooltip="Submit a product"
                  className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                >
                  <Link href={getRoute('submit')}>
                    <PlusCircle />
                    <span>Submit a product</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Account</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(item => (
                <SidebarMenuItem key={item.title}>
                  {'href' in item ? (
                    <SidebarMenuButton asChild isActive tooltip={item.title}>
                      <Link href={item.href} aria-current="page">
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton aria-disabled="true" tooltip={`${item.title} (coming soon)`}>
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href={getRoute('home')}>
                    <ExternalLink />
                    <span>View best.serp.co</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href={getRoute('contact')}>
                    <MessageSquare />
                    <span>Message us</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}

/** Two letters for the avatar: from the name, else from the address. */
export function initials({ email, name }: AccountUser): string {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}`.toUpperCase()
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

function UserSummary({ user }: { user: AccountUser }) {
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

function NavUser({ user }: { user: AccountUser }) {
  const { isMobile } = useSidebar()
  const [pending, setPending] = useState(false)

  async function onSignOut() {
    setPending(true)
    await signOut()
    window.location.assign(getRoute('home'))
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <UserSummary user={user} />
              <EllipsisVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <UserSummary user={user} />
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled>
                <CircleUser />
                Account settings
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={getRoute('home')}>
                  <ExternalLink />
                  View best.serp.co
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending}
              onSelect={event => {
                event.preventDefault()
                void onSignOut()
              }}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function AccountHeader() {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={getRoute('account')}>Account</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Overview</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" asChild size="sm" className="hidden sm:flex">
            <Link href={getRoute('home')}>
              View site
              <ExternalLink />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
