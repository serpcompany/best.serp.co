import { describe, expect, it } from 'vitest'
import { project } from './project'
import { assertStagingVerified, type FetchLike, stagingWorkflow } from './staging-verification'

const sha = '0123456789abcdef0123456789abcdef01234567'
const otherSha = 'f'.repeat(40)
const token = 'ghs_test'

interface Run {
  conclusion: string | null
  head_branch: string
  head_sha: string
  html_url: string
  id: number
  path: string
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
    status: 'completed',
    ...overrides
  }
}

/** The staging job as the Actions API reports it; `skipped` marks steps that did not run. */
function stagingJob(skipped: readonly string[] = [], conclusion = 'success') {
  return {
    conclusion,
    name: 'Validate, migrate, deploy & smoke-test staging',
    steps: [
      'Set up job',
      'Check Cloudflare credentials',
      'Checkout reviewed source',
      ...stagingWorkflow.requiredSteps,
      'Complete job'
    ].map(name => ({ conclusion: skipped.includes(name) ? 'skipped' : 'success', name }))
  }
}

/** A fake GitHub API that records every request. */
function github(
  runs: Run[],
  jobs: Record<number, unknown[]> = {},
  status = 200
): { fetch: FetchLike; requests: Array<{ headers: Record<string, string>; url: URL }> } {
  const requests: Array<{ headers: Record<string, string>; url: URL }> = []
  const fetch: FetchLike = async (url, init) => {
    const parsed = new URL(url)
    requests.push({ headers: init.headers, url: parsed })
    const body = parsed.pathname.endsWith('/runs')
      ? { total_count: runs.length, workflow_runs: runs }
      : { jobs: jobs[Number(parsed.pathname.split('/').at(-2))] ?? [] }
    return { json: async () => body, ok: status >= 200 && status < 300, status }
  }
  return { fetch, requests }
}

describe('staging before production', () => {
  it('accepts a commit whose Deploy Staging run migrated, deployed, gated, and smoke-tested it', async () => {
    const api = github([run(7)], { 7: [stagingJob()] })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toEqual({
      runId: 7,
      runUrl: `https://github.com/${project.repository}/actions/runs/7`,
      sha
    })
    const [runsRequest, jobsRequest] = api.requests
    expect(runsRequest?.url.origin).toBe('https://api.github.com')
    expect(runsRequest?.url.pathname).toBe(
      `/repos/${project.repository}/actions/workflows/deploy-staging.yml/runs`
    )
    expect(Object.fromEntries(runsRequest?.url.searchParams ?? [])).toEqual({
      branch: 'main',
      head_sha: sha,
      per_page: '100',
      status: 'success'
    })
    expect(runsRequest?.headers.Authorization).toBe(`Bearer ${token}`)
    expect(jobsRequest?.url.pathname).toBe(`/repos/${project.repository}/actions/runs/7/jobs`)
    expect(jobsRequest?.url.searchParams.get('filter')).toBe('latest')
  })

  it('refuses a commit that Deploy Staging has not verified yet', async () => {
    const api = github([])
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).rejects.toThrow(
      `Deploy Staging has no successful run for ${sha} on main`
    )
    expect(api.requests).toHaveLength(1)
  })

  it('ignores runs for another commit, branch, workflow, or outcome', async () => {
    const api = github(
      [
        run(1, { head_sha: otherSha }),
        run(2, { head_branch: 'feature' }),
        run(3, { path: '.github/workflows/main-validation.yml' }),
        run(4, { conclusion: 'failure' }),
        run(5, { conclusion: null, status: 'in_progress' })
      ],
      Object.fromEntries([1, 2, 3, 4, 5].map(id => [id, [stagingJob()]]))
    )
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).rejects.toThrow(
      'no successful run'
    )
    expect(api.requests).toHaveLength(1)
  })

  it('refuses a green run that skipped any staging step', async () => {
    for (const step of stagingWorkflow.requiredSteps) {
      const api = github([run(9)], { 9: [stagingJob([step])] })
      await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).rejects.toThrow(
        'without completing every staging step'
      )
    }
    const failedJob = github([run(9)], { 9: [stagingJob([], 'failure')] })
    await expect(assertStagingVerified({ fetch: failedJob.fetch, sha, token })).rejects.toThrow(
      'without completing every staging step'
    )
  })

  it('accepts the newest verified run when an older one skipped its steps', async () => {
    const api = github([run(10), run(12)], {
      10: [stagingJob(['Deploy staging Worker'])],
      12: [stagingJob()]
    })
    await expect(assertStagingVerified({ fetch: api.fetch, sha, token })).resolves.toMatchObject({
      runId: 12
    })
  })

  it('needs a full commit SHA and a token, and reports API failures', async () => {
    const api = github([run(7)], { 7: [stagingJob()] })
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
    const api = github([run(7)], { 7: [stagingJob()] })
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
