import * as Sentry from '@sentry/nextjs'
import { browserEnvironment, sentryOptions } from './lib/telemetry/sentry'

// Starts Sentry in the browser (#48); it stays off without a DSN. Errors only: no session per
// page view (release health), so the default BrowserSession integration is left out.
Sentry.init({
  ...sentryOptions(() => browserEnvironment(window.location.hostname)),
  integrations: defaults => defaults.filter(integration => integration.name !== 'BrowserSession')
})

/** Lets Sentry follow client-side navigations; it records nothing while tracing is off. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
