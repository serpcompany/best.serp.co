import { describe, expect, it } from 'vitest'
import { project } from './project'
import { assertStagingVerified, type FetchLike, stagingWorkflow } from './staging-verification'

const sha = '0123456789abcdef0123456789abcdef01234567'
const otherSha = 'f'.repeat(40)
const token = 'ghs_test'
const rerun = 'gh workflow run deploy-staging.yml --ref main'

interface Run {
  conclusion: string | null
  head_branch: string
  head_sha: string
  html_url: string
  id: number
  path: string
  run_attempt: number
  status: string
}

function run(id: number, overrides: Partial<Run> = {}): Run {
  return {
    conclusion: 'success',
    head_branch: 'main',
    head_sha: sha,
    html_url: `https://github.com/${project.repository}/actions/runs/${id}`,
    id,
    path: '.github/workflows/deploy-staging.yml',
    run_attempt: 1,
    status: 'completed',
    ...overrides
  }
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
 * attempt n of that run.
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
    const body = attempt
      ? { jobs: attempts[Number(attempt[1])]?.[Number(attempt[2]) - 1] ?? [] }
      : { total_count: runs.length, workflow_runs: runs }
    return { json: async () => body, ok: status >= 200 && status < 300, status }
  }
  return { fetch, requests }
}

const paths = (api: ReturnType<typeof github>) => api.requests.map(request => request.url.pathname)

describe('staging before production', () => {
  it('accepts a commit whose Deploy Staging run migrated, deployed, gated, and smoke-tested it', async () => {
    const api = github([run(7)], { 7: [[stagingJob()]] })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toEqual({
      runAttempt: 1,
      runId: 7,
      runUrl: `https://github.com/${project.repository}/actions/runs/7`,
      sha
    })
    const [runsRequest, jobsRequest] = api.requests
    expect(runsRequest?.url.origin).toBe('https://api.github.com')
    expect(runsRequest?.url.pathname).toBe(
      `/repos/${project.repository}/actions/workflows/deploy-staging.yml/runs`
    )
    // No status filter: a run whose latest attempt is still running or failed may hold an
    // earlier attempt that verified the commit.
    expect(Object.fromEntries(runsRequest?.url.searchParams ?? [])).toEqual({
      branch: 'main',
      head_sha: sha,
      per_page: '100'
    })
    expect(runsRequest?.headers.Authorization).toBe(`Bearer ${token}`)
    expect(jobsRequest?.url.pathname).toBe(
      `/repos/${project.repository}/actions/runs/7/attempts/1/jobs`
    )
  })

  it('keeps a verified commit verified while a later re-run is in progress or after it fails', async () => {
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
      const api = github([run(21, { run_attempt: 2, ...overrides })], {
        21: [verifiedFirst, latestJobs]
      })
      await expect(
        assertStagingVerified({ fetch: api.fetch, sha, token }),
        label
      ).resolves.toMatchObject({ runAttempt: 1, runId: 21 })
      expect(paths(api).slice(1), label).toEqual([
        `/repos/${project.repository}/actions/runs/21/attempts/2/jobs`,
        `/repos/${project.repository}/actions/runs/21/attempts/1/jobs`
      ])
    }
  })

  it('accepts a re-run that verified the commit after a failed first attempt', async () => {
    const api = github([run(36, { run_attempt: 2 })], {
      36: [[stagingJob([], 'failure')], [stagingJob()]]
    })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toMatchObject({
      runAttempt: 2,
      runId: 36
    })
    expect(api.requests).toHaveLength(2)
  })

  it('refuses a commit that Deploy Staging has not run for, naming how to start a run', async () => {
    const api = github([])
    const result = assertStagingVerified({ fetch: api.fetch, sha, token })
    await expect(result).rejects.toThrow(`Deploy Staging has no run for ${sha} on main`)
    await expect(result).rejects.toThrow(rerun)
    expect(api.requests).toHaveLength(1)
  })

  it('refuses a commit whose only run is still in progress', async () => {
    const api = github([run(5, { conclusion: null, status: 'in_progress' })], {
      5: [[stagingJob([], null)]]
    })
    const result = assertStagingVerified({ fetch: api.fetch, sha, token })
    await expect(result).rejects.toThrow('attempt 1: in_progress')
    await expect(result).rejects.toThrow(rerun)
  })

  it('ignores runs for another commit, branch, or workflow', async () => {
    const api = github(
      [
        run(1, { head_sha: otherSha }),
        run(2, { head_branch: 'feature' }),
        run(3, { path: '.github/workflows/main-validation.yml' })
      ],
      Object.fromEntries([1, 2, 3].map(id => [id, [[stagingJob()]]]))
    )
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).rejects.toThrow(
      'has no run'
    )
    expect(api.requests).toHaveLength(1)
  })

  it('refuses green attempts that skipped any staging step, and failed jobs', async () => {
    for (const step of stagingWorkflow.requiredSteps) {
      const api = github([run(9, { run_attempt: 2 })], {
        9: [[stagingJob([step])], [stagingJob([step])]]
      })
      const result = assertStagingVerified({ fetch: api.fetch, sha, token })
      await expect(result, step).rejects.toThrow('has completed every staging step')
      await expect(result, step).rejects.toThrow(rerun)
    }
    const failedJob = github([run(9, { conclusion: 'failure' })], {
      9: [[stagingJob([], 'failure')]]
    })
    await expect(assertStagingVerified({ fetch: failedJob.fetch, sha, token })).rejects.toThrow(
      'attempt 1: failure'
    )
  })

  it('accepts the newest verified run when a newer run never verified the commit', async () => {
    const api = github([run(10), run(12, { conclusion: 'failure' })], {
      10: [[stagingJob()]],
      12: [[stagingJob(['Deploy staging Worker'], 'failure')]]
    })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toMatchObject({
      runId: 10
    })
    expect(paths(api).slice(1)).toEqual([
      `/repos/${project.repository}/actions/runs/12/attempts/1/jobs`,
      `/repos/${project.repository}/actions/runs/10/attempts/1/jobs`
    ])
  })

  it('needs a full commit SHA and a token, and reports API failures', async () => {
    const api = github([run(7)], { 7: [[stagingJob()]] })
    await expect(assertStagingVerified({ fetch: api.fetch, sha: 'abc123', token })).rejects.toThrow(
      '40-character commit SHA'
    )
    await expect(
      assertStagingVerified({ fetch: api.fetch, sha: undefined, token })
    ).rejects.toThrow('40-character commit SHA')
    await expect(
      assertStagingVerified({ fetch: api.fetch, sha, token: undefined })
    ).rejects.toThrow('GITHUB_TOKEN (with actions: read)')
    expect(api.requests).toEqual([])
    const forbidden = github([], {}, 403)
    await expect(assertStagingVerified({ fetch: forbidden.fetch, sha, token })).rejects.toThrow(
      'HTTP 403; the token needs actions: read'
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
