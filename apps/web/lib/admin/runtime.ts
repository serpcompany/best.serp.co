import 'server-only'

/**
 * Server-only admin adapter (serpcompany/best.serp.co#64): acquires and validates the `DB`
 * binding and builds the admin reads and the decision context for one request. The caller has
 * already authorized an admin (`requireAdmin()` or `authorizeAdminRequest()`); the admin's email
 * is the actor recorded on every decision. All SQL lives in `@serpdirectory/data-ops`.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare'
import {
  type AdminReadOperations,
  createAdminReadOperations
} from '@serpdirectory/data-ops/admin-queries'
import { createDatabase, type Database } from '@serpdirectory/data-ops/client'
import { cache } from 'react'
import { emailEventKey, enqueueEmail } from '../email/server'
import { createMediaHost } from '../media/worker-media'
import type { AdminContext } from './decisions'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

async function adminDatabase(): Promise<Database> {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) throw new Error('D1 binding DB is required for the admin panel.')
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new Error('A valid D1_RUNTIME_ENV is required for the admin panel.')
  }
  return createDatabase(workerEnv.DB)
}

/** The admin reads for this request (pages call it after `requireAdmin()`). */
export const getAdminReads = cache(
  async (): Promise<AdminReadOperations> =>
    createAdminReadOperations({ client: await adminDatabase() })
)

/**
 * The decision context for an authorized admin. Refunds stay unavailable until #68 provides the
 * payment provider's refund hook.
 */
export async function adminDecisionContext(actor: string): Promise<AdminContext> {
  const { ctx, env } = await getCloudflareContext({ async: true })
  return {
    actor: actor.trim().toLowerCase(),
    client: await adminDatabase(),
    eventKey: emailEventKey,
    // A changed logo is hosted in the environment's media bucket; an approval's queued copies
    // are hosted after the response (#95).
    media: createMediaHost(env as CloudflareEnv, task => ctx.waitUntil(task)),
    notify: enqueueEmail
  }
}
