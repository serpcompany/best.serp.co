'use client'

import { ErrorContent, type ErrorProps } from '@/components/layout/error-content'

/** Errors in a public page: shown inside the public chrome. */
// biome-ignore lint/suspicious/noShadowRestrictedNames: Next.js requires this component to be named Error
export default function Error(props: ErrorProps) {
  return <ErrorContent {...props} />
}
