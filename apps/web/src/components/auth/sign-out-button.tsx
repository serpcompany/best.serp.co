'use client'

import { useState } from 'react'
import { signOut } from './sign-in-api'

/**
 * Sign-out for the public header's account menu and mobile menu (serpcompany/best.serp.co#60):
 * `POST /api/auth/sign-out` from this origin, then a full reload so the server renders the
 * signed-out page (and `/account` sends the visitor to `/login`).
 */
export function useSignOut(): [boolean, () => Promise<void>] {
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
