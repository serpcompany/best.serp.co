import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { approveRemoteSubmission, validateApprovalContext } from './d1-submission-approver'

const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF:
    'serpcompany/directory-platform-d1/.github/workflows/approve-d1-submission.yml@refs/heads/main',
  D1_SUBMISSION_APPROVAL_CONFIRM: 'approve-serp.software-submission-production',
  DEPLOY_SITE_ID: 'serp.software',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: 'database',
  CLOUDFLARE_API_TOKEN: 'token'
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
  })

  it('refuses an unverified submission before sending mutation statements', async () => {
    let calls = 0
    const fetcher = async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results:
                calls === 1
                  ? []
                  : [
                      {
                        id: '11111111-1111-4111-8111-111111111111',
                        slug: 'example.com',
                        status: 'pending_badge',
                        listing_id: null,
                        version: 1,
                        checksum: 'before'
                      }
                    ]
            }
          ]
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    await expect(
      approveRemoteSubmission(
        '11111111-1111-4111-8111-111111111111',
        'reviewer',
        'approve',
        env,
        fetcher as typeof fetch
      )
    ).rejects.toThrow(/badge-verified/)
  })

  it('closes a pending submission without publishing it', async () => {
    const requests: string[] = []
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body))
      return new Response(
        JSON.stringify({
          success: true,
          result:
            requests.length === 1
              ? [{ success: true, results: [] }]
              : requests.length === 2
                ? [
                    {
                      success: true,
                      results: [
                        {
                          id: '11111111-1111-4111-8111-111111111111',
                          slug: 'example.com',
                          status: 'pending_badge',
                          listing_id: null,
                          version: 1,
                          checksum: 'before'
                        }
                      ]
                    }
                  ]
                : [
                    { success: true, results: [] },
                    { success: true, results: [] }
                  ]
        })
      )
    }
    await expect(
      approveRemoteSubmission(
        '11111111-1111-4111-8111-111111111111',
        'reviewer',
        'reject',
        env,
        fetcher as typeof fetch
      )
    ).resolves.toEqual({ idempotent: false, listingId: null })
    expect(requests[2]).toContain("status='rejected'")
    expect(requests[2]).not.toContain('INSERT INTO listings')
  })

  it('atomically promotes a verified normalized submission', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY,site_id TEXT,slug TEXT,is_active INTEGER);
      CREATE TABLE listing_submissions (id TEXT PRIMARY KEY,site_id TEXT,slug TEXT,name TEXT,description TEXT,website TEXT,content TEXT,category_slug TEXT,logo_url TEXT,video_url TEXT,status TEXT,listing_id TEXT,reviewed_at TEXT,reviewed_by TEXT,updated_at TEXT);
      CREATE TABLE listing_submission_resource_links (submission_id TEXT,label TEXT,url TEXT,sort_order INTEGER);
      CREATE TABLE listing_submission_faqs (submission_id TEXT,question TEXT,answer TEXT,sort_order INTEGER);
      CREATE TABLE listing_submission_events (submission_id TEXT,event_type TEXT,actor TEXT);
      CREATE TABLE listings (id TEXT PRIMARY KEY,site_id TEXT,slug TEXT,name TEXT,description TEXT,website TEXT,content TEXT,is_unofficial INTEGER,is_featured INTEGER,is_active INTEGER,status TEXT,source_kind TEXT,source_identity TEXT,checksum TEXT,display_order INTEGER,published_at TEXT,updated_at TEXT,UNIQUE(site_id,slug));
      CREATE TABLE listing_categories (listing_id TEXT,category_id INTEGER,sort_order INTEGER,is_primary INTEGER);
      CREATE TABLE listing_media (listing_id TEXT,kind TEXT,url TEXT,sort_order INTEGER);
      CREATE TABLE listing_resource_links (listing_id TEXT,label TEXT,url TEXT,sort_order INTEGER);
      CREATE TABLE listing_faqs (listing_id TEXT,question TEXT,answer TEXT,sort_order INTEGER);
      CREATE TABLE publication_state (site_id TEXT PRIMARY KEY,version INTEGER,manifest_id TEXT,checksum TEXT,published_at TEXT);
      CREATE TABLE publication_runs (id TEXT PRIMARY KEY,site_id TEXT,manifest_id TEXT,base_version INTEGER,published_version INTEGER,input_checksum TEXT,affected_records INTEGER,affected_routes TEXT,outcome TEXT,started_at TEXT,completed_at TEXT,actor TEXT,workflow TEXT,before_checksum TEXT,after_checksum TEXT);
      CREATE TABLE migration_runs (id TEXT PRIMARY KEY,site_id TEXT,outcome TEXT,started_at TEXT);
      INSERT INTO categories VALUES (1,'serp.software','adult',1);
      INSERT INTO publication_state VALUES ('serp.software',1,NULL,'before','2026-01-01');
      INSERT INTO listing_submissions VALUES ('11111111-1111-4111-8111-111111111111','serp.software','example.com','Example','Description','https://example.com','Content','adult','https://example.com/logo.png',NULL,'verified',NULL,NULL,NULL,'2026-01-01');
      INSERT INTO listing_submission_resource_links VALUES ('11111111-1111-4111-8111-111111111111','Docs','https://example.com/docs',0);
      INSERT INTO listing_submission_faqs VALUES ('11111111-1111-4111-8111-111111111111','Question','Answer',0);
    `)
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        batch: Array<{ sql: string; params: Array<string | number | null> }>
      }
      const results: Array<{ success: true; results: Array<Record<string, unknown>> }> = []
      db.exec('BEGIN')
      try {
        for (const item of payload.batch) {
          const statement = db.prepare(item.sql)
          let rows: Array<Record<string, unknown>> = []
          if (item.sql.trimStart().toUpperCase().startsWith('SELECT')) {
            rows = statement.all(...item.params) as Array<Record<string, unknown>>
          } else {
            statement.run(...item.params)
          }
          results.push({ success: true, results: rows })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return new Response(JSON.stringify({ success: true, result: results }))
    }
    const result = await approveRemoteSubmission(
      '11111111-1111-4111-8111-111111111111',
      'reviewer',
      'approve',
      env,
      fetcher as typeof fetch
    )
    expect(result.idempotent).toBe(false)
    expect(
      db.prepare("SELECT status,source_kind FROM listings WHERE slug='example.com'").get()
    ).toEqual({
      status: 'approved',
      source_kind: 'verified-submission'
    })
    expect(db.prepare('SELECT status,listing_id FROM listing_submissions').get()).toEqual({
      status: 'approved',
      listing_id: result.listingId
    })
    expect(db.prepare('SELECT COUNT(*) count FROM listing_resource_links').get()).toEqual({
      count: 1
    })
    expect(db.prepare('SELECT COUNT(*) count FROM listing_faqs').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 2 })
  })

  it('refuses approval before selecting or mutating a submission while cutover is locked', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: [{ id: 'd1-cutover-lock-v1:serp.software:run-1' }]
            }
          ]
        })
      )
    )
    await expect(
      approveRemoteSubmission(
        '11111111-1111-4111-8111-111111111111',
        'reviewer',
        'approve',
        env,
        fetcher
      )
    ).rejects.toMatchObject({ code: 'cutover_frozen', status: 503 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
