import { describe, expect, it } from 'vitest'
import { project } from './project'
import {
  assertCurrentRelease,
  assertHotfixMerge,
  assertStagingVerified,
  type FetchLike,
  stagingWorkflow
} from './staging-verification'

/** The released commit, and the tree it carries. */
const sha = '0123456789abcdef0123456789abcdef01234567'
const tree = 'a'.repeat(40)
/** A staging commit with the same tree (the second parent of a promotion merge commit). */
const stagingSha = '1'.repeat(40)
const otherSha = 'f'.repeat(40)
const otherTree = 'e'.repeat(40)
const token = 'ghs_test'
const rerun = 'gh workflow run web.yml --ref staging'

interface Run {
  conclusion: string | null
  event: string
  head_branch: string
  head_commit: { id: string; tree_id: string }
  head_sha: string
  html_url: string
  id: number
  path: string
  run_attempt: number
  status: string
}

function run(id: number, overrides: Partial<Run> = {}): Run {
  const head = overrides.head_sha ?? sha
  return {
    conclusion: 'success',
    event: 'push',
    head_branch: 'staging',
    head_commit: { id: head, tree_id: head === sha ? tree : otherTree },
    head_sha: head,
    html_url: `https://github.com/${project.repository}/actions/runs/${id}`,
    id,
    path: '.github/workflows/web.yml',
    run_attempt: 1,
    status: 'completed',
    ...overrides
  }
}

/** A run of a different staging commit whose head carries `tree` (what a promotion merges). */
function promotedRun(id: number, overrides: Partial<Run> = {}): Run {
  return run(id, {
    head_commit: { id: stagingSha, tree_id: tree },
    head_sha: stagingSha,
    ...overrides
  })
}

/** The staging job as the Actions API reports it; `skipped` marks steps that did not run. */
function stagingJob(skipped: readonly string[] = [], conclusion: string | null = 'success') {
  return {
    conclusion,
    name: 'Validate, migrate, deploy & smoke-test staging',
    steps: [
      'Set up job',
      'Check Cloudflare credentials',
      'Checkout reviewed source',
      ...stagingWorkflow.requiredSteps,
      'Complete job'
    ].map(name => ({ conclusion: skipped.includes(name) ? 'skipped' : conclusion, name }))
  }
}

/**
 * A fake GitHub API that records every request. `attempts[runId][n - 1]` holds the jobs of
 * attempt n of that run. Like the real API, the runs listing honours `head_sha`, and
 * `git/commits/<sha>` reports the released commit's tree.
 */
function github(
  runs: Run[],
  attempts: Record<number, unknown[][]> = {},
  status = 200
): { fetch: FetchLike; requests: Array<{ headers: Record<string, string>; url: URL }> } {
  const requests: Array<{ headers: Record<string, string>; url: URL }> = []
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url)
    requests.push({ headers: init.headers, url: parsed })
    const attempt = parsed.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u)
    const commit = parsed.pathname.match(/\/git\/commits\/([0-9a-f]+)$/u)
    const headSha = parsed.searchParams.get('head_sha')
    const body = attempt
      ? { jobs: attempts[Number(attempt[1])]?.[Number(attempt[2]) - 1] ?? [] }
      : commit
        ? { sha: commit[1], tree: { sha: commit[1] === sha ? tree : otherTree } }
        : {
            workflow_runs: runs.filter(candidate => !headSha || candidate.head_sha === headSha)
          }
    return { json: async () => body, ok: status >= 200 && status < 300, status }
  }
  return { fetch, requests }
}

const paths = (api: ReturnType<typeof github>) => api.requests.map(request => request.url.pathname)
const runsPath = `/repos/${project.repository}/actions/workflows/web.yml/runs`
const jobsPath = (id: number, attempt = 1) =>
  `/repos/${project.repository}/actions/runs/${id}/attempts/${attempt}/jobs`

describe('staging before production', () => {
  it('accepts a commit whose own Deploy Staging run on staging verified it (fast-forward)', async () => {
    const api = github([run(7)], { 7: [[stagingJob()]] })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toEqual({
      match: 'commit',
      runAttempt: 1,
      runId: 7,
      runUrl: `https://github.com/${project.repository}/actions/runs/7`,
      sha,
      stagingSha: sha,
      tree
    })
    const [commitRequest, runsRequest, jobsRequest] = api.requests
    expect(commitRequest?.url.origin).toBe('https://api.github.com')
    expect(commitRequest?.url.pathname).toBe(`/repos/${project.repository}/git/commits/${sha}`)
    expect(runsRequest?.url.pathname).toBe(runsPath)
    // No status filter: a run whose latest attempt is still running or failed may hold an
    // earlier attempt that verified the commit.
    expect(Object.fromEntries(runsRequest?.url.searchParams ?? [])).toEqual({
      branch: 'staging',
      head_sha: sha,
      per_page: '100'
    })
    expect(runsRequest?.headers.Authorization).toBe(`Bearer ${token}`)
    expect(jobsRequest?.url.pathname).toBe(jobsPath(7))
    expect(api.requests).toHaveLength(3)
  })

  it('accepts a promotion merge commit whose tree a verified staging commit carries', async () => {
    const api = github([promotedRun(40), run(41, { head_sha: otherSha })], {
      40: [[stagingJob()]],
      41: [[stagingJob()]]
    })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toEqual({
      match: 'tree',
      runAttempt: 1,
      runId: 40,
      runUrl: `https://github.com/${project.repository}/actions/runs/40`,
      sha,
      stagingSha,
      tree
    })
    // The commit's own runs first, then the newest staging runs, then only the tree match.
    expect(paths(api)).toEqual([
      `/repos/${project.repository}/git/commits/${sha}`,
      runsPath,
      runsPath,
      jobsPath(40)
    ])
    expect(Object.fromEntries(api.requests[2]?.url.searchParams ?? [])).toEqual({
      branch: 'staging',
      per_page: String(stagingWorkflow.treeSearchRuns)
    })
  })

  it('refuses a merge commit whose tree staging never verified (main had diverged)', async () => {
    // Staging verified its own head, but main held a hotfix the merge brought in.
    const api = github([run(50, { head_sha: otherSha })], { 50: [[stagingJob()]] })
    const result = assertStagingVerified({ fetch: api.fetch, sha, token })
    await expect(result).rejects.toThrow(
      `Deploy Staging has no run on staging for ${sha} or for any commit with its tree ${tree}`
    )
    await expect(result).rejects.toThrow('merge main into staging first')
    await expect(result).rejects.toThrow(rerun)
    expect(paths(api).some(path => path.includes('/attempts/'))).toBe(false)
  })

  it('keeps a verified tree verified while a later re-run is in progress or after it fails', async () => {
    const verifiedFirst = [stagingJob()]
    const laterAttempts: Array<[string, Partial<Run>, unknown[]]> = [
      ['in progress', { conclusion: null, status: 'in_progress' }, [stagingJob([], null)]],
      ['smoke failed', { conclusion: 'failure' }, [stagingJob([], 'failure')]],
      [
        'migration failed',
        { conclusion: 'failure' },
        [
          stagingJob(
            [
              'Deploy staging Worker',
              'Run staging HTTP gates',
              'Run Playwright smoke against staging'
            ],
            'failure'
          )
        ]
      ],
      ['cancelled', { conclusion: 'cancelled' }, [stagingJob([], 'cancelled')]]
    ]
    for (const [label, overrides, latestJobs] of laterAttempts) {
      for (const candidate of [run, promotedRun]) {
        const api = github([candidate(21, { run_attempt: 2, ...overrides })], {
          21: [verifiedFirst, latestJobs]
        })
        await expect(
          assertStagingVerified({ fetch: api.fetch, sha, token }),
          label
        ).resolves.toMatchObject({ runAttempt: 1, runId: 21 })
        expect(paths(api).slice(-2), label).toEqual([jobsPath(21, 2), jobsPath(21, 1)])
      }
    }
  })

  it('accepts a re-run that verified the commit after a failed first attempt', async () => {
    const api = github([run(36, { run_attempt: 2 })], {
      36: [[stagingJob([], 'failure')], [stagingJob()]]
    })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toMatchObject({
      match: 'commit',
      runAttempt: 2,
      runId: 36
    })
    expect(paths(api).at(-1)).toBe(jobsPath(36, 2))
    expect(api.requests).toHaveLength(3)
  })

  it('refuses a commit that Deploy Staging has not run for, naming how to start a run', async () => {
    const api = github([])
    const result = assertStagingVerified({ fetch: api.fetch, sha, token })
    await expect(result).rejects.toThrow(`Deploy Staging has no run on staging for ${sha}`)
    await expect(result).rejects.toThrow(rerun)
    expect(paths(api)).toEqual([
      `/repos/${project.repository}/git/commits/${sha}`,
      runsPath,
      runsPath
    ])
  })

  it('refuses a commit whose only run is still in progress', async () => {
    const api = github([run(5, { conclusion: null, status: 'in_progress' })], {
      5: [[stagingJob([], null)]]
    })
    const result = assertStagingVerified({ fetch: api.fetch, sha, token })
    await expect(result).rejects.toThrow('attempt 1: in_progress')
    await expect(result).rejects.toThrow(rerun)
  })

  it('ignores runs of another branch (including main), workflow, event, or tree', async () => {
    const elsewhere: Array<Partial<Run>> = [
      { head_branch: 'main' },
      { head_branch: 'feature' },
      { path: '.github/workflows/main-validation.yml' },
      // A pull_request run of a fork branch named staging never deploys staging.
      { event: 'pull_request' },
      { event: 'schedule' }
    ]
    const runs = elsewhere.flatMap((overrides, index) => [
      run(index + 1, overrides),
      promotedRun(index + 11, overrides)
    ])
    runs.push(run(30, { head_sha: otherSha }))
    const api = github(
      runs,
      Object.fromEntries(runs.map(candidate => [candidate.id, [[stagingJob()]]]))
    )
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).rejects.toThrow(
      'has no run on staging'
    )
    expect(api.requests).toHaveLength(3)
  })

  it('refuses green attempts that skipped any staging step, and failed jobs', async () => {
    for (const step of stagingWorkflow.requiredSteps) {
      for (const candidate of [run, promotedRun]) {
        const api = github([candidate(9, { run_attempt: 2 })], {
          9: [[stagingJob([step])], [stagingJob([step])]]
        })
        const result = assertStagingVerified({ fetch: api.fetch, sha, token })
        await expect(result, step).rejects.toThrow('has completed every staging step')
        await expect(result, step).rejects.toThrow(`(tree ${tree})`)
        await expect(result, step).rejects.toThrow(rerun)
      }
    }
    const failedJob = github([run(9, { conclusion: 'failure' })], {
      9: [[stagingJob([], 'failure')]]
    })
    await expect(assertStagingVerified({ fetch: failedJob.fetch, sha, token })).rejects.toThrow(
      'attempt 1: failure'
    )
  })

  it('accepts the newest verified run when a newer run never verified the tree', async () => {
    const api = github(
      [run(10), run(12, { conclusion: 'failure' }), promotedRun(14, { conclusion: 'failure' })],
      {
        10: [[stagingJob()]],
        12: [[stagingJob(['Deploy staging Worker'], 'failure')]],
        14: [[stagingJob(['Deploy staging Worker'], 'failure')]]
      }
    )
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toMatchObject({
      match: 'commit',
      runId: 10
    })
    expect(paths(api).slice(2)).toEqual([jobsPath(12), jobsPath(10)])
  })

  it('needs a full commit SHA, a token, and a tree, and reports API failures', async () => {
    const api = github([run(7)], { 7: [[stagingJob()]] })
    await expect(assertStagingVerified({ fetch: api.fetch, sha: 'abc123', token })).rejects.toThrow(
      '40-character commit SHA'
    )
    await expect(
      assertStagingVerified({ fetch: api.fetch, sha: undefined, token })
    ).rejects.toThrow('40-character commit SHA')
    await expect(
      assertStagingVerified({ fetch: api.fetch, sha, token: undefined })
    ).rejects.toThrow('GITHUB_TOKEN (with actions: read and contents: read)')
    expect(api.requests).toEqual([])
    const forbidden = github([], {}, 403)
    await expect(assertStagingVerified({ fetch: forbidden.fetch, sha, token })).rejects.toThrow(
      'HTTP 403; the token needs actions: read and contents: read'
    )
    const treeless: FetchLike = async () => ({ json: async () => ({}), ok: true, status: 200 })
    await expect(assertStagingVerified({ fetch: treeless, sha, token })).rejects.toThrow(
      `no tree for ${sha}`
    )
  })

  it('uses the Actions API origin it is given', async () => {
    const api = github([run(7)], { 7: [[stagingJob()]] })
    await assertStagingVerified({
      apiUrl: 'https://github.example.com/api/v3/',
      fetch: api.fetch,
      sha,
      token
    })
    expect(api.requests[0]?.url.toString()).toMatch(
      /^https:\/\/github\.example\.com\/api\/v3\/repos\//u
    )
  })
})

/** A fake GitHub API answering one fixed body per path suffix, recording each request. */
function routes(table: Record<string, unknown>, status = 200) {
  const requests: URL[] = []
  const fetch: FetchLike = async url => {
    const parsed = new URL(url)
    requests.push(parsed)
    const key = Object.keys(table).find(suffix => parsed.pathname.endsWith(suffix))
    return { json: async () => (key ? table[key] : {}), ok: status === 200, status }
  }
  return { fetch, requests }
}

describe('hotfix and current-release checks', () => {
  const pull = (overrides: Record<string, unknown> = {}) => ({
    base: { ref: 'main' },
    head: { ref: 'hotfix-12-search', repo: { full_name: project.repository } },
    html_url: 'https://github.com/pull/12',
    merge_commit_sha: sha,
    merged_at: '2026-10-05T00:00:00Z',
    number: 12,
    ...overrides
  })
  const headOf = (ref: string, repo: unknown = { full_name: project.repository }) => ({
    head: { ref, repo }
  })

  it('accepts only the merge commit of a merged hotfix-* pull request into main', async () => {
    const api = routes({ '/pulls': [pull({ merge_commit_sha: otherSha, number: 11 }), pull()] })
    await expect(assertHotfixMerge({ fetch: api.fetch, sha, token })).resolves.toEqual({
      number: 12,
      url: 'https://github.com/pull/12'
    })
    // Closed pull requests into main, newest first. commits/<sha>/pulls would list merged pull
    // requests only for commits on the default branch, which is staging.
    expect(api.requests[0]?.pathname).toBe(`/repos/${project.repository}/pulls`)
    expect(Object.fromEntries(api.requests[0]?.searchParams ?? [])).toEqual({
      base: 'main',
      direction: 'desc',
      per_page: '100',
      sort: 'updated',
      state: 'closed'
    })
    const refused: Array<[string, Record<string, unknown>]> = [
      ['another commit', { merge_commit_sha: otherSha }],
      ['closed unmerged', { merged_at: null }],
      ['into staging', { base: { ref: 'staging' } }],
      ['a feature branch', headOf('issue-12-search')],
      ['a nested name', headOf('x/hotfix-12')],
      ['a fork', headOf('hotfix-12-search', { full_name: 'someone/best.serp.co' })],
      ['a deleted fork', headOf('hotfix-12-search', null)]
    ]
    for (const [label, overrides] of refused) {
      await expect(
        assertHotfixMerge({ fetch: routes({ '/pulls': [pull(overrides)] }).fetch, sha, token }),
        label
      ).rejects.toThrow('not the merge commit of a merged hotfix-* pull request')
    }
    await expect(assertHotfixMerge({ fetch: routes({}, 403).fetch, sha, token })).rejects.toThrow(
      'pull-requests: read'
    )
    await expect(assertHotfixMerge({ fetch: api.fetch, sha, token: undefined })).rejects.toThrow(
      'is required for the hotfix check'
    )
  })

  it('accepts a release only while its branch points at it or at the same tree', async () => {
    const commits = {
      [`/git/commits/${sha}`]: { tree: { sha: tree } },
      [`/git/commits/${otherSha}`]: { tree: { sha: otherTree } },
      [`/git/commits/${stagingSha}`]: { tree: { sha: tree } }
    }
    const current = routes({ '/git/ref/heads/main': { object: { sha } }, ...commits })
    await expect(
      assertCurrentRelease({ branch: 'main', fetch: current.fetch, sha, token })
    ).resolves.toEqual({ head: sha })
    expect(current.requests.map(request => request.pathname)).toEqual([
      `/repos/${project.repository}/git/ref/heads/main`
    ])
    const sameTree = routes({ '/git/ref/heads/main': { object: { sha: stagingSha } }, ...commits })
    await expect(
      assertCurrentRelease({ branch: 'main', fetch: sameTree.fetch, sha, token })
    ).resolves.toEqual({ head: stagingSha })
    const moved = routes({ '/git/ref/heads/main': { object: { sha: otherSha } }, ...commits })
    await expect(
      assertCurrentRelease({ branch: 'main', fetch: moved.fetch, sha, token })
    ).rejects.toThrow(`main now points at ${otherSha}, not ${sha}, so this release is stale`)
    await expect(
      assertCurrentRelease({ branch: 'main', fetch: routes({}).fetch, sha, token })
    ).rejects.toThrow('no commit for main')
  })
})
