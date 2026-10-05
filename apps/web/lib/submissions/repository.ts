import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createDatabase } from '@serpdirectory/data-ops/client'
import {
  createSubmissionOperations,
  type DraftContent,
  isSubmissionError,
  type NewDraftInput,
  type OwnSubmission,
  SubmissionError,
  type SubmissionVerificationResult,
  type UrlAvailability
} from '@serpdirectory/data-ops/submissions'

/**
 * Server-only adapter for native submissions (serpcompany/best.serp.co#63): it validates the
 * Worker's `DB` binding and `D1_RUNTIME_ENV` and delegates every read and write to
 * `@serpdirectory/data-ops/submissions`, scoped to the signed-in owner.
 */

export { isSubmissionError, SubmissionError }
export type { DraftContent, NewDraftInput, OwnSubmission, UrlAvailability }

const runtimeEnvironments = new Set(['local', 'staging', 'production'])

async function operations() {
  const { env } = await getCloudflareContext({ async: true })
  const workerEnv = env as CloudflareEnv
  if (!workerEnv.DB) throw new Error('D1 binding DB is required for submissions.')
  if (!runtimeEnvironments.has(workerEnv.D1_RUNTIME_ENV)) {
    throw new Error('A valid D1_RUNTIME_ENV is required for submissions.')
  }
  return createSubmissionOperations({
    client: createDatabase(workerEnv.DB)
  })
}

export async function checkSubmissionUrl(
  website: string,
  ownerUserId: string | null
): Promise<UrlAvailability> {
  return (await operations()).checkUrl(website, ownerUserId)
}

export async function consumeSubmissionRateLimit(fingerprint: string): Promise<void> {
  return (await operations()).consumeRateLimit(fingerprint)
}

export async function createDraft(
  ownerUserId: string,
  submission: NewDraftInput
): Promise<OwnSubmission> {
  return (await operations()).createDraft({ ownerUserId, submission })
}

export async function updateDraft(input: {
  content: DraftContent
  expectedContentVersion: number
  ownerUserId: string
  submissionId: string
}): Promise<OwnSubmission> {
  return (await operations()).updateDraft(input)
}

export async function getOwnSubmission(
  id: string,
  ownerUserId: string
): Promise<OwnSubmission | null> {
  return (await operations()).getOwnSubmission(id, ownerUserId)
}

export async function listOwnSubmissions(ownerUserId: string): Promise<OwnSubmission[]> {
  return (await operations()).listOwnSubmissions(ownerUserId)
}

export async function chooseFreePlan(id: string, ownerUserId: string): Promise<OwnSubmission> {
  return (await operations()).chooseFreePlan(id, ownerUserId)
}

export async function beginVerification(id: string, ownerUserId: string): Promise<OwnSubmission> {
  return (await operations()).beginVerification(id, ownerUserId)
}

export async function finishVerification(
  id: string,
  ownerUserId: string,
  result: SubmissionVerificationResult
): Promise<OwnSubmission> {
  return (await operations()).finishVerification(id, ownerUserId, result)
}
