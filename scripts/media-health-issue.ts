import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type MediaHealthReport, mediaHealthMarkdown, mediaHealthMarker } from './media-health'
import { project } from './project'

/**
 * Files a media health report (`media-health.ts`, serpcompany/best.serp.co#122) as one GitHub
 * issue per environment: findings open the issue, or update the open one the workflow opened; a
 * clean report closes it with a comment. It holds only the workflow's `GITHUB_TOKEN` (issues: write), never a
 * Cloudflare credential, and exits 1 while there are findings so the run shows them.
 */

interface GitHubIssue {
  body?: string | null
  number: number
  pull_request?: unknown
  user?: { login?: string; type?: string } | null
}

/**
 * Who opens the report issue: the workflow's `GITHUB_TOKEN`. The repository is public, so anyone
 * can open an issue holding the marker; only the bot's own issue is the report (#123 review S2).
 */
export const REPORT_ISSUE_AUTHOR = 'github-actions[bot]'

export function isReportIssue(issue: GitHubIssue, marker: string): boolean {
  return (
    !issue.pull_request &&
    issue.user?.login === REPORT_ISSUE_AUTHOR &&
    issue.user.type === 'Bot' &&
    Boolean(issue.body?.includes(marker))
  )
}

type Request = <T>(path: string, init?: RequestInit) => Promise<T>

function githubClient(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Request {
  const token = env.GITHUB_TOKEN
  if (!token) throw new Error('Missing required environment value GITHUB_TOKEN.')
  return async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'best-serp-co-media-health',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(`GitHub API request ${path} failed with status ${response.status}.`)
    }
    return (await response.json()) as T
  }
}

async function findOpenIssue(request: Request, marker: string): Promise<GitHubIssue | null> {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await request<GitHubIssue[]>(
      `/repos/${project.repository}/issues?state=open&per_page=100&page=${page}`
    )
    const match = issues.find(issue => isReportIssue(issue, marker))
    if (match) return match
    if (issues.length < 100) return null
  }
  throw new Error('Unable to search every open issue for the media health issue.')
}

export type IssueAction = 'closed' | 'created' | 'none' | 'updated'

export async function fileMediaHealthIssue(
  report: MediaHealthReport,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<{ action: IssueAction; number?: number }> {
  const request = githubClient(env, fetcher)
  const existing = await findOpenIssue(request, mediaHealthMarker(report.environment))
  const body = mediaHealthMarkdown(report)
  const issues = `/repos/${project.repository}/issues`
  if (report.findings.length === 0) {
    if (!existing) return { action: 'none' }
    await request(`${issues}/${existing.number}/comments`, {
      body: JSON.stringify({ body }),
      method: 'POST'
    })
    await request(`${issues}/${existing.number}`, {
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      method: 'PATCH'
    })
    return { action: 'closed', number: existing.number }
  }
  const title = `Listing media health: ${report.findings.length} finding(s) on ${report.environment}`
  if (existing) {
    await request(`${issues}/${existing.number}`, {
      body: JSON.stringify({ body, title }),
      method: 'PATCH'
    })
    return { action: 'updated', number: existing.number }
  }
  const created = await request<GitHubIssue>(issues, {
    body: JSON.stringify({ body, title }),
    method: 'POST'
  })
  return { action: 'created', number: created.number }
}

async function main(): Promise<void> {
  const path = process.argv.slice(2).filter(value => value !== '--')[0]
  if (!path) throw new Error('Usage: pnpm media:health:issue -- <report.json>')
  const report = JSON.parse(readFileSync(resolve(path), 'utf8')) as MediaHealthReport
  if (report.environment !== 'staging' && report.environment !== 'production') {
    throw new Error('The report names no environment.')
  }
  const result = await fileMediaHealthIssue(report)
  console.log(JSON.stringify(result))
  if (report.findings.length > 0) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
