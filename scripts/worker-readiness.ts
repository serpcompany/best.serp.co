/**
 * Waits until the Worker a deploy just released is ready on an origin, before Deploy Staging's
 * Playwright smoke runs against it (#417).
 *
 *   pnpm tsx scripts/worker-readiness.ts <https-origin>
 *
 * The version is the one the deploy step recorded: `EXPECTED_WORKER_VERSION`, or the `deploy`
 * entry Wrangler wrote to `WRANGLER_OUTPUT_FILE_PATH`. Without one it fails, since any version
 * would pass. Ready means five probes of `/robots.txt` in a row, sent with the smoke-test header
 * 2 s apart, answered 200 by that version in under 2 s, within 3 minutes
 * (`waitForWorkerReadiness`); every probe's time is logged. The HTTP gates wait the same way
 * after the deploy with three in a row; this wait runs again just before the smoke, which asks
 * more of the runner's path: dozens of browser connections for a minute or more.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expectedWorkerVersionFromEnvironment,
  type ReadinessOptions,
  waitForWorkerReadiness
} from './d1-preview-http-gates'

/** Ready answers in a row the smoke waits for. */
export const smokeReadinessConfirmations = 5

function parseOrigin(value: string): URL {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error(`Worker readiness needs an HTTPS origin, not ${JSON.stringify(value)}.`)
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      'Worker readiness needs a clean HTTPS origin with no credentials, port, path, query, or hash.'
    )
  return origin
}

/** Waits for the deployed version named in `env` to be ready on `originValue`. */
export async function workerReadiness(
  originValue: string | undefined,
  env: Partial<NodeJS.ProcessEnv>,
  options: Omit<ReadinessOptions, 'confirmations'> = {}
): Promise<void> {
  if (!originValue) throw new Error('Usage: worker-readiness.ts <https-origin>')
  const origin = parseOrigin(originValue)
  const expectedVersion = expectedWorkerVersionFromEnvironment(env)
  if (!expectedVersion)
    throw new Error(
      'Worker readiness needs the deployed version: set EXPECTED_WORKER_VERSION, or WRANGLER_OUTPUT_FILE_PATH as the deploy step did.'
    )
  await waitForWorkerReadiness(origin, expectedVersion, {
    ...options,
    confirmations: smokeReadinessConfirmations
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void workerReadiness(process.argv[2], process.env).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
