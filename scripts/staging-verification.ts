/**
 * Staging before production: proves that Deploy Staging migrated, deployed, HTTP-gated, and
 * smoke-tested the exact commit a production release is about to ship.
 *
 *   GITHUB_TOKEN=<token with actions: read> pnpm tsx scripts/staging-verification.ts [<sha>]
 *
 * The commit defaults to GITHUB_SHA. Read-only: it asks the GitHub Actions API for the
 * `deploy-staging.yml` runs on main whose head is that commit, and accepts the commit when any
 * attempt of any of those runs completed the staging migration, deploy, HTTP gate, and
 * Playwright smoke steps successfully. A green attempt that skipped those steps (for example,
 * before the staging credentials existed) does not count.
 *
 * Verification is monotonic on purpose: once an attempt has proven the commit on staging, a
 * later attempt or run of the same commit (a re-run in progress, a flaky smoke test, a revoked
 * staging token, or an older commit replayed over a newer staging schema) does not withdraw
 * that proof. Those later failures describe the staging environment, not the commit, and a
 * non-monotonic rule could let `migrate production` pass and `deploy production` refuse
 * within one release.
 *
 * deploy-production.yml and bootstrap-production-d1.yml run it before reviewer approval, and
 * `cloudflare-release.ts` repeats it before every production migration, import, and Worker
 * deploy.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { project } from './project'

/** The staging workflow whose verified run a production release requires. */
export const stagingWorkflow = {
  branch: 'main',
  file: 'deploy-staging.yml',
  name: 'Deploy Staging',
  /** Steps of the staging job that must all have succeeded for the commit to count as verified. */
  requiredSteps: [
    'Apply staging D1 migrations',
    'Deploy staging Worker',
    'Run staging HTTP gates',
    'Run Playwright smoke against staging'
  ]
} as const

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>

interface WorkflowRun {
  conclusion?: string | null
  head_branch?: string | null
  head_sha?: string
  html_url?: string
  id?: number
  path?: string
  run_attempt?: number
  status?: string | null
}

interface WorkflowJob {
  conclusion?: string | null
  name?: string
  steps?: Array<{ conclusion?: string | null; name?: string }>
}

export interface StagingVerification {
  runAttempt: number
  runId: number
  runUrl: string
  sha: string
}

export interface StagingVerificationOptions {
  apiUrl?: string
  fetch?: FetchLike
  sha: string | undefined
  token: string | undefined
}

/** True when the job succeeded and every required staging step ran and succeeded. */
function isVerifiedStagingJob(job: WorkflowJob): boolean {
  return (
    job.conclusion === 'success' &&
    stagingWorkflow.requiredSteps.every(name =>
      job.steps?.some(step => step.name === name && step.conclusion === 'success')
    )
  )
}

/** The remediation every refusal ends with. */
const rerunHint = `Start a new run for the head of ${stagingWorkflow.branch} with \`gh workflow run ${stagingWorkflow.file} --ref ${stagingWorkflow.branch}\` (or wait for the push-triggered run), let it finish, then dispatch the production workflow again. See docs/DEPLOY_RUNBOOK.md#staging-before-production.`

/**
 * Resolves with the newest run attempt of Deploy Staging that verified `sha`, or throws a
 * remediation message when none did.
 */
export async function assertStagingVerified(
  options: StagingVerificationOptions
): Promise<StagingVerification> {
  const { sha, token } = options
  if (!sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error('Staging verification needs the full 40-character commit SHA being released.')
  }
  if (!token) {
    throw new Error(
      `GITHUB_TOKEN (with actions: read) is required to prove that ${stagingWorkflow.name} verified ${sha}.`
    )
  }
  const request = options.fetch ?? fetch
  const base = (options.apiUrl || 'https://api.github.com').replace(/\/+$/u, '')
  const get = async (path: string, parameters: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${base}/repos/${project.repository}/${path}`)
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value)
    const response = await request(url.toString(), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': `${project.domain}-release`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(
        `GitHub API ${path} returned HTTP ${response.status}; the token needs actions: read on ${project.repository}.`
      )
    }
    return response.json()
  }

  const workflowPath = `.github/workflows/${stagingWorkflow.file}`
  // Every run of the commit, whatever its current attempt's outcome: an earlier attempt may
  // have verified it even when a later re-run is in progress or failed.
  const listed = (await get(`actions/workflows/${stagingWorkflow.file}/runs`, {
    branch: stagingWorkflow.branch,
    head_sha: sha,
    per_page: '100'
  })) as { workflow_runs?: WorkflowRun[] }
  const runs = (listed.workflow_runs ?? [])
    .filter(
      run =>
        run.head_sha === sha &&
        run.head_branch === stagingWorkflow.branch &&
        run.path === workflowPath &&
        typeof run.id === 'number'
    )
    .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))
  if (runs.length === 0) {
    throw new Error(
      `${stagingWorkflow.name} has no run for ${sha} on ${stagingWorkflow.branch}. Production releases only a commit that ${stagingWorkflow.name} has migrated, deployed, and smoke-tested on staging. ${rerunHint}`
    )
  }
  for (const run of runs) {
    const latestAttempt =
      typeof run.run_attempt === 'number' && run.run_attempt > 1 ? run.run_attempt : 1
    for (let attempt = latestAttempt; attempt >= 1; attempt -= 1) {
      const { jobs } = (await get(`actions/runs/${run.id}/attempts/${attempt}/jobs`, {
        per_page: '100'
      })) as { jobs?: WorkflowJob[] }
      if ((jobs ?? []).some(isVerifiedStagingJob)) {
        return {
          runAttempt: attempt,
          runId: run.id as number,
          runUrl:
            run.html_url ??
            `https://github.com/${project.repository}/actions/runs/${String(run.id)}`,
          sha
        }
      }
    }
  }
  const seen = runs
    .map(
      run =>
        `${run.html_url ?? String(run.id)} (attempt ${run.run_attempt ?? 1}: ${run.conclusion ?? run.status ?? 'unknown'})`
    )
    .join(', ')
  const steps = stagingWorkflow.requiredSteps.join(', ')
  throw new Error(
    `No ${stagingWorkflow.name} attempt for ${sha} has completed every staging step (${steps}) yet: ${seen}. ${rerunHint}`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [sha = process.env.GITHUB_SHA] = process.argv.slice(2).filter(value => value !== '--')
  assertStagingVerified({
    apiUrl: process.env.GITHUB_API_URL,
    sha,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  })
    .then(result => {
      console.log(
        `${stagingWorkflow.name} verified ${result.sha} on staging: ${result.runUrl} (attempt ${result.runAttempt})`
      )
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
