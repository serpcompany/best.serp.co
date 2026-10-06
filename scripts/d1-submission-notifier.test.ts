import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import {
  buildReviewIssue,
  buildReviewPreviewUrl,
  hashReviewPreviewToken,
  notifyVerifiedSubmissions,
  validateNotificationContext
} from './d1-submission-notifier'

const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF:
    'serpcompany/best.serp.co/.github/workflows/notify-d1-submissions.yml@refs/heads/main',
  GITHUB_REPOSITORY: 'serpcompany/best.serp.co',
  GITHUB_TOKEN: 'github-token',
  SUBMISSION_REVIEWER_GITHUB_LOGIN: 'reviewer',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_D1_DATABASE_ID: 'database',
  CLOUDFLARE_API_TOKEN: 'cloudflare-token'
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
const previewUrl = buildReviewPreviewUrl(submission.id, previewToken)

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
    for (const migration of freshMigrationNames()) {
      db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    }
    db.exec(`
      INSERT INTO listing_submissions
        (id,slug,name,description,website,content,category_slug,logo_url,status,plan)
      VALUES
        ('${submission.id}','example.com','Example','Description','https://example.com','Content',
         'seo','https://example.com/logo.png','verified','free');
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

  it('requires the dedicated main-branch GitHub workflow in this repository', () => {
    expect(() => validateNotificationContext(env)).not.toThrow()
    expect(() =>
      validateNotificationContext({
        ...env,
        GITHUB_WORKFLOW_REF: 'serpcompany/best.serp.co/.github/workflows/release.yml@main'
      })
    ).toThrow(/notify-d1-submissions/)
    expect(() =>
      validateNotificationContext({
        ...env,
        GITHUB_REPOSITORY: 'serpcompany/directory-platform-d1'
      })
    ).toThrow(/serpcompany\/best\.serp\.co/)
  })

  it('formats private review details without turning submitted mentions into notifications', () => {
    const issue = buildReviewIssue({
      submission,
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
    expect(issue.body).toContain(`<!-- d1-submission: best.serp.co:${submission.id} -->`)
    expect(issue.body).toContain('Example &#64; Product')
    expect(issue.body).toContain('A useful &lt;listing&gt;.')
    expect(issue.body).toContain('approve-best.serp.co-submission-production')
    expect(issue.body).toContain(
      'https://github.com/serpcompany/best.serp.co/actions/workflows/approve-d1-submission.yml'
    )
    expect(issue.body).toContain('https://example.com/docs')
    expect(issue.body).toContain(`[Open the rendered draft listing preview](${previewUrl})`)
    expect(issue.body).toContain('working after the submission is approved or rejected')
  })

  it('builds and hashes a bounded private review capability', () => {
    expect(previewUrl).toBe(
      `https://best.serp.co/admin/submissions/${submission.id}/preview/${previewToken}/`
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
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ body: String(init?.body ?? ''), url })
      if (url.includes('api.cloudflare.com') && requests.length === 1) {
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
      if (url.includes('/issues?state=all')) return Response.json([])
      if (url.endsWith('/issues')) {
        return Response.json({
          assignees: [{ login: 'reviewer' }],
          body: 'created',
          html_url: 'https://github.com/serpcompany/best.serp.co/issues/42',
          number: 42
        })
      }
      if (url.includes('api.cloudflare.com')) return d1Response([{ results: [] }])
      throw new Error(`Unexpected request ${url}`)
    }

    await expect(
      notifyVerifiedSubmissions(env, fetcher as typeof fetch, () => previewToken)
    ).resolves.toEqual({ created: 1, notified: 1, recovered: 0 })
    expect(requests[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query'
    )
    expect(requests[0]?.body).not.toMatch(/site_id|migration_runs/u)
    const createRequest = requests.find(request => request.url.endsWith('/issues') && request.body)
    expect(createRequest?.url).toBe('https://api.github.com/repos/serpcompany/best.serp.co/issues')
    expect(JSON.parse(createRequest?.body ?? '{}')).toEqual(
      expect.objectContaining({
        assignees: ['reviewer'],
        body: expect.stringContaining(previewUrl),
        title: '[Submission review] Example @ Product (example.com)'
      })
    )
    const d1Insert = requests.at(-1)?.body ?? ''
    expect(JSON.parse(d1Insert).batch).toHaveLength(1)
    expect(d1Insert).toContain('listing_submission_notifications')
    expect(d1Insert).toContain('preview_token_hash')
    expect(d1Insert).toContain(hashReviewPreviewToken(previewToken))
    expect(d1Insert).toContain('"42"')
    expect(d1Insert).toContain('"reviewer"')
  })

  it('recovers an already-created issue after an interrupted D1 write', async () => {
    const requests: string[] = []
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('api.cloudflare.com') && requests.length === 1) {
        return d1Response([{ results: [submission] }, { results: [] }, { results: [] }])
      }
      if (url.includes('/issues?state=all')) {
        return Response.json([
          {
            assignees: [],
            body: `<!-- d1-submission: best.serp.co:${submission.id} -->`,
            html_url: 'https://github.com/serpcompany/best.serp.co/issues/41',
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
          html_url: 'https://github.com/serpcompany/best.serp.co/issues/41',
          number: 41
        })
      }
      if (url.includes('api.cloudflare.com')) return d1Response([{ results: [] }])
      throw new Error(`Unexpected request ${url}`)
    }

    await expect(
      notifyVerifiedSubmissions(env, fetcher as typeof fetch, () => previewToken)
    ).resolves.toEqual({ created: 0, notified: 1, recovered: 1 })
    expect(requests.filter(url => url.endsWith('/issues'))).toHaveLength(0)
    expect(requests).toContain(
      'https://api.github.com/repos/serpcompany/best.serp.co/issues/41/assignees'
    )
    expect(requests).toContain('https://api.github.com/repos/serpcompany/best.serp.co/issues/41')
  })

  it('fails loudly instead of skipping when the D1 query fails', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: 'no such table: listing_submission_notifications' }]
        }),
        { status: 400 }
      )
    await expect(notifyVerifiedSubmissions(env, fetcher as typeof fetch)).rejects.toThrow(
      'no such table: listing_submission_notifications'
    )
  })
})
