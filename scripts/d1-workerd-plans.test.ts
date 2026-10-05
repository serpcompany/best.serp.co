import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildExpireDraftPlans,
  buildMarkDraftReminderSentPlans,
  selectDraftRemindersDuePlan,
  selectExpiredDraftsPlan
} from '@serpdirectory/data-ops/draft-plans'
import type { StatementPlan } from '@serpdirectory/data-ops/plan-support'
import {
  buildApproveLiveSubmissionPlans,
  buildChooseSubmissionPlanPlans,
  buildRecordSubmissionPaymentPlans,
  buildRefundSubmissionPlans,
  buildRejectSubmissionPlans
} from '@serpdirectory/data-ops/submission-plans'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { project } from './project'

/**
 * The #62 statement plans against Wrangler-local D1 (workerd), not only node:sqlite: D1 has its
 * own limits (50-byte LIKE/GLOB patterns, 100 bound parameters per statement, 32 function
 * arguments) that node:sqlite does not apply, so a CHECK, trigger, or plan that breaks on D1
 * fails here (#74 review round 2). The schema comes from `pnpm db:migrate:local` on a fresh
 * state directory; the binding is the same persisted database, opened through
 * `getPlatformProxy`.
 */
const NOW = '2026-10-06T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const daysBefore = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString()

let stateDirectory: string
let dispose: (() => Promise<void>) | undefined
let db: D1Database

async function run(plans: StatementPlan[]): Promise<void> {
  await db.batch(plans.map(plan => db.prepare(plan.sql).bind(...plan.params)))
}

async function all<T>(plan: StatementPlan): Promise<T[]> {
  return (
    await db
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<T>()
  ).results
}

async function first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...params)
    .first<T>()
}

async function publicationAt(action: string) {
  const state = await first<{ checksum: string; version: number }>(
    'SELECT version, checksum FROM publication_state WHERE id = 1'
  )
  if (!state) throw new Error('Missing publication state.')
  const { prepareCatalogPublication } = await import('@serpdirectory/data-ops/plan-support')
  return prepareCatalogPublication({
    action,
    actor: 'workerd-test',
    affectedRoutes: '/products/paid.example/',
    checksum: state.checksum,
    entityId: 'sub-paid',
    now: NOW,
    version: state.version,
    workflow: 'test/workerd'
  })
}

/**
 * A native draft written the way #63's intake will write it. The keys are what `urlKey()`
 * returns for these hosts (unit-tested in `packages/data-ops/src/url-key.test.ts`): a
 * registrable domain covers its subdomains; a public suffix is an exact-host key.
 */
const PUBLIC_SUFFIXES = new Set(['github.io'])

function keyFor(host: string): { blockKey: string; coversSubdomains: boolean; hostKey: string } {
  if (PUBLIC_SUFFIXES.has(host)) return { blockKey: host, coversSubdomains: false, hostKey: host }
  return { blockKey: host.split('.').slice(-2).join('.'), coversSubdomains: true, hostKey: host }
}

async function insertDraft(id: string, website: string, savedAt: string): Promise<void> {
  const key = keyFor(new URL(website).hostname)
  await db
    .prepare(
      `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,description,
        website,content,category_slug,logo_url,status,plan,owner_user_id,draft_saved_at)
      VALUES (?,?,?,?,?,'Description',?,'Content','tools',
        'https://example.com/logo.png','draft',NULL,'user_owner',?)`
    )
    .bind(id, key.hostKey, key.blockKey, key.coversSubdomains ? 1 : 0, id, website, savedAt)
    .run()
}

beforeAll(async () => {
  stateDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-workerd-'))
  execFileSync('pnpm', ['tsx', 'scripts/d1-local-guard.ts', 'migrate'], {
    env: {
      ...process.env,
      HARNESS_D1_STATE_DIRECTORY: stateDirectory,
      WRANGLER_SEND_METRICS: 'false'
    },
    stdio: 'ignore'
  })
  const configPath = join(stateDirectory, 'wrangler.jsonc')
  writeFileSync(
    configPath,
    JSON.stringify({
      compatibility_date: '2026-07-13',
      d1_databases: [
        {
          binding: 'DB',
          database_id: project.local.databaseId,
          database_name: project.local.databaseName
        }
      ],
      name: 'best-serp-co-workerd-test'
    })
  )
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    // `--persist-to <dir>` stores under <dir>/v3, which is what getPlatformProxy takes.
    persist: { path: resolve(stateDirectory, 'drizzle', 'best-serp-co', 'v3') }
  })
  dispose = () => proxy.dispose()
  db = proxy.env.DB
  await db.batch([
    db.prepare("INSERT INTO categories (slug, name) VALUES ('tools', 'Tools')"),
    db.prepare(
      "INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'workerd-before')"
    ),
    db.prepare(
      "INSERT INTO users (id, name, email) VALUES ('user_owner', 'Owner', 'owner@example.com')"
    )
  ])
}, 180_000)

afterAll(async () => {
  await dispose?.()
  if (stateDirectory) rmSync(stateDirectory, { force: true, recursive: true })
})

describe('#62 plans on Wrangler-local D1 (workerd)', () => {
  it('applied every migration to the persisted database', async () => {
    const migrations = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    expect(migrations.results.map(row => (row as { name: string }).name)).toContain(
      '0002_submissions_data_model.sql'
    )
  })

  it('writes drafts with an ISO clock and refuses any other instant format', async () => {
    await insertDraft('sub-draft', 'https://draft.example/', daysBefore(1))
    await expect(
      insertDraft('sub-bad-clock', 'https://bad-clock.example/', '2026-10-06 12:00:00')
    ).rejects.toThrow(/listing_submissions_draft_saved_at_iso/u)
  })

  it('reminds, claims once, and expires drafts', async () => {
    await insertDraft('sub-old', 'https://old.example/', daysBefore(31))
    const due = await all<{ id: string; reminder: number; variant: string }>(
      selectDraftRemindersDuePlan({ limit: 10, now: NOW })
    )
    expect(due).toEqual([
      expect.objectContaining({ id: 'sub-draft', reminder: 1, variant: 'choose_plan' })
    ])
    const claim = buildMarkDraftReminderSentPlans({
      now: NOW,
      reminder: 1,
      submissionId: 'sub-draft',
      variant: 'choose_plan'
    })
    await run(claim)
    await expect(run(claim)).rejects.toThrow(/malformed JSON/u)
    const expired = await all<{ id: string }>(selectExpiredDraftsPlan({ limit: 10, now: NOW }))
    expect(expired.map(row => row.id)).toEqual(['sub-old'])
    await run(buildExpireDraftPlans({ now: NOW, submissionId: 'sub-old' }))
    expect(
      await first(
        'SELECT status, withdrawal_reason FROM listing_submissions WHERE id = ?',
        'sub-old'
      )
    ).toEqual({ status: 'withdrawn', withdrawal_reason: 'expired' })
  })

  it('publishes a paid draft, approves it live, records badge checks, and refunds it as free', async () => {
    await insertDraft('sub-paid', 'https://paid.example/', daysBefore(1))
    await run(
      buildChooseSubmissionPlanPlans({
        now: NOW,
        ownerUserId: 'user_owner',
        plan: 'paid',
        submissionId: 'sub-paid'
      })
    )
    await run(
      buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        listingId: 'lst-paid',
        now: NOW,
        outcome: 'publish',
        publication: await publicationAt('paid-listing'),
        submissionId: 'sub-paid'
      })
    )
    await run(
      buildApproveLiveSubmissionPlans({
        expectedContentVersion: 1,
        listingId: 'lst-paid',
        now: NOW,
        publication: await publicationAt('live-approval'),
        reviewer: 'reviewer',
        submissionId: 'sub-paid'
      })
    )
    const insertCheck = (checkedAt: string) =>
      db
        .prepare(
          `INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive)
          VALUES ('lst-paid', ?, 'pass', NULL, 1)`
        )
        .bind(checkedAt)
        .run()
    await insertCheck(daysBefore(2))
    await expect(insertCheck('2026-10-06 00:00:00')).rejects.toThrow(/badge_checks_checked_at_iso/u)
    await run(
      buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'keep_free',
        now: NOW,
        submissionId: 'sub-paid'
      })
    )
    expect(
      await first(
        'SELECT status, plan, refunded_at FROM listing_submissions WHERE id = ?',
        'sub-paid'
      )
    ).toEqual({ plan: 'free', refunded_at: NOW, status: 'approved' })
    expect(
      await first('SELECT is_active, link_rel, source FROM listings WHERE id = ?', 'lst-paid')
    ).toEqual({ is_active: 1, link_rel: 'nofollow', source: 'submission' })
  })

  it('blocks a prohibited domain and its subdomains, and a public suffix only exactly', async () => {
    for (const [id, website] of [
      ['sub-casino', 'https://go.casino.example/'],
      ['sub-suffix', 'https://github.io/']
    ] as const) {
      await insertDraft(id, website, daysBefore(1))
      await run(
        buildChooseSubmissionPlanPlans({
          now: NOW,
          ownerUserId: 'user_owner',
          plan: 'free',
          submissionId: id
        })
      )
      await run(
        buildRejectSubmissionPlans({
          category: 'prohibited',
          now: NOW,
          reason: 'Prohibited.',
          reviewer: 'reviewer',
          submissionId: id
        })
      )
    }
    expect(
      (
        await db
          .prepare(
            'SELECT url_key, covers_subdomains FROM listing_submission_url_blocks ORDER BY id'
          )
          .all()
      ).results
    ).toEqual([
      { covers_subdomains: 1, url_key: 'casino.example' },
      { covers_subdomains: 0, url_key: 'github.io' }
    ])
    for (const website of [
      'https://casino.example/',
      'https://shop.casino.example/',
      'https://github.io/'
    ]) {
      await expect(insertDraft(`blocked-${website}`, website, NOW), website).rejects.toThrow(
        /blocked until an admin lifts the block/u
      )
    }
    await insertDraft('sub-separate-site', 'https://someone.github.io/', NOW)
  })
})
