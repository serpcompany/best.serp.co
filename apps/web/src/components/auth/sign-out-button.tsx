'use client'

import { useState } from 'react'
import {
  DirectoryNavigationItem,
  directoryNavigationInteractiveClassName
} from '@/components/layout/directory-navigation'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { signOut } from './sign-in-api'

/**
 * Sign-out controls for the public header (serpcompany/best.serp.co#60): `POST
 * /api/auth/sign-out` from this origin, then a full reload so the server renders the
 * signed-out page (and `/account` sends the visitor to `/login`).
 */

function useSignOut(): [boolean, () => Promise<void>] {
  const [pending, setPending] = useState(false)
  return [
    pending,
    async () => {
      setPending(true)
      await signOut()
      window.location.reload()
    }
  ]
}

/** The desktop header's "Sign out", next to "Account" (#70 public layout). */
export function HeaderSignOutButton() {
  const [pending, onSignOut] = useSignOut()
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={pending}
      onClick={onSignOut}
      className="hidden sm:inline-flex items-center text-sm font-bold h-9 px-4 hover:bg-accent shadow-none"
    >
      Sign out
    </Button>
  )
}

/** The mobile drawer's "Sign out", styled like its other navigation items. */
export function DrawerSignOutButton() {
  const [pending, onSignOut] = useSignOut()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onSignOut}
      className={cn(directoryNavigationInteractiveClassName, 'w-full text-left')}
    >
      <DirectoryNavigationItem className="py-1.5">Sign out</DirectoryNavigationItem>
    </button>
  )
}
