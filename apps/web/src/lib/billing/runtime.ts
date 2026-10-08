import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { enqueueEmail } from '../email/server'
import { ordersEnabledFor } from './flags'
import type { BillingDependencies } from './service'
import { type BillingEnv, createBillingDependencies } from './worker-billing'

/**
 * Server-only billing adapter for requests (#68): reads the Worker's bindings and secrets
 * through the OpenNext context. Pages and routes call `ordersEnabled()` before showing or doing
 * anything paid, and `billing()` for the service's dependencies (null while orders are off).
 */

async function workerEnv(): Promise<BillingEnv> {
  const { env } = await getCloudflareContext({ async: true })
  return env as unknown as BillingEnv
}

/** Whether orders are on for this Worker (`ordersEnabledFor`); false when the context fails. */
export async function ordersEnabled(): Promise<boolean> {
  try {
    return ordersEnabledFor(await workerEnv())
  } catch {
    return false
  }
}

/**
 * The billing dependencies for this request, or null while orders are off. Throws when orders
 * are on but billing is misconfigured (no secrets, a key for the wrong mode), so callers answer
 * 503 instead of guessing.
 */
export async function billing(): Promise<BillingDependencies | null> {
  const env = await workerEnv()
  if (!ordersEnabledFor(env)) return null
  return createBillingDependencies({ env, notify: enqueueEmail })
}

/**
 * The Worker's public origin for the provider's return URLs: `BETTER_AUTH_URL` (staging and
 * production set it to this Worker's https origin), else, on a local Worker, the request's own
 * host, so the buyer comes back to the origin their session cookie belongs to.
 */
export async function publicOrigin(request: Request): Promise<string> {
  const env = (await workerEnv()) as BillingEnv & { BETTER_AUTH_URL?: string }
  if (env.BETTER_AUTH_URL) return new URL(env.BETTER_AUTH_URL).origin
  const url = new URL(request.url)
  const host = request.headers.get('host')
  return host ? `${url.protocol}//${host}` : url.origin
}
