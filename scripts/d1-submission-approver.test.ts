import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { approveRemoteSubmission, validateApprovalContext } from './d1-submission-approver'

const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF:
    'serpcompany/best.serp.co/.github/workflows/approve-d1-submission.yml@refs/heads/main',
  D1_SUBMISSION_APPROVAL_CONFIRM: 'approve-best.serp.co-submission-production',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_D1_DATABASE_ID: 'database',
  CLOUDFLARE_API_TOKEN: 'token'
}

const submissionId = '11111111-1111-4111-8111-111111111111'

function d1Response(results: Array<Array<Record<string, unknown>>>): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: results.map(rows => ({ success: true, results: rows }))
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}

function submissionRow(status: string, slug = 'example.com'): Record<string, unknown> {
  return {
    id: submissionId,
    slug,
    status,
    listing_id: null,
    version: 1,
    checksum: 'before'
  }
}

describe('D1 submission approval guard', () => {
  it('uses an async CLI entrypoint without unsupported top-level await', () => {
    const source = readFileSync('scripts/d1-submission-approver.ts', 'utf8')
    expect(source).toContain('async function main(): Promise<void>')
    expect(source).toContain('main().catch(error =>')
  })

  it('requires the dedicated protected workflow and exact confirmation', () => {
    expect(() => validateApprovalContext(env)).not.toThrow()
    expect(() =>
      validateApprovalContext({
        ...env,
        GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/release.yml@main'
      })
    ).toThrow(/approve-d1-submission/)
    expect(() =>
      validateApprovalContext({
        ...env,
        D1_SUBMISSION_APPROVAL_CONFIRM: 'approve-serp.software-submission-production'
      })
    ).toThrow(/approve-best\.serp\.co-submission-production/)
    expect(() => validateApprovalContext({ ...env, GITHUB_REF: 'refs/heads/feature' })).toThrow(
      /reviewed main/
    )
  })

  it('requires the explicit D1 database identity before querying', async () => {
    const { CLOUDFLARE_D1_DATABASE_ID: _databaseId, ...withoutDatabase } = env
    const fetcher = vi.fn()
    await expect(
      approveRemoteSubmission(submissionId, 'reviewer', 'approve', withoutDatabase, fetcher)
    ).rejects.toThrow(/CLOUDFLARE_D1_DATABASE_ID/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses an unverified submission before sending mutation statements', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(d1Response([[submissionRow('pending_badge')]]))
    await expect(
      approveRemoteSubmission(submissionId, 'reviewer', 'approve', env, fetcher as typeof fetch)
    ).rejects.toThrow(/badge-verified/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('publication_state ps ON ps.id=1')
  })

  it('refuses to publish a slug that ends in a file extension', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(d1Response([[submissionRow('verified', 'chart.js')]]))
    await expect(
      approveRemoteSubmission(submissionId, 'reviewer', 'approve', env, fetcher as typeof fetch)
    ).rejects.toThrow(/file extension/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('closes a pending submission without publishing it', async () => {
    const requests: string[] = []
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(init?.body))
      return requests.length === 1
        ? d1Response([[submissionRow('pending_badge')]])
        : d1Response([[], [], []])
    }
    await expect(
      approveRemoteSubmission(submissionId, 'reviewer', 'reject', env, fetcher as typeof fetch)
    ).resolves.toEqual({ idempotent: false, listingId: null })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("status='rejected'")
    expect(requests[1]).not.toContain('INSERT INTO listings')
  })

  it('atomically promotes a verified normalized submission', async () => {
    const db = new DatabaseSync(':memory:')
    for (const migration of freshMigrationNames()) {
      db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    }
    db.exec(`
      INSERT INTO categories (id,slug,name) VALUES (1,'seo','SEO');
      INSERT INTO publication_state (id,version,manifest_id,checksum) VALUES (1,1,NULL,'before');
      INSERT INTO listing_submissions
        (id,slug,name,description,website,content,category_slug,logo_url,video_url,status,access_token_hash,badge_verified_at)
      VALUES
        ('${submissionId}','example.com','Example','Description','https://example.com','Content','seo',
         'https://example.com/logo.png',NULL,'verified','${'f'.repeat(64)}','2026-01-01');
      INSERT INTO listing_submission_resource_links (submission_id,label,url,sort_order)
        VALUES ('${submissionId}','Docs','https://example.com/docs',0);
      INSERT INTO listing_submission_faqs (submission_id,question,answer,sort_order)
        VALUES ('${submissionId}','Question','Answer',0);
    `)
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        batch: Array<{ sql: string; params: SQLInputValue[] }>
      }
      const results: Array<Array<Record<string, unknown>>> = []
      db.exec('BEGIN')
      try {
        for (const item of payload.batch) {
          const statement = db.prepare(item.sql)
          if (item.sql.trimStart().toUpperCase().startsWith('SELECT')) {
            results.push(statement.all(...item.params) as Array<Record<string, unknown>>)
          } else {
            statement.run(...item.params)
            results.push([])
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return d1Response(results)
    }
    const result = await approveRemoteSubmission(
      submissionId,
      'reviewer',
      'approve',
      env,
      fetcher as typeof fetch
    )
    expect(result).toEqual({ idempotent: false, listingId: `submission_${submissionId}` })
    expect(
      db
        .prepare(
          "SELECT status,source_kind,published_at IS NOT NULL AS published FROM listings WHERE slug='example.com'"
        )
        .get()
    ).toEqual({ status: 'approved', source_kind: 'verified-submission', published: 1 })
    expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
      status: 'approved',
      listing_id: result.listingId
    })
    expect(db.prepare('SELECT COUNT(*) count FROM listing_resource_links').get()).toEqual({
      count: 1
    })
    expect(db.prepare('SELECT COUNT(*) count FROM listing_faqs').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 2
    })
    expect(
      db.prepare('SELECT outcome,affected_routes,published_version FROM publication_runs').get()
    ).toEqual({
      outcome: 'succeeded',
      affected_routes: '/products/example.com/',
      published_version: 2
    })

    await expect(
      approveRemoteSubmission(submissionId, 'reviewer', 'approve', env, fetcher as typeof fetch)
    ).resolves.toEqual({ idempotent: true, listingId: result.listingId })
  })
})
