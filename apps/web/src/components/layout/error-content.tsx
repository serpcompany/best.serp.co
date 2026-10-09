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

export type ErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

/** The error page's content; `app/error.tsx` and `app/(site)/error.tsx` place it. */
export function ErrorContent({ error, reset }: ErrorProps) {
  useEffect(() => {
    logger.error(error)
  }, [error])

  return (
    <Empty className="min-h-screen">
      <EmptyHeader>
        <Badge variant="secondary">Error</Badge>
        <EmptyTitle>Something went wrong!</EmptyTitle>
        <EmptyDescription>An unexpected error occurred. Please try again later.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={reset}>Try again</Button>
      </EmptyContent>
    </Empty>
  )
}
