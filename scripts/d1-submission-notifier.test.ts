import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import {
  buildReviewIssue,
  buildReviewPreviewUrl,
  hashReviewPreviewToken,
  notifyVerifiedSubmissions,
  validateNotificationContext
} from './d1-submission-notifier'
import { siteTargets } from './site-targets'

const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF:
    'serpcompany/directory-platform-d1/.github/workflows/notify-d1-submissions.yml@refs/heads/main',
  GITHUB_REPOSITORY: 'serpcompany/directory-platform-d1',
  GITHUB_TOKEN: 'github-token',
  SUBMISSION_REVIEWER_GITHUB_LOGIN: 'reviewer',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: 'database',
  CLOUDFLARE_API_TOKEN: 'cloudflare-token',
  DEPLOY_SITE_ID: 'serp.software'
}

const submission = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'example.com',
  name: 'Example @ Product',
  description: 'A useful <listing>.',
  website: 'https://example.com/',
  content: 'Longer product content.',
  category_slug: 'seo',
  logo_url: 'https://example.com/logo.png',
  video_url: null,
  verification_attempts: 1,
  badge_verified_at: '2026-07-30 06:00:00',
  created_at: '2026-07-30 05:55:00'
}
const previewToken = 'a'.repeat(43)
const previewUrl = buildReviewPreviewUrl(submission.id, previewToken, 'serp.software')

function githubExpression(expression: string): string {
  return `$${`{{ ${expression} }}`}`
}

function d1Response(results: Array<{ results: Array<Record<string, unknown>> }>): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: results.map(result => ({ success: true, ...result }))
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}

describe('D1 submission notifier', () => {
  it('stores one notification per submission and channel with cascade cleanup', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE listing_submissions (id TEXT PRIMARY KEY) STRICT;
      ${readFileSync('d1/migrations/0007_submission_notifications.sql', 'utf8')}
      ${readFileSync('d1/migrations/0008_submission_review_preview.sql', 'utf8')}
      INSERT INTO listing_submissions (id) VALUES ('${submission.id}');
      INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
      VALUES
        ('${submission.id}','github_issue','42','https://github.com/example/issues/42','reviewer',
         '${hashReviewPreviewToken(previewToken)}');
    `)
    expect(
      db
        .prepare(
          'SELECT channel,external_id,recipient,preview_token_hash FROM listing_submission_notifications WHERE submission_id=?'
        )
        .get(submission.id)
    ).toEqual({
      channel: 'github_issue',
      external_id: '42',
      recipient: 'reviewer',
      preview_token_hash: hashReviewPreviewToken(previewToken)
    })
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_submission_notifications
            (submission_id,channel,external_id,external_url,recipient)
          VALUES (?,?,?,?,?)`
        )
        .run(
          submission.id,
          'github_issue',
          '43',
          'https://github.com/example/issues/43',
          'reviewer'
        )
    ).toThrow(/UNIQUE/)
    db.prepare('DELETE FROM listing_submissions WHERE id=?').run(submission.id)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM listing_submission_notifications').get()
    ).toEqual({ count: 0 })
  })

  it('requires the dedicated main-branch GitHub workflow', () => {
    expect(() => validateNotificationContext(env)).not.toThrow()
    expect(() =>
      validateNotificationContext({
        ...env,
        GITHUB_WORKFLOW_REF: 'serpcompany/directory-platform-d1/.github/workflows/release.yml@main'
      })
    ).toThrow(/notify-d1-submissions/)
    expect(() =>
      validateNotificationContext({ ...env, GITHUB_REPOSITORY: 'other/repository' })
    ).toThrow(/serpcompany\/directory-platform-d1/)
  })

  it('formats private review details without turning submitted mentions into notifications', () => {
    const issue = buildReviewIssue({
      submission,
      target: siteTargets['serp.software'],
      previewUrl,
      resources: [
        {
          submission_id: submission.id,
          label: 'Docs',
          url: 'https://example.com/docs',
          sort_order: 0
        }
      ],
      faqs: [
        {
          submission_id: submission.id,
          question: 'Works?',
          answer: 'Yes.',
          sort_order: 0
        }
      ]
    })
    expect(issue.title).toBe('[Submission review] Example @ Product (example.com)')
    expect(issue.body).toContain(`<!-- d1-submission: serp.software:${submission.id} -->`)
    expect(issue.body).toContain('Example &#64; Product')
    expect(issue.body).toContain('A useful &lt;listing&gt;.')
    expect(issue.body).toContain('approve-serp.software-submission-production')
    expect(issue.body).toContain('https://example.com/docs')
    expect(issue.body).toContain(`[Open the rendered draft listing preview](${previewUrl})`)
    expect(issue.body).toContain('working after the submission is approved or rejected')
  })

  it('builds and hashes a bounded private review capability', () => {
    expect(previewUrl).toBe(
      `https://serp.software/admin/submissions/${submission.id}/preview/${previewToken}/`
    )
    expect(hashReviewPreviewToken(previewToken)).toMatch(/^[a-f0-9]{64}$/)
    expect(() => hashReviewPreviewToken('too-short')).toThrow(/256-bit base64url/)
  })

  it('bounds issue titles even when submitted names and domains are long', () => {
    const issue = buildReviewIssue({
      submission: {
        ...submission,
        name: `${'N'.repeat(60)}\n${'N'.repeat(59)}`,
        slug: `${'s'.repeat(240)}.example`
      },
      target: siteTargets['serp.software'],
      previewUrl,
      resources: [],
      faqs: []
    })
    expect(issue.title).toHaveLength(240)
    expect(issue.title.endsWith('…')).toBe(true)
    expect(issue.title).not.toContain('\n')
    expect(issue.body).toContain(submission.id)
  })

  it('creates one assigned issue and records its identity in D1', async () => {
    const requests: Array<{ body: string; url: string }> = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ body: String(init?.body ?? ''), url })
      if (url.includes('api.cloudflare.com') && requests.length === 1) {
        return d1Response([{ results: [] }])
      }
      if (url.includes('api.cloudflare.com') && requests.length === 2) {
        return d1Response([
          { results: [submission] },
          {
            results: [
              {
                submission_id: submission.id,
                label: 'Docs',
                url: 'https://example.com/docs',
                sort_order: 0
              }
            ]
          },
          { results: [] }
        ])
      }
      if (url.includes('api.cloudflare.com') && String(init?.body).includes('migration_runs')) {
        return d1Response([{ results: [] }])
      }
      if (url.includes('/issues?state=all')) return Response.json([])
      if (url.endsWith('/issues')) {
        return Response.json({
          assignees: [{ login: 'reviewer' }],
          body: 'created',
          html_url: 'https://github.com/serpcompany/directory-platform-d1/issues/42',
          number: 42
        })
      }
      if (url.includes('api.cloudflare.com')) return d1Response([{ results: [] }])
      throw new Error(`Unexpected request ${url}`)
    }

    await expect(
      notifyVerifiedSubmissions(env, fetcher as typeof fetch, () => previewToken)
    ).resolves.toEqual({
      created: 1,
      notified: 1,
      recovered: 0,
      skippedForCutover: false,
      skippedForMigration: false
    })
    const createRequest = requests.find(request => request.url.endsWith('/issues') && request.body)
    expect(JSON.parse(createRequest?.body ?? '{}')).toEqual(
      expect.objectContaining({
        assignees: ['reviewer'],
        body: expect.stringContaining(previewUrl),
        title: '[Submission review] Example @ Product (example.com)'
      })
    )
    const d1Insert = requests.at(-1)?.body ?? ''
    expect(d1Insert).toContain('listing_submission_notifications')
    expect(d1Insert).toContain('preview_token_hash')
    expect(d1Insert).toContain(hashReviewPreviewToken(previewToken))
    expect(d1Insert).toContain('"42"')
    expect(d1Insert).toContain('"reviewer"')
  })

  it('does not call GitHub or mutate the notification ledger while cutover is locked', async () => {
    const requests: string[] = []
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('api.cloudflare.com')) {
        return d1Response([{ results: [{ id: 'd1-cutover-lock-v1:serp.software:run-1' }] }])
      }
      throw new Error(`GitHub side effect attempted while frozen: ${url}`)
    }

    await expect(notifyVerifiedSubmissions(env, fetcher as typeof fetch)).resolves.toEqual({
      created: 0,
      notified: 0,
      recovered: 0,
      skippedForCutover: true,
      skippedForMigration: false
    })
    expect(requests).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query'
    ])
  })

  it('recovers an already-created issue after an interrupted D1 write', async () => {
    const requests: string[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('api.cloudflare.com') && requests.length === 1) {
        return d1Response([{ results: [] }])
      }
      if (url.includes('api.cloudflare.com') && requests.length === 2) {
        return d1Response([{ results: [submission] }, { results: [] }, { results: [] }])
      }
      if (url.includes('api.cloudflare.com') && String(init?.body).includes('migration_runs')) {
        return d1Response([{ results: [] }])
      }
      if (url.includes('/issues?state=all')) {
        return Response.json([
          {
            assignees: [],
            body: `<!-- d1-submission: serp.software:${submission.id} -->`,
            html_url: 'https://github.com/serpcompany/directory-platform-d1/issues/41',
            number: 41
          }
        ])
      }
      if (url.endsWith('/issues/41/assignees')) return Response.json({})
      if (url.endsWith('/issues/41') && init?.method === 'PATCH') {
        expect(String(init.body)).toContain(previewUrl)
        return Response.json({
          assignees: [{ login: 'reviewer' }],
          body: String(init.body),
          html_url: 'https://github.com/serpcompany/directory-platform-d1/issues/41',
          number: 41
        })
      }
      if (url.includes('api.cloudflare.com')) return d1Response([{ results: [] }])
      throw new Error(`Unexpected request ${url}`)
    }

    await expect(
      notifyVerifiedSubmissions(env, fetcher as typeof fetch, () => previewToken)
    ).resolves.toEqual({
      created: 0,
      notified: 1,
      recovered: 1,
      skippedForCutover: false,
      skippedForMigration: false
    })
    expect(requests.filter(url => url.endsWith('/issues'))).toHaveLength(0)
    expect(requests).toContain(
      'https://api.github.com/repos/serpcompany/directory-platform-d1/issues/41/assignees'
    )
    expect(requests).toContain(
      'https://api.github.com/repos/serpcompany/directory-platform-d1/issues/41'
    )
  })

  it('safely waits for the release that applies its migration', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(d1Response([{ results: [] }]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: 'no such table: listing_submission_notifications' }]
          }),
          { status: 400 }
        )
      )
    await expect(notifyVerifiedSubmissions(env, fetcher as typeof fetch)).resolves.toEqual({
      created: 0,
      notified: 0,
      recovered: 0,
      skippedForCutover: false,
      skippedForMigration: true
    })
  })

  it('safely waits when reviewed main precedes the preview-capability migration', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(d1Response([{ results: [] }]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: 'no such column: notification.preview_token_hash' }]
          }),
          { status: 400 }
        )
      )
    await expect(notifyVerifiedSubmissions(env, fetcher as typeof fetch)).resolves.toEqual({
      created: 0,
      notified: 0,
      recovered: 0,
      skippedForCutover: false,
      skippedForMigration: true
    })
  })

  it('runs on a five-minute schedule with least-privilege issue access', () => {
    const source = readFileSync('.github/workflows/notify-d1-submissions.yml', 'utf8')
    const workflow = yaml.load(source) as {
      jobs: {
        notify: { environment: { name: string }; steps: Array<{ env?: object; run?: string }> }
      }
      on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown }
      permissions: Record<string, string>
    }
    expect(workflow.on.schedule).toEqual([{ cron: '*/5 * * * *' }])
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' })
    expect(workflow.jobs.notify.environment.name).toBe('${{ matrix.environment }}')
    expect(source).toContain('site_id: pornvideodownloaders.com')
    expect(source).toContain('environment: pornvideodownloaders-production')
    expect(workflow.jobs.notify.steps.at(-1)?.run).toBe('pnpm d1:notify:production')
    expect(workflow.jobs.notify.steps.at(-1)?.env).toEqual(
      expect.objectContaining({
        SUBMISSION_REVIEWER_GITHUB_LOGIN: githubExpression('vars.SUBMISSION_REVIEWER_GITHUB_LOGIN')
      })
    )
  })

  it('closes the matching issue only after the protected D1 decision', () => {
    const source = readFileSync('.github/workflows/approve-d1-submission.yml', 'utf8')
    const workflow = yaml.load(source) as {
      jobs: { approve: { steps: Array<{ name: string; run?: string; uses?: string }> } }
      permissions: Record<string, string>
    }
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' })
    const reviewIndex = workflow.jobs.approve.steps.findIndex(
      step => step.name === 'Review D1 submission'
    )
    const closeIndex = workflow.jobs.approve.steps.findIndex(
      step => step.name === 'Close the admin review issue'
    )
    expect(reviewIndex).toBeGreaterThan(-1)
    expect(closeIndex).toBeGreaterThan(reviewIndex)
    expect(workflow.jobs.approve.steps[closeIndex]?.uses).toBe('actions/github-script@v9')
    expect(source).toContain("state_reason: 'completed'")
    expect(source).toContain("process.env.SUBMISSION_DECISION === 'approve'")
  })

  it('routes routine publication, approval, and notification only to replacement Production D1', () => {
    const replacementId = githubExpression(
      'secrets.CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID'
    )
    const replacementName = githubExpression(
      'secrets.CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME'
    )
    for (const path of [
      '.github/workflows/publish-d1.yml',
      '.github/workflows/approve-d1-submission.yml'
    ]) {
      const source = readFileSync(path, 'utf8')
      const workflow = yaml.load(source) as {
        jobs: Record<
          string,
          {
            steps: Array<{
              env?: Record<string, string>
              name?: string
              with?: Record<string, string>
            }>
          }
        >
      }
      const steps = Object.values(workflow.jobs)[0]?.steps ?? []
      const backup = steps.find(step => step.name === 'Back up production D1')
      expect(backup?.env).toEqual(
        expect.objectContaining({
          CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: replacementId,
          CLOUDFLARE_D1_PRODUCTION_DATABASE_NAME: replacementName,
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: replacementId,
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME: replacementName,
          D1_RELEASE_GENERATION: 'replatform'
        })
      )
      expect(source).not.toContain('secrets.CLOUDFLARE_D1_PRODUCTION_DATABASE_ID')
      expect(source).not.toContain('secrets.CLOUDFLARE_D1_PRODUCTION_DATABASE_NAME')
      expect(steps.find(step => step.name?.startsWith('Retain pre-'))?.with?.path).toContain(
        '.replatform.sql'
      )
    }

    const notifySource = readFileSync('.github/workflows/notify-d1-submissions.yml', 'utf8')
    const notify = yaml.load(notifySource) as {
      jobs: { notify: { steps: Array<{ env?: Record<string, string>; name?: string }> } }
    }
    const notifyStep = notify.jobs.notify.steps.find(
      step => step.name === 'Notify the configured submission reviewer'
    )
    expect(notifyStep?.env?.CLOUDFLARE_D1_PRODUCTION_DATABASE_ID).toBe(replacementId)
    expect(notifySource).not.toContain('secrets.CLOUDFLARE_D1_PRODUCTION_DATABASE_ID')
  })
})
