/**
 * Reports the error `app/global-error.tsx` caught, in the browser (#48, #355).
 *
 * The SDK is imported here, not at the top of that component: every page's server render loads
 * the component, and a static import would load the Sentry server SDK with it. In the browser
 * the import reaches the SDK that `instrumentation-client.ts` already started.
 *
 * The import can fail where a static one couldn't: the visitor is offline, or a tab outlived a
 * deploy and the chunk is gone. The error is then rethrown outside React, so that SDK's global
 * error handler still reports it.
 */
export function reportGlobalError(
  error: unknown,
  loadSdk: () => Promise<{ captureException: (error: unknown) => unknown }> = () =>
    import('@sentry/nextjs')
): Promise<void> {
  return loadSdk().then(
    ({ captureException }) => {
      captureException(error)
    },
    () => {
      setTimeout(() => {
        throw error
      })
    }
  )
}
