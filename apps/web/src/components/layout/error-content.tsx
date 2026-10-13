'use client'

import { useEffect } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@/components/ui/empty'
import { logger } from '@/lib/logging'
import { reportedByServer } from '@/lib/telemetry/server-errors'

export type ErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

/** Reports the error the page caught, unless the server already reported it (#401). */
export function reportPageError(error: ErrorProps['error'], pathname: string): void {
  if (reportedByServer(error, pathname)) return
  logger.error(error)
}

/** The error page's content; `app/error.tsx` and `app/(site)/error.tsx` place it. */
export function ErrorContent({ error, reset }: ErrorProps) {
  useEffect(() => {
    reportPageError(error, window.location.pathname)
  }, [error])

  return (
    <Empty className="min-h-screen">
      <EmptyHeader>
        <Badge variant="secondary">Error</Badge>
        <EmptyTitle>
          <h1>Something went wrong!</h1>
        </EmptyTitle>
        <EmptyDescription>An unexpected error occurred. Please try again later.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={reset}>Try again</Button>
      </EmptyContent>
    </Empty>
  )
}
