import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CutoverFrozenError,
  hasActiveCutoverLock,
  selectActiveCutoverLockPlan
} from '@serpdirectory/data-ops/cutover-lock'
import {
  buildApproveSubmissionPlans,
  buildRejectSubmissionPlans,
  type SubmissionStatementPlan,
  selectSubmissionForDecisionPlan
} from '@serpdirectory/data-ops/submission-plans'
import { resolveSiteTarget, type SiteTarget } from './site-targets'

interface D1Result {
  results?: Array<Record<string, unknown>>
  success?: boolean
}

interface D1Response {
  errors?: Array<{ message?: string }>
  result?: D1Result[]
  success?: boolean
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

export function validateApprovalContext(env: NodeJS.ProcessEnv): SiteTarget {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Remote submission approval requires GitHub Actions.')
  }
  if (!env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/approve-d1-submission.yml@')) {
    throw new Error('Remote submission approval requires approve-d1-submission.yml.')
  }
  if (env.GITHUB_REF !== 'refs/heads/main' || !env.GITHUB_SHA) {
    throw new Error('Remote submission approval requires reviewed main.')
  }
  const target = resolveSiteTarget(env.DEPLOY_SITE_ID)
  if (env.D1_SUBMISSION_APPROVAL_CONFIRM !== target.confirmation.submission) {
    throw new Error('Explicit production submission approval confirmation is required.')
  }
  return target
}

async function query(
  statements: SubmissionStatementPlan[],
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<D1Result[]> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${required(env, 'CLOUDFLARE_ACCOUNT_ID')}/d1/database/${required(env, 'CLOUDFLARE_D1_PRODUCTION_DATABASE_ID')}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required(env, 'CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        batch: statements.map(statement => ({ sql: statement.sql, params: statement.params }))
      })
    }
  )
  const payload = (await response.json()) as D1Response
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(result => result.success === false)
  ) {
    throw new Error(
      payload.errors
        ?.map(item => item.message)
        .filter(Boolean)
        .join('; ') || `D1 API query failed with status ${response.status}.`
    )
  }
  return payload.result
}

export async function approveRemoteSubmission(
  submissionId: string,
  reviewer: string,
  decision: 'approve' | 'reject' = 'approve',
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<{ idempotent: boolean; listingId: string | null }> {
  const target = validateApprovalContext(env)
  const siteId = target.siteId
  if (!/^[0-9a-f-]{36}$/i.test(submissionId)) throw new Error('Submission ID must be a UUID.')
  if (!reviewer.trim()) throw new Error('Reviewer identity is required.')

  const lock = await query([selectActiveCutoverLockPlan(siteId)], env, fetcher)
  if (hasActiveCutoverLock(lock[0]?.results ?? [])) throw new CutoverFrozenError()

  const selected = await query(
    [selectSubmissionForDecisionPlan(submissionId, siteId)],
    env,
    fetcher
  )
  const row = selected[0]?.results?.[0]
  if (!row) throw new Error('Submission does not exist.')
  if (decision === 'reject') {
    if (row.status === 'rejected') return { idempotent: true, listingId: null }
    if (row.status !== 'pending_badge' && row.status !== 'verified') {
      throw new Error('Only a pending or verified submission can be rejected.')
    }
    const now = new Date().toISOString()
    await query(buildRejectSubmissionPlans({ now, reviewer, siteId, submissionId }), env, fetcher)
    return { idempotent: false, listingId: null }
  }
  const listingId =
    typeof row.listing_id === 'string' ? row.listing_id : `submission_${submissionId}`
  if (row.status === 'approved' && row.listing_id === listingId) {
    return { idempotent: true, listingId }
  }
  if (row.status !== 'verified')
    throw new Error('Only a badge-verified submission can be approved.')
  if (typeof row.version !== 'number' || typeof row.checksum !== 'string') {
    throw new Error('Invalid publication state.')
  }
  const manifestId = `verified-submission-${submissionId}`
  const afterChecksum = createHash('sha256')
    .update(`${row.checksum}\n${manifestId}\n${row.version + 1}`)
    .digest('hex')
  const runId = `submission_publish_${submissionId}`
  const now = new Date().toISOString()

  await query(
    buildApproveSubmissionPlans({
      afterChecksum,
      beforeChecksum: row.checksum,
      listingId,
      manifestId,
      now,
      reviewer,
      runId,
      siteId,
      slug: row.slug as string,
      submissionId,
      version: row.version
    }),
    env,
    fetcher
  )
  return { idempotent: false, listingId }
}

async function main(): Promise<void> {
  const [submissionId, requestedDecision = 'approve'] = process.argv
    .slice(2)
    .filter(value => value !== '--')
  const decision = requestedDecision
  if (!submissionId || (decision !== 'approve' && decision !== 'reject')) {
    throw new Error('Usage: pnpm d1:approve:production -- <submission-id> [approve|reject]')
  }
  console.log(
    JSON.stringify(
      await approveRemoteSubmission(submissionId, process.env.GITHUB_ACTOR || 'unknown', decision)
    )
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
