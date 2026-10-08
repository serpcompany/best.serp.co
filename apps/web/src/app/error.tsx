'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logging'

type ErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: Next.js requires this component to be named Error
export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    logger.error(error)
  }, [error])

  return (
    <main className="container relative mx-auto flex flex-col items-center justify-center px-4">
      <div className="mx-auto flex h-screen flex-col items-center justify-center">
        <div className="flex h-full flex-col items-center justify-center">
          <span className="not-found rounded-md px-3.5 py-1 text-sm font-medium">Error</span>
          <h1 className="mt-5 text-3xl font-bold md:text-5xl">Something went wrong!</h1>
          <p className="mx-auto mt-5 max-w-xl text-center text-base font-medium text-muted-foreground">
            An unexpected error occurred. Please try again later.
          </p>
          <Button onClick={reset} className="mt-8">
            Try again
          </Button>
        </div>
      </div>
    </main>
  )
}
