/**
 * Staging before production: proves that Deploy Staging migrated, deployed, HTTP-gated, and
 * smoke-tested on the `staging` branch exactly the source a production release is about to ship.
 *
 *   GITHUB_TOKEN=<token with actions: read, contents: read> \
 *     pnpm tsx scripts/staging-verification.ts [<sha>]
 *   GITHUB_TOKEN=<token with contents: read, pull-requests: read> \
 *     pnpm tsx scripts/staging-verification.ts --hotfix [<sha>]
 *
 * `--hotfix` instead proves the commit is the merge commit of a merged `hotfix-*` pull request
 * into main, the only commit the hotfix confirmation may release without staging.
 * `assertCurrentRelease` refuses a release once main has moved on to different source.
 *
 * The commit defaults to GITHUB_SHA. Read-only: it asks the GitHub API for the commit's tree and
 * for `deploy-staging.yml` push or dispatch runs on `staging`, and accepts the commit when any
 * attempt of a run whose head has **the same tree** completed the staging migration, deploy,
 * HTTP gate, and Playwright smoke steps successfully. A green attempt that skipped those steps
 * (for example, before the staging credentials existed) does not count.
 *
 * Why the tree and not the commit: `main` receives `staging` by promotion. A fast-forward keeps
 * the staging commit itself, but a `staging` -> `main` pull request merged with a merge commit
 * gives `main` a new commit. That merge commit has the verified staging commit's tree exactly
 * when `main` had not diverged, so its source, migrations, and workflows are byte-for-byte what
 * staging verified. When `main` had diverged (a hotfix not yet merged back into `staging`), the
 * merged tree was never on staging and the release is refused until staging verifies it.
 *
 * Verification is monotonic on purpose: once an attempt has proven a tree on staging, a later
 * attempt or run (a re-run in progress, a flaky smoke test, a revoked staging token, or an
 * older commit replayed over a newer staging schema) does not withdraw that proof. Those later
 * failures describe the staging environment, not the source, and a non-monotonic rule could let
 * `migrate production` pass and `deploy production` refuse within one release.
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
  branch: 'staging',
  /** A pull_request run never deploys staging, so it never proves anything. */
  events: ['push', 'workflow_dispatch'],
  file: 'deploy-staging.yml',
  name: 'Deploy Staging',
  /** Steps of the staging job that must all have succeeded for the tree to count as verified. */
  requiredSteps: [
    'Apply staging D1 migrations',
    'Deploy staging Worker',
    'Run staging HTTP gates',
    'Run Playwright smoke against staging'
  ],
  /** How many of the newest staging runs are searched for a commit with the released tree. */
  treeSearchRuns: 100
} as const

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>

interface WorkflowRun {
  conclusion?: string | null
  event?: string
  head_branch?: string | null
  head_commit?: { id?: string; tree_id?: string } | null
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
  /** `commit` when staging verified the released commit itself, `tree` for a promotion merge. */
  match: 'commit' | 'tree'
  runAttempt: number
  runId: number
  runUrl: string
  /** The released commit. */
  sha: string
  /** The staging commit whose Deploy Staging run verified the tree. */
  stagingSha: string
  /** The tree shared by the released commit and the verified staging commit. */
  tree: string
}

export interface StagingVerificationOptions {
  apiUrl?: string
  fetch?: FetchLike
  sha: string | undefined
  token: string | undefined
}

const fullSha = /^[0-9a-f]{40}$/u

/** True when the job succeeded and every required staging step ran and succeeded. */
function isVerifiedStagingJob(job: WorkflowJob): boolean {
  return (
    job.conclusion === 'success' &&
    stagingWorkflow.requiredSteps.every(name =>
      job.steps?.some(step => step.name === name && step.conclusion === 'success')
    )
  )
}

/** A push or dispatch run of the staging workflow on the staging branch. */
function isStagingRun(run: WorkflowRun): boolean {
  return (
    run.head_branch === stagingWorkflow.branch &&
    run.path === `.github/workflows/${stagingWorkflow.file}` &&
    stagingWorkflow.events.some(event => event === run.event) &&
    typeof run.id === 'number' &&
    typeof run.head_sha === 'string'
  )
}

/** The remediation every refusal ends with. */
const rerunHint = `Start a new run for the head of ${stagingWorkflow.branch} with \`gh workflow run ${stagingWorkflow.file} --ref ${stagingWorkflow.branch}\` (or wait for the push-triggered run), let it finish, then re-run the production workflow. See docs/RELEASE_GUARDS.md#staging-before-production.`

type GitHubGet = (path: string, parameters?: Record<string, string>) => Promise<unknown>

/**
 * Validates the released SHA and the token, then returns a read-only GitHub REST client for this
 * repository. `permissions` names what the token needs, for the error messages.
 */
function githubClient(
  options: StagingVerificationOptions,
  purpose: string,
  permissions: string
): { get: GitHubGet; sha: string } {
  const { sha, token } = options
  if (!sha || !fullSha.test(sha)) {
    throw new Error(`${purpose} needs the full 40-character commit SHA being released.`)
  }
  if (!token) {
    throw new Error(
      `GITHUB_TOKEN (with ${permissions}) is required for ${purpose.toLowerCase()} of ${sha}.`
    )
  }
  const request = options.fetch ?? fetch
  const base = (options.apiUrl || 'https://api.github.com').replace(/\/+$/u, '')
  const get: GitHubGet = async (path, parameters = {}) => {
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
        `GitHub API ${path} returned HTTP ${response.status}; the token needs ${permissions} on ${project.repository}.`
      )
    }
    return response.json()
  }
  return { get, sha }
}

/** The tree of a commit, refusing anything that is not a full tree SHA. */
async function treeOf(get: GitHubGet, sha: string): Promise<string> {
  const commit = (await get(`git/commits/${sha}`)) as { tree?: { sha?: string } }
  const tree = commit.tree?.sha
  if (!tree || !fullSha.test(tree)) {
    throw new Error(
      `GitHub API returned no tree for ${sha}; is it a commit in ${project.repository}?`
    )
  }
  return tree
}

/**
 * The release is current: `branch` still points at `sha`, or at a commit with the same tree.
 * Every push to main queues its own release, so an older run approved late, or re-run, would
 * otherwise put an older Worker over a newer one.
 */
export async function assertCurrentRelease(
  options: StagingVerificationOptions & { branch: string }
): Promise<{ head: string }> {
  const { get, sha } = githubClient(options, 'The current-release check', 'contents: read')
  const ref = (await get(`git/ref/heads/${options.branch}`)) as { object?: { sha?: string } }
  const head = ref.object?.sha
  if (!head || !fullSha.test(head)) {
    throw new Error(`GitHub API returned no commit for ${options.branch}.`)
  }
  if (head === sha || (await treeOf(get, head)) === (await treeOf(get, sha))) return { head }
  throw new Error(
    `${options.branch} now points at ${head}, not ${sha}, so this release is stale: the newer push has its own Deploy Production run. Roll back with Cloudflare rather than re-running an older release (docs/DEPLOY_RUNBOOK.md#bookmarks-and-recovery).`
  )
}

interface PullRequest {
  base?: { ref?: string }
  head?: { ref?: string; repo?: { full_name?: string } | null }
  html_url?: string
  merge_commit_sha?: string | null
  merged_at?: string | null
  number?: number
}

/** Pull request branches whose merge into main may use the hotfix confirmation. */
export const hotfixBranch = /^hotfix-[A-Za-z0-9._-]+$/u

/**
 * A hotfix release: `sha` is the merge commit of a merged `hotfix-*` pull request from this
 * repository into main. Reads the newest 100 closed pull requests into main; the commit-pulls
 * endpoint cannot be used, because it lists merged pull requests only for commits on the
 * default branch, which is `staging`.
 */
export async function assertHotfixMerge(
  options: StagingVerificationOptions
): Promise<{ number: number; url: string }> {
  const { get, sha } = githubClient(
    options,
    'The hotfix check',
    'contents: read and pull-requests: read'
  )
  const pulls = (await get('pulls', {
    base: 'main',
    direction: 'desc',
    per_page: '100',
    sort: 'updated',
    state: 'closed'
  })) as PullRequest[]
  const hotfix = (Array.isArray(pulls) ? pulls : []).find(
    pull =>
      pull.merge_commit_sha === sha &&
      Boolean(pull.merged_at) &&
      pull.base?.ref === 'main' &&
      hotfixBranch.test(pull.head?.ref ?? '') &&
      pull.head?.repo?.full_name === project.repository &&
      typeof pull.number === 'number'
  )
  if (!hotfix) {
    throw new Error(
      `${sha} is not the merge commit of a merged hotfix-* pull request from ${project.repository} into main, so the hotfix confirmation cannot release it. Release it through staging instead (docs/RELEASE_GUARDS.md#hotfixes).`
    )
  }
  return {
    number: hotfix.number as number,
    url: hotfix.html_url ?? `https://github.com/${project.repository}/pull/${hotfix.number}`
  }
}

/**
 * Resolves with the newest run attempt of Deploy Staging on `staging` that verified the tree of
 * `sha` (preferring a run of `sha` itself), or throws a remediation message when none did.
 */
export async function assertStagingVerified(
  options: StagingVerificationOptions
): Promise<StagingVerification> {
  const { get, sha } = githubClient(
    options,
    'Staging verification',
    'actions: read and contents: read'
  )
  const listRuns = async (parameters: Record<string, string>): Promise<WorkflowRun[]> => {
    // No status filter: a run whose latest attempt is still running or failed may hold an
    // earlier attempt that verified the tree.
    const listed = (await get(`actions/workflows/${stagingWorkflow.file}/runs`, {
      branch: stagingWorkflow.branch,
      ...parameters
    })) as { workflow_runs?: WorkflowRun[] }
    return (listed.workflow_runs ?? []).filter(isStagingRun)
  }
  const newestFirst = (left: WorkflowRun, right: WorkflowRun) => (right.id ?? 0) - (left.id ?? 0)

  const tree = await treeOf(get, sha)

  const checked: WorkflowRun[] = []
  const verify = async (
    runs: WorkflowRun[],
    match: StagingVerification['match']
  ): Promise<StagingVerification | undefined> => {
    for (const run of runs) {
      checked.push(run)
      const latestAttempt =
        typeof run.run_attempt === 'number' && run.run_attempt > 1 ? run.run_attempt : 1
      for (let attempt = latestAttempt; attempt >= 1; attempt -= 1) {
        const { jobs } = (await get(`actions/runs/${run.id}/attempts/${attempt}/jobs`, {
          per_page: '100'
        })) as { jobs?: WorkflowJob[] }
        if ((jobs ?? []).some(isVerifiedStagingJob)) {
          return {
            match,
            runAttempt: attempt,
            runId: run.id as number,
            runUrl:
              run.html_url ??
              `https://github.com/${project.repository}/actions/runs/${String(run.id)}`,
            sha,
            stagingSha: run.head_sha as string,
            tree
          }
        }
      }
    }
    return undefined
  }

  const exact = (await listRuns({ head_sha: sha, per_page: '100' }))
    .filter(run => run.head_sha === sha)
    .sort(newestFirst)
  const sameCommit = await verify(exact, 'commit')
  if (sameCommit) return sameCommit
  // A promotion merge commit never ran on staging itself; look for the staging commit whose
  // tree it carries.
  const sameTree = (await listRuns({ per_page: String(stagingWorkflow.treeSearchRuns) }))
    .filter(run => run.head_sha !== sha && run.head_commit?.tree_id === tree)
    .sort(newestFirst)
  const promoted = await verify(sameTree, 'tree')
  if (promoted) return promoted

  if (checked.length === 0) {
    throw new Error(
      `${stagingWorkflow.name} has no run on ${stagingWorkflow.branch} for ${sha} or for any commit with its tree ${tree}. Production releases only source that ${stagingWorkflow.name} has migrated, deployed, and smoke-tested on staging. A promotion merge commit carries a staging commit's tree only when main has not diverged; if main has commits that staging lacks, merge main into staging first. ${rerunHint}`
    )
  }
  const seen = checked
    .map(
      run =>
        `${run.html_url ?? String(run.id)} (${String(run.head_sha).slice(0, 12)}, attempt ${run.run_attempt ?? 1}: ${run.conclusion ?? run.status ?? 'unknown'})`
    )
    .join(', ')
  const steps = stagingWorkflow.requiredSteps.join(', ')
  throw new Error(
    `No ${stagingWorkflow.name} attempt for ${sha} (tree ${tree}) has completed every staging step (${steps}) yet: ${seen}. ${rerunHint}`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // `--hotfix` proves the commit is a merged hotfix-* pull request instead of a staging release.
  const argv = process.argv.slice(2).filter(value => value !== '--')
  const hotfix = argv.includes('--hotfix')
  const [sha = process.env.GITHUB_SHA] = argv.filter(value => value !== '--hotfix')
  const options = {
    apiUrl: process.env.GITHUB_API_URL,
    sha,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  }
  ;(hotfix
    ? assertHotfixMerge(options).then(
        result =>
          `${sha} is the merge commit of hotfix pull request #${result.number}: ${result.url}`
      )
    : assertStagingVerified(options).then(result =>
        result.match === 'commit'
          ? `${stagingWorkflow.name} verified ${result.sha} on ${stagingWorkflow.branch}: ${result.runUrl} (attempt ${result.runAttempt})`
          : `${stagingWorkflow.name} verified tree ${result.tree} of ${result.sha} at ${stagingWorkflow.branch} commit ${result.stagingSha}: ${result.runUrl} (attempt ${result.runAttempt})`
      )
  )
    .then(message => {
      console.log(message)
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
