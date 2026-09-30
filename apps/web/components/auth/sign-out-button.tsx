'use client'

import { SignOutButton as CoreSignOutButton } from '@serpdirectory/web-core/auth/sign-out-button'
import { signOut } from 'next-auth/react'
import type { ReactElement } from 'react'

type SignOutButtonProps = {
  className?: string
}

export function SignOutButton({ className }: SignOutButtonProps): ReactElement {
  return (
    <CoreSignOutButton
      className={className}
      onSignOut={() => {
        void signOut({ callbackUrl: '/' })
      }}
    />
  )
}
