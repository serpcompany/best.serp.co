'use client'

import { CheckCircle, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { getRoute } from '../routes'

type VerifyState = 'idle' | 'loading' | 'success' | 'error'

interface VerifyButtonProps {
  token: string
  verifyEndpoint: string
}

export function VerifyButton({ token, verifyEndpoint }: VerifyButtonProps) {
  const [state, setState] = useState<VerifyState>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [slug, setSlug] = useState('')

  async function handleVerify() {
    setState('loading')

    try {
      const response = await fetch(verifyEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      const data = (await response.json()) as {
        message?: string
        slug?: string
        verified?: boolean
      }

      if (response.ok && data.verified) {
        setSlug(data.slug ?? '')
        setState('success')
        return
      }

      setErrorMessage(data.message ?? 'Verification failed.')
      setState('error')
    } catch {
      setErrorMessage('An unexpected error occurred. Please try again.')
      setState('error')
    }
  }

  if (state === 'success') {
    return (
      <div className="space-y-3 rounded-md bg-emerald-50 px-4 py-3 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <div className="flex items-center gap-2">
          <CheckCircle className="size-5 shrink-0" />
          <span>Verified! Your listing is live.</span>
        </div>
        {slug ? (
          <Link
            href={getRoute('listing.detail', { slug })}
            className="block text-sm font-medium underline underline-offset-2 hover:opacity-80"
          >
            View your listing →
          </Link>
        ) : null}
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="space-y-3">
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          <p className="font-medium">Verification failed</p>
          <p>{errorMessage}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Make sure the badge is visible on your homepage and the{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            data-verify-token
          </code>{' '}
          attribute matches exactly. Then try again.
        </p>
        <button
          type="button"
          onClick={handleVerify}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleVerify}
      disabled={state === 'loading'}
      className="flex items-center gap-2 rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {state === 'loading' ? <Loader2 className="size-4 animate-spin" /> : null}
      {state === 'loading' ? 'Verifying…' : '✓ Verify & Publish'}
    </button>
  )
}
