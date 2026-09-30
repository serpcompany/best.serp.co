import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createSiteDatabase } from '@serpdirectory/data-ops/client'
import {
  createSubmissionOperations,
  isSubmissionError,
  SubmissionError,
  type SubmissionState
} from '@serpdirectory/data-ops/submissions'
import { resolveRuntimeSiteId } from '@serpdirectory/site-contract'
import type { SubmissionRequest } from '@serpdirectory/web-core/forms/submission-contract'
import type { BadgeVerificationResult } from './badge-verifier'

export { isSubmissionError, SubmissionError }
export type { SubmissionState }

const runtimeEnvironments = new Set(['local', 'preview', 'production'])

async function operations() {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) throw new Error('D1 binding DB is required for submissions.')
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new Error('A valid D1_RUNTIME_ENV is required for submissions.')
  }
  const siteId = resolveRuntimeSiteId({
    NEXT_PUBLIC_SITE_ID: workerEnv.NEXT_PUBLIC_SITE_ID,
    SITE_ID: workerEnv.SITE_ID
  })
  return createSubmissionOperations({
    client: createSiteDatabase(workerEnv.DB, siteId)
  })
}

export async function createSubmission(
  input: SubmissionRequest
): Promise<SubmissionState & { token: string }> {
  return (await operations()).createSubmission(input)
}

export async function consumeSubmissionRateLimit(fingerprint: string): Promise<void> {
  return (await operations()).consumeRateLimit(fingerprint)
}

export async function getSubmission(id: string, token: string): Promise<SubmissionState> {
  return (await operations()).getSubmission(id, token)
}

export async function beginVerification(id: string, token: string): Promise<SubmissionState> {
  return (await operations()).beginVerification(id, token)
}

export async function finishVerification(
  id: string,
  token: string,
  result: BadgeVerificationResult
): Promise<SubmissionState> {
  return (await operations()).finishVerification(id, token, result)
}
