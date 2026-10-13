import * as Sentry from '@sentry/nextjs'
import { browserEnvironment, browserSentryOptions } from './lib/telemetry/sentry'

// Starts Sentry in the browser (#48); it stays off without a DSN.
Sentry.init(browserSentryOptions(() => browserEnvironment(window.location.hostname)))

/** Lets Sentry follow client-side navigations; it records nothing while tracing is off. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
