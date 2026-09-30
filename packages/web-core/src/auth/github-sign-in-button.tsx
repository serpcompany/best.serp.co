'use client'

import { SiGithub } from '@icons-pack/react-simple-icons'
import { Button } from '@serpdirectory/design-system/button'
import type { ReactElement } from 'react'

type GitHubSignInButtonProps = {
  callbackUrl: string
  disabled?: boolean
  onSignIn: (callbackUrl: string) => void
}

export function GitHubSignInButton({
  callbackUrl,
  disabled = false,
  onSignIn
}: GitHubSignInButtonProps): ReactElement {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 w-full rounded-none font-bold"
      disabled={disabled}
      onClick={() => {
        onSignIn(callbackUrl)
      }}
    >
      <SiGithub className="size-4" aria-hidden="true" />
      Continue with GitHub
    </Button>
  )
}
