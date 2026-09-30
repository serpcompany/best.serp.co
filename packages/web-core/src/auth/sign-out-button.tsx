'use client'

import { Button } from '@serpdirectory/design-system/button'
import type { ReactElement } from 'react'

type SignOutButtonProps = {
  className?: string
  onSignOut: () => void
}

export function SignOutButton({ className, onSignOut }: SignOutButtonProps): ReactElement {
  return (
    <Button type="button" variant="ghost" className={className} onClick={onSignOut}>
      Sign out
    </Button>
  )
}
