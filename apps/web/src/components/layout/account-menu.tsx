'use client'

import { LogInIcon, LogOutIcon, UserRoundIcon } from 'lucide-react'
import Link from 'next/link'
import { useSignOut } from '@/components/auth/sign-out-button'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { HeaderAuthState } from '@/lib/auth/header-auth-state'
import { cn } from '@/lib/utils'
import { getRoute } from '../../lib/routing/routes'
import { ThemeMenuRow } from './theme-toggle'

/**
 * The header's account button (zenbujapanese.com's `account-menu.tsx`, #286): a round button
 * whose menu offers sign-in, or the account and sign-out once signed in, with the theme row.
 */
export function AccountMenu({
  authState,
  className
}: {
  authState: HeaderAuthState
  className?: string
}) {
  const [signingOut, signOut] = useSignOut()
  const signedIn = Boolean(authState.isAuthenticated)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon-lg" className={cn('rounded-full', className)} />
        }
      >
        <UserRoundIcon aria-hidden="true" />
        <span className="sr-only">Account</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {signedIn ? (
          <>
            <DropdownMenuItem render={<Link href={getRoute('account')} />}>
              <UserRoundIcon aria-hidden="true" />
              Account
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : authState.isConfigured ? (
          <>
            <DropdownMenuItem render={<Link href={getRoute('login')} />}>
              <LogInIcon aria-hidden="true" />
              Sign up / Sign in
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <ThemeMenuRow />
        {signedIn ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} onClick={() => void signOut()}>
              <LogOutIcon aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
