'use client'

import { LogOutIcon, UserRoundIcon } from 'lucide-react'
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
import { getRoute } from '../../lib/routing/routes'

/** The signed-in visitor's menu in the header (zenbujapanese.com's `account-menu.tsx`, #256). */
export function AccountMenu({ className }: { className?: string }) {
  const [signingOut, signOut] = useSignOut()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" className={className} />}>
        <UserRoundIcon aria-hidden="true" />
        <span className="sr-only">Account</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem render={<Link href={getRoute('account')} />}>
          <UserRoundIcon aria-hidden="true" />
          Account
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signingOut} onClick={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
