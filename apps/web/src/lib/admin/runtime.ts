import 'server-only'

/**
 * Server-only admin adapter (serpcompany/best.serp.co#64): acquires and validates the `DB`
 * binding and builds the admin reads and the decision context for one request. The caller has
 * already authorized an admin (`requireAdmin()` or `authorizeAdminRequest()`, or, for the account
 * layout's review queue count, `getSessionAdmin()`); the admin's email is the actor recorded on
 * every decision. All SQL lives in `@/db`.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { cache } from 'react'
import { type AdminReadOperations, createAdminReadOperations } from '@/db/admin-queries'
import { type AdminOrderRow, createBillingOperations } from '@/db/billing'
import { createDatabase, type Database } from '@/db/client'
import { billing } from '../billing/runtime'
import { previewRefund, refundOrder, refundRejectedSubmission } from '../billing/service'
import { deliverEmail, emailEventKey } from '../email/server'
import { createMediaHost } from '../media/worker-media'
import { CodedError } from '../telemetry/coded-error'
import type { AdminContext } from './decisions'

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

async function adminDatabase(): Promise<Database> {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) {
    throw new CodedError('d1_binding_missing', 'D1 binding DB is required for the admin panel.')
  }
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new CodedError(
      'd1_runtime_env_invalid',
      'A valid D1_RUNTIME_ENV is required for the admin panel.'
    )
  }
  return createDatabase(workerEnv.DB)
}

/**
 * The admin reads for this request. Admin pages call it after `requireAdmin()`; the account
 * layout calls it after `getSessionAdmin()`, for the review queue count (#489).
 */
export const getAdminReads = cache(
  async (): Promise<AdminReadOperations> =>
    createAdminReadOperations({ client: await adminDatabase() })
)

/** The Orders screen's rows (#68), newest first. */
export async function getAdminOrders(): Promise<AdminOrderRow[]> {
  return createBillingOperations({ client: await adminDatabase() }).adminOrders()
}

/** Billing for refunds (#68), or null while orders are off or billing is misconfigured. */
async function adminBilling() {
  try {
    return await billing()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'billing_unavailable',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return null
  }
}

/**
 * The decision context for an authorized admin. Refunds (a rejection tagged `other`, and the
 * Orders screen) are available while orders are on and billing is configured (#68). A decision
 * waits for its email's delivery, so it can answer what the email did (#490).
 */
export async function adminDecisionContext(actor: string): Promise<AdminContext> {
  const { ctx, env } = await getCloudflareContext({ async: true })
  const deps = await adminBilling()
  return {
    actor: actor.trim().toLowerCase(),
    client: await adminDatabase(),
    eventKey: emailEventKey,
    // A changed logo is hosted in the environment's media bucket; an approval's queued copies
    // are hosted after the response (#95).
    media: createMediaHost(env as CloudflareEnv, task => ctx.waitUntil(task)),
    notify: deliverEmail,
    ...(deps
      ? {
          billing: {
            previewRefund: input => previewRefund(deps, input),
            refundOrder: input => refundOrder(deps, input)
          },
          refunds: {
            refundRejectedSubmission: ({ notify, ...input }) =>
              refundRejectedSubmission(
                {
                  ...deps,
                  notify: async (templateId, request) => {
                    await notify(templateId, request)
                  }
                },
                input
              )
          }
        }
      : {})
  }
}
