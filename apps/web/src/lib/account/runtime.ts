import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { cache } from 'react'
import { type AccountOperations, createAccountOperations } from '@/db/account'
import { createDatabase } from '@/db/client'

/**
 * Server-only adapter for the submitter dashboard (serpcompany/best.serp.co#65): it validates
 * the Worker's `DB` binding and `D1_RUNTIME_ENV` and hands back the account operations, which
 * scope every read and write to the signed-in user in SQL. All SQL lives in
 * `@/db/account`.
 */

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

export const accountOperations = cache(async (): Promise<AccountOperations> => {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) throw new Error('D1 binding DB is required for the account.')
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new Error('A valid D1_RUNTIME_ENV is required for the account.')
  }
  return createAccountOperations({
    // Logos must be https, except on a local Worker, whose e2e fixture sites are http.
    allowInsecureLogos:
      workerEnv.D1_RUNTIME_ENV === 'local' && workerEnv.SITE_ENVIRONMENT === 'local',
    client: createDatabase(workerEnv.DB)
  })
})
