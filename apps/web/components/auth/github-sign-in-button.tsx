'use client'

import { GitHubSignInButton as CoreGitHubSignInButton } from '@serpdirectory/web-core/auth/github-sign-in-button'
import { signIn } from 'next-auth/react'
import type { ReactElement } from 'react'

type GitHubSignInButtonProps = {
  callbackUrl: string
  disabled?: boolean
}

export function GitHubSignInButton({
  callbackUrl,
  disabled = false
}: GitHubSignInButtonProps): ReactElement {
  return (
    <CoreGitHubSignInButton
      callbackUrl={callbackUrl}
      disabled={disabled}
      onSignIn={nextCallbackUrl => {
        void signIn('github', { callbackUrl: nextCallbackUrl })
      }}
    />
  )
}
