// The build output `worker.ts` wires in (#165): OpenNext's handler and Durable Object classes,
// and Next's routes manifest. They exist only after `opennextjs-cloudflare build`, so they are
// imported here, in plain JS, and typed by `worker-build-output.d.ts`: `worker.ts` then
// typechecks without a build.
import routesManifest from './.next/routes-manifest.json'

export {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
  default
} from './.open-next/worker.js'
export { routesManifest }
