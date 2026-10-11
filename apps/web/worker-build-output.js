// The build output `worker.ts` wires in (#165): OpenNext's handler and Durable Object classes,
// Next's routes manifest, and the build's Sentry DSN and commit (#210,
// `scripts/worker-sentry-build.ts`). They exist only after `pnpm worker:build`, so they are
// imported here, in plain JS, and typed by `worker-build-output.d.ts`: `worker.ts` then
// typechecks without a build.
import routesManifest from './.next/routes-manifest.json'
import workerSentryBuild from './.open-next/worker-sentry.json'

export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
  default
} from './.open-next/worker.js'
export { routesManifest, workerSentryBuild }
