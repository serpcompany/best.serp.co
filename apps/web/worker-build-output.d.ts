/** Types for `worker-build-output.js`: the parts of the build output `worker.ts` relies on. */
/** The parts of the Workers execution context this Worker and OpenNext use. */
export interface WorkerExecutionContext {
  passThroughOnException(): void
  waitUntil(promise: Promise<unknown>): void
}

declare const openNextWorker: {
  fetch(request: Request, env: unknown, context: WorkerExecutionContext): Promise<Response>
}
export default openNextWorker

/** Next's `.next/routes-manifest.json`; `configRedirectPatterns` validates its shape. */
export const routesManifest: unknown

/** The build's Sentry DSN and commit (`.open-next/worker-sentry.json`, #210); unset stays unset. */
export const workerSentryBuild: { commit?: string; dsn?: string }

// OpenNext's Durable Object classes, which the Worker must export by name.
export const BucketCachePurge: unknown
export const DOQueueHandler: unknown
export const DOShardedTagCache: unknown
