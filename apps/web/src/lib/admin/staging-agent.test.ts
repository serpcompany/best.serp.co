/**
 * Staging's admin key (serpcompany/best.serp.co#408) through the real admin route handlers:
 * `authorizeAdminRequest()`, the decision, and D1 over node:sqlite with the checked-in migrations.
 * On staging the right key approves a submission as `staging-agent`, with no `Origin` and no
 * cookie, every audit row naming that actor and the compare-and-swap guards intact; the same
 * request writes nothing with a wrong key, in production, or locally, and the key is never logged
 * or echoed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE as adminsDelete, POST as adminsPost } from '@/app/api/admin/admins/route'
import { POST as submissionPost } from '@/app/api/admin/submissions/[id]/[action]/route'
import { SqliteD1 } from '@/db/test-support'
import { STAGING_ADMIN_KEY_HEADER } from '@/lib/auth/staging-admin-key'

const { enqueueEmail, getCloudflareContext } = vi.hoisted(() => ({
  enqueueEmail: vi.fn(async () => {}),
  getCloudflareContext: vi.fn()
}))

vi.mock('server-only', () => ({}))
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/email/server', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/email/server')>()),
  enqueueEmail
}))

/** A test value only; the real key is a staging Worker secret and is never in the repository. */
const KEY = 'route-test-staging-admin-key-0123456789abcdef'
const ORIGIN = 'https://staging.best.serp.co'

type Environment = 'local' | 'production' | 'staging'

function worker(environment: Environment, secret: string | undefined = KEY): SqliteD1 {
  const sqlite = new SqliteD1()
  sqlite.database.exec(`
    INSERT INTO categories (slug, name, sort_order) VALUES ('education', 'Education', 0);
    INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'before');
    INSERT INTO users (id, name, email, email_verified)
      VALUES ('user_maya', 'Maya', 'maya@example.com', 1);
  `)
  for (const [id, slug] of [
    ['sub_zen', 'zen.example'],
    ['sub_stale', 'stale.example']
  ]) {
    sqlite.database.exec(`
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, owner_user_id, badge_verified_at, block_key,
        block_covers_subdomains)
      VALUES ('${id}', '${slug}', 'Name ${id}', 'Short ${id}', 'https://${slug}/', 'Long ${id}',
        'education', 'https://${slug}/logo.png', 'verified', 'free', 'user_maya',
        '2026-10-06T07:00:00.000Z', '${slug}', 1)`)
  }
  getCloudflareContext.mockResolvedValue({
    ctx: { waitUntil: () => {} },
    env: {
      BETTER_AUTH_SECRET: 'route-test-auth-secret-'.repeat(2),
      BETTER_AUTH_URL: environment === 'local' ? undefined : ORIGIN,
      D1_RUNTIME_ENV: environment,
      DB: sqlite.asD1Database(),
      SITE_ENVIRONMENT: environment,
      STAGING_ADMIN_TOKEN: secret
    }
  })
  return sqlite
}

function keyed(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST'
): Request {
  return new Request(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', [STAGING_ADMIN_KEY_HEADER]: KEY, ...headers },
    method
  })
}

function approve(id: string, expectedContentVersion: number, headers?: Record<string, string>) {
  return submissionPost(
    keyed(`/api/admin/submissions/${id}/approve`, { expectedContentVersion }, headers),
    { params: Promise.resolve({ action: 'approve', id }) }
  )
}

/** Every `actor`-like column a decision writes, with the rows it wrote. */
function actors(sqlite: SqliteD1): Record<string, unknown[]> {
  const column = (sql: string) =>
    (sqlite.database.prepare(sql).all() as Array<{ actor: unknown }>).map(row => row.actor)
  return {
    allowlist: column(
      "SELECT added_by AS actor FROM admin_allowlist WHERE email <> 'devin@serp.co' ORDER BY email"
    ),
    publications: column('SELECT actor FROM publication_runs ORDER BY id'),
    submissionEvents: column(
      "SELECT actor FROM listing_submission_events WHERE event_type <> 'submitted' ORDER BY id"
    )
  }
}

const logged: unknown[][] = []

beforeEach(() => {
  logged.length = 0
  enqueueEmail.mockClear()
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  }
})

afterEach(() => {
  // The key never reaches a log line, whatever the outcome.
  expect(JSON.stringify(logged)).not.toContain(KEY)
  vi.restoreAllMocks()
})

describe('the staging admin key through the admin API', () => {
  it('approves a submission on staging as staging-agent, without an Origin or a cookie', async () => {
    const sqlite = worker('staging')
    const response = await approve('sub_zen', 1)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ listingSlug: 'zen.example', ok: true, replayed: false })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(
      sqlite.database
        .prepare("SELECT status, is_active FROM listings WHERE slug = 'zen.example'")
        .get()
    ).toEqual({ is_active: 1, status: 'approved' })
    expect(actors(sqlite)).toEqual({
      allowlist: [],
      publications: ['staging-agent'],
      submissionEvents: ['staging-agent']
    })
    // The approval email still goes to the Creator.
    expect(enqueueEmail).toHaveBeenCalledWith(
      'listing-approved',
      expect.objectContaining({ to: 'maya@example.com' })
    )
  })

  it('keeps the plans’ guards: a stale version is a 409 and writes nothing', async () => {
    const sqlite = worker('staging')
    const response = await approve('sub_stale', 7)
    expect(response.status).toBe(409)
    expect(actors(sqlite)).toEqual({ allowlist: [], publications: [], submissionEvents: [] })
  })

  it('never adds or removes an admin: 403, and the allowlist is unchanged', async () => {
    const sqlite = worker('staging')
    sqlite.database
      .prepare(
        "INSERT INTO admin_allowlist (email, added_by) VALUES ('second@example.com', 'test')"
      )
      .run()
    const emails = () =>
      sqlite.database.prepare('SELECT email FROM admin_allowlist ORDER BY email').all()
    const before = emails()
    const attempts = [
      { handler: adminsPost, method: 'POST', path: '/api/admin/admins' },
      { handler: adminsDelete, method: 'DELETE', path: '/api/admin/admins' },
      // Reached under another path, where the key itself matches, the route still refuses it.
      { handler: adminsPost, method: 'POST', path: '/api/admin/listings/lst_1/tags' },
      { handler: adminsDelete, method: 'DELETE', path: '/api/admin/listings/lst_1/tags' }
    ]
    for (const { handler, method, path } of attempts) {
      const email = method === 'POST' ? 'tester@example.com' : 'second@example.com'
      const response = await handler(keyed(path, { email }, {}, method))
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(await response.json()).toEqual({
        error: 'admin_key_forbidden',
        message: 'The staging admin key can’t change admins.'
      })
    }
    expect(emails()).toEqual(before)
    expect(actors(sqlite).allowlist).toEqual(['test'])
  })

  it('refuses a wrong key, even with a trusted Origin, and writes nothing', async () => {
    const sqlite = worker('staging')
    const response = await approve('sub_zen', 1, {
      origin: ORIGIN,
      [STAGING_ADMIN_KEY_HEADER]: `${KEY}-wrong`
    })
    expect(response.status).toBe(401)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({
      error: 'admin_key_rejected',
      message: 'The staging admin key was refused.'
    })
    expect(body).not.toContain(KEY)
    expect(actors(sqlite)).toEqual({ allowlist: [], publications: [], submissionEvents: [] })
  })

  it('refuses every key while the secret is shorter than 32 characters', async () => {
    const short = KEY.slice(0, 31)
    const sqlite = worker('staging', short)
    const response = await approve('sub_zen', 1, { [STAGING_ADMIN_KEY_HEADER]: short })
    expect(response.status).toBe(401)
    expect(actors(sqlite).submissionEvents).toEqual([])
  })

  it('refuses the right key in production and locally, and writes nothing (fail closed)', async () => {
    for (const environment of ['production', 'local'] as const) {
      const sqlite = worker(environment)
      const response = await approve('sub_zen', 1, { origin: ORIGIN })
      expect(response.status, environment).toBe(401)
      expect(actors(sqlite), environment).toEqual({
        allowlist: [],
        publications: [],
        submissionEvents: []
      })
    }
  })
})
