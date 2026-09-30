import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hasActiveCutoverLock,
  selectActiveCutoverLockPlan
} from '@serpdirectory/data-ops/cutover-lock'
import {
  buildRecordSubmissionNotificationPlans,
  type SubmissionStatementPlan,
  selectVerifiedSubmissionNotificationPlans
} from '@serpdirectory/data-ops/submission-plans'
import { resolveSiteTarget, type SiteId, type SiteTarget } from './site-targets'

const EXPECTED_REPOSITORY = 'serpcompany/directory-platform-d1'
const WORKFLOW_PATH = '/.github/workflows/notify-d1-submissions.yml@'
const REVIEW_WORKFLOW_URL =
  'https://github.com/serpcompany/directory-platform-d1/actions/workflows/approve-d1-submission.yml'
const MAX_SUBMISSIONS_PER_RUN = 20
const MAX_ISSUE_TITLE_LENGTH = 240
const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

interface D1Result {
  results?: Array<Record<string, unknown>>
  success?: boolean
}

interface D1Response {
  errors?: Array<{ message?: string }>
  result?: D1Result[]
  success?: boolean
}

interface SubmissionRow {
  badge_verified_at: string
  category_slug: string
  content: string
  created_at: string
  description: string
  id: string
  logo_url: string
  name: string
  slug: string
  verification_attempts: number
  video_url: string | null
  website: string
}

interface ResourceRow {
  label: string
  sort_order: number
  submission_id: string
  url: string
}

interface FaqRow {
  answer: string
  question: string
  sort_order: number
  submission_id: string
}

interface GitHubIssue {
  assignees?: Array<{ login?: string }>
  body?: string | null
  html_url: string
  number: number
  pull_request?: unknown
}

export interface NotificationResult {
  created: number
  notified: number
  recovered: number
  skippedForCutover: boolean
  skippedForMigration: boolean
}

export function generateReviewPreviewToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashReviewPreviewToken(token: string): string {
  if (!PREVIEW_TOKEN_PATTERN.test(token)) {
    throw new Error('Review preview capability must be a 256-bit base64url token.')
  }
  return createHash('sha256').update(token).digest('hex')
}

export function buildReviewPreviewUrl(submissionId: string, token: string, siteId: SiteId): string {
  hashReviewPreviewToken(token)
  return `https://${siteId}/admin/submissions/${encodeURIComponent(submissionId)}/preview/${encodeURIComponent(token)}/`
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

export function validateNotificationContext(env: NodeJS.ProcessEnv): SiteTarget {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Remote submission notification requires GitHub Actions.')
  }
  if (!env.GITHUB_WORKFLOW_REF?.includes(WORKFLOW_PATH)) {
    throw new Error('Remote submission notification requires notify-d1-submissions.yml.')
  }
  if (env.GITHUB_REF !== 'refs/heads/main' || !env.GITHUB_SHA) {
    throw new Error('Remote submission notification requires reviewed main.')
  }
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    throw new Error(`Remote submission notification requires ${EXPECTED_REPOSITORY}.`)
  }
  return resolveSiteTarget(env.DEPLOY_SITE_ID)
}

function d1Error(payload: D1Response, status: number): Error {
  return new Error(
    payload.errors
      ?.map(item => item.message)
      .filter(Boolean)
      .join('; ') || `D1 API query failed with status ${status}.`
  )
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
    throw d1Error(payload, response.status)
  }
  return payload.result
}

function asRows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[]
}

function issueMarker(submissionId: string, siteId: SiteId): string {
  return `<!-- d1-submission: ${siteId}:${submissionId} -->`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('@', '&#64;')
}

function textBlock(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`
}

function issueTitle(submission: SubmissionRow): string {
  const name = submission.name.replace(/\s+/gu, ' ').trim()
  const title = `[Submission review] ${name} (${submission.slug})`
  return title.length <= MAX_ISSUE_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_ISSUE_TITLE_LENGTH - 1)}…`
}

export function buildReviewIssue(input: {
  faqs: FaqRow[]
  previewUrl: string
  resources: ResourceRow[]
  submission: SubmissionRow
  target: SiteTarget
}): { body: string; title: string } {
  const { submission } = input
  const resources =
    input.resources.length === 0
      ? '_None supplied._'
      : input.resources
          .map(resource => `- **${escapeHtml(resource.label)}:** <${escapeHtml(resource.url)}>`)
          .join('\n')
  const faqs =
    input.faqs.length === 0
      ? '_None supplied._'
      : input.faqs
          .map(
            faq =>
              `<details><summary>${escapeHtml(faq.question)}</summary>\n\n${textBlock(
                faq.answer
              )}\n</details>`
          )
          .join('\n\n')

  return {
    title: issueTitle(submission),
    body: `${issueMarker(submission.id, input.target.siteId)}

## Badge-verified directory submission

This private issue is an admin notification. The authoritative submission is stored
in Cloudflare D1.

| Field | Value |
| --- | --- |
| Submission ID | \`${submission.id}\` |
| Name | ${escapeHtml(submission.name)} |
| Website | <${escapeHtml(submission.website)}> |
| Category | \`${escapeHtml(submission.category_slug)}\` |
| Badge verified | ${escapeHtml(submission.badge_verified_at)} |
| Verification attempts | ${submission.verification_attempts} |
| Submitted | ${escapeHtml(submission.created_at)} |
| Logo | <${escapeHtml(submission.logo_url)}> |
| Video | ${submission.video_url ? `<${escapeHtml(submission.video_url)}>` : '_None supplied._'} |

### Short description

${textBlock(submission.description)}

### Full description

${textBlock(submission.content)}

### Resource links

${resources}

### FAQs

${faqs}

### Private draft preview

[Open the rendered draft listing preview](${input.previewUrl})

This bearer link is private to repository reviewers. Do not share it. It stops
working after the submission is approved or rejected.

### Admin decision

1. Review the submitted site, content, category, and installed badge.
2. Open the [Review D1 submission workflow](${REVIEW_WORKFLOW_URL}).
3. Run it from \`main\` with submission ID \`${submission.id}\`.
4. Choose **approve** to publish or **reject** to decline, and enter
   \`${input.target.confirmation.submission}\`.

The decision workflow updates D1 first, then comments on and closes this issue.
`
  }
}

async function githubRequest<T>(
  path: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetcher(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required(env, 'GITHUB_TOKEN')}`,
      'Content-Type': 'application/json',
      'User-Agent': 'directory-platform-d1-submission-notifier',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub API request ${path} failed with status ${response.status}.`)
  }
  return (await response.json()) as T
}

async function findExistingIssue(
  submissionId: string,
  siteId: SiteId,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<GitHubIssue | null> {
  const marker = issueMarker(submissionId, siteId)
  for (let page = 1; page <= 10; page += 1) {
    const issues = await githubRequest<GitHubIssue[]>(
      `/repos/${EXPECTED_REPOSITORY}/issues?state=all&per_page=100&page=${page}`,
      env,
      fetcher
    )
    const match = issues.find(issue => !issue.pull_request && issue.body?.includes(marker))
    if (match) return match
    if (issues.length < 100) return null
  }
  throw new Error('Unable to exhaustively search existing submission review issues.')
}

async function assignIssue(
  issue: GitHubIssue,
  reviewer: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<void> {
  if (issue.assignees?.some(assignee => assignee.login === reviewer)) return
  await githubRequest(
    `/repos/${EXPECTED_REPOSITORY}/issues/${issue.number}/assignees`,
    env,
    fetcher,
    { method: 'POST', body: JSON.stringify({ assignees: [reviewer] }) }
  )
}

async function createOrRecoverIssue(
  details: ReturnType<typeof buildReviewIssue>,
  submissionId: string,
  siteId: SiteId,
  reviewer: string,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): Promise<{ created: boolean; issue: GitHubIssue }> {
  const existing = await findExistingIssue(submissionId, siteId, env, fetcher)
  if (existing) {
    await assignIssue(existing, reviewer, env, fetcher)
    const issue = await githubRequest<GitHubIssue>(
      `/repos/${EXPECTED_REPOSITORY}/issues/${existing.number}`,
      env,
      fetcher,
      {
        method: 'PATCH',
        body: JSON.stringify({
          body: details.body,
          title: details.title
        })
      }
    )
    return { created: false, issue }
  }
  const issue = await githubRequest<GitHubIssue>(
    `/repos/${EXPECTED_REPOSITORY}/issues`,
    env,
    fetcher,
    {
      method: 'POST',
      body: JSON.stringify({
        assignees: [reviewer],
        body: details.body,
        title: details.title
      })
    }
  )
  return { created: true, issue }
}

function missingNotificationMigration(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error.message.includes('no such table') &&
      error.message.includes('listing_submission_notifications')) ||
      (error.message.includes('no such column') && error.message.includes('preview_token_hash')))
  )
}

export async function notifyVerifiedSubmissions(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  tokenFactory: () => string = generateReviewPreviewToken
): Promise<NotificationResult> {
  const target = validateNotificationContext(env)
  const reviewer = required(env, 'SUBMISSION_REVIEWER_GITHUB_LOGIN')
  required(env, 'GITHUB_TOKEN')

  const lock = await query([selectActiveCutoverLockPlan(target.siteId)], env, fetcher)
  if (hasActiveCutoverLock(lock[0]?.results ?? [])) {
    return {
      created: 0,
      notified: 0,
      recovered: 0,
      skippedForCutover: true,
      skippedForMigration: false
    }
  }

  let selected: D1Result[]
  try {
    selected = await query(
      selectVerifiedSubmissionNotificationPlans(target.siteId, MAX_SUBMISSIONS_PER_RUN),
      env,
      fetcher
    )
  } catch (error) {
    if (missingNotificationMigration(error)) {
      return {
        created: 0,
        notified: 0,
        recovered: 0,
        skippedForCutover: false,
        skippedForMigration: true
      }
    }
    throw error
  }

  const submissions = asRows<SubmissionRow>(selected[0])
  const resources = asRows<ResourceRow>(selected[1])
  const faqs = asRows<FaqRow>(selected[2])
  let created = 0
  let recovered = 0

  for (const submission of submissions) {
    const currentLock = await query([selectActiveCutoverLockPlan(target.siteId)], env, fetcher)
    if (hasActiveCutoverLock(currentLock[0]?.results ?? [])) {
      return {
        created,
        notified: created + recovered,
        recovered,
        skippedForCutover: true,
        skippedForMigration: false
      }
    }
    const previewToken = tokenFactory()
    const previewTokenHash = hashReviewPreviewToken(previewToken)
    const issueResult = await createOrRecoverIssue(
      buildReviewIssue({
        submission,
        target,
        previewUrl: buildReviewPreviewUrl(submission.id, previewToken, target.siteId),
        resources: resources.filter(row => row.submission_id === submission.id),
        faqs: faqs.filter(row => row.submission_id === submission.id)
      }),
      submission.id,
      target.siteId,
      reviewer,
      env,
      fetcher
    )
    if (issueResult.created) created += 1
    else recovered += 1
    await query(
      buildRecordSubmissionNotificationPlans({
        externalId: String(issueResult.issue.number),
        externalUrl: issueResult.issue.html_url,
        previewTokenHash,
        recipient: reviewer,
        siteId: target.siteId,
        submissionId: submission.id
      }),
      env,
      fetcher
    )
  }

  return {
    created,
    notified: submissions.length,
    recovered,
    skippedForCutover: false,
    skippedForMigration: false
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await notifyVerifiedSubmissions()))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
