import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as adminPlansModule from '@serpdirectory/data-ops/admin-plans'
import * as adminQueriesModule from '@serpdirectory/data-ops/admin-queries'
import { createAdminReadOperations } from '@serpdirectory/data-ops/admin-queries'
import { createAuthOperations } from '@serpdirectory/data-ops/auth'
import { createDatabase } from '@serpdirectory/data-ops/client'
import * as draftPlansModule from '@serpdirectory/data-ops/draft-plans'
import * as listingPlansModule from '@serpdirectory/data-ops/listing-plans'
import { prepareCatalogPublication, type StatementPlan } from '@serpdirectory/data-ops/plan-support'
import * as revisionPlansModule from '@serpdirectory/data-ops/revision-plans'
import { assertD1StatementLimits } from '@serpdirectory/data-ops/sql-limits'
import * as submissionPlansModule from '@serpdirectory/data-ops/submission-plans'
import type { UrlKey } from '@serpdirectory/utils/url-key'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformProxy, type Unstable_DevWorker, unstable_dev } from 'wrangler'
import { project } from './project'

/**
 * The #62 statement plans against Wrangler-local D1 (workerd), not only node:sqlite: D1 has its
 * own limits (50-byte LIKE/GLOB patterns, 100 bound parameters per statement, 32 function
 * arguments) that node:sqlite does not apply, so a CHECK, trigger, or plan that breaks on D1
 * fails here (#74 review rounds 2 and 3). The schema comes from `pnpm db:migrate:local` on a
 * fresh state directory, and the binding is the same persisted database, opened through
 * `getPlatformProxy`. URL keys come from `urlKey()` running inside workerd
 * (`scripts/fixtures/url-key-worker.ts`), so the Public Suffix List (`tldts`) runs there too.
 * The last test checks that every exported plan builder ran here.
 */
const NOW = '2026-10-06T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const daysBefore = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString()

/** Every exported builder (`build…`, `select…`, `record…`) records that it ran. */
const called = new Set<string>()
const builderNames: string[] = []
function tracked<T extends object>(module: T): T {
  return Object.fromEntries(
    Object.entries(module).map(([name, value]) => {
      if (typeof value !== 'function' || !/^(build|select|record)[A-Z]/u.test(name)) {
        return [name, value]
      }
      builderNames.push(name)
      return [
        name,
        (...args: unknown[]) => {
          called.add(name)
          return value(...args)
        }
      ]
    })
  ) as T
}
const A = tracked(adminPlansModule)
const D = tracked(draftPlansModule)
const Q = tracked(adminQueriesModule)
const L = tracked(listingPlansModule)
const R = tracked(revisionPlansModule)
const S = tracked(submissionPlansModule)

let stateDirectory: string
let proxyDispose: (() => Promise<void>) | undefined
let keyWorker: Unstable_DevWorker | undefined
let db: D1Database

/** Every plan statement gets the D1 limit and self-comparison checks before it runs (#77). */
function checked(sql: string, params: readonly unknown[]): string {
  assertD1StatementLimits(sql, params)
  return sql
}

async function run(plans: StatementPlan[]): Promise<void> {
  await db.batch(plans.map(plan => db.prepare(checked(plan.sql, plan.params)).bind(...plan.params)))
}

async function all<T>(plan: StatementPlan): Promise<T[]> {
  checked(plan.sql, plan.params)
  return (
    await db
      .prepare(plan.sql)
      .bind(...plan.params)
      .all<T>()
  ).results
}

async function first<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
  return db
    .prepare(checked(sql, params))
    .bind(...params)
    .first<T>()
}

async function submission(id: string) {
  return first('SELECT * FROM listing_submissions WHERE id = ?', id)
}

async function listing(id: string) {
  return first('SELECT * FROM listings WHERE id = ?', id)
}

/** Publication inputs for the current publication state. */
async function publication(action: string, entityId: string) {
  const state = await first<{ checksum: string; version: number }>(
    'SELECT version, checksum FROM publication_state WHERE id = 1'
  )
  if (!state) throw new Error('Missing publication state.')
  return prepareCatalogPublication({
    action,
    actor: 'workerd-test',
    affectedRoutes: `/products/${entityId}/`,
    checksum: state.checksum,
    entityId,
    now: NOW,
    version: state.version,
    workflow: 'test/workerd'
  })
}

/** `urlKey()` computed inside workerd. */
async function keysFor(websites: string[]): Promise<UrlKey[]> {
  if (!keyWorker) throw new Error('The url-key worker is not running.')
  const response = await keyWorker.fetch('http://url-key.test/', {
    body: JSON.stringify(websites),
    method: 'POST'
  })
  expect(response.status).toBe(200)
  return (await response.json()) as UrlKey[]
}

/** A native draft written the way #63's intake will write it. */
async function insertDraft(id: string, website: string, savedAt = daysBefore(1)): Promise<void> {
  const [key] = await keysFor([website])
  if (!key) throw new Error('No key.')
  await db
    .prepare(
      `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,description,
        website,content,category_slug,logo_url,status,plan,owner_user_id,draft_saved_at)
      VALUES (?,?,?,?,?,'Description',?,'Content','tools','https://example.com/logo.png','draft',
        NULL,'user_owner',?)`
    )
    .bind(id, key.hostKey, key.blockKey, key.coversSubdomains ? 1 : 0, id, website, savedAt)
    .run()
}

async function choose(id: string, plan: 'free' | 'paid') {
  await run(
    S.buildChooseSubmissionPlanPlans({
      now: NOW,
      ownerUserId: 'user_owner',
      plan,
      submissionId: id
    })
  )
}

/** A paid draft published before review: `paid_pending_review` with a live listing. */
async function paidLive(id: string, website: string, listingId: string) {
  await insertDraft(id, website)
  await choose(id, 'paid')
  await run(
    S.buildRecordSubmissionPaymentPlans({
      actor: 'stripe',
      listingId,
      now: NOW,
      outcome: 'publish',
      publication: await publication('paid-listing', id),
      submissionId: id
    })
  )
}

async function approveLive(id: string, listingId: string) {
  await run(
    S.buildApproveLiveSubmissionPlans({
      expectedContentVersion: 1,
      listingId,
      now: NOW,
      publication: await publication('live-approval', id),
      reviewer: 'reviewer',
      submissionId: id
    })
  )
}

const stagedContent = {
  categorySlug: 'apps',
  content: 'Revised content',
  description: 'Revised description',
  faqs: [{ answer: 'Yes.', question: 'Is there a free tier?' }],
  logoUrl: 'https://example.com/revised-logo.png',
  name: 'Revised name',
  resourceLinks: [{ label: 'Pricing', url: 'https://example.com/pricing' }]
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
  const [proxy, worker] = await Promise.all([
    getPlatformProxy<{ DB: D1Database }>({
      configPath,
      // `--persist-to <dir>` stores under <dir>/v3, which is what getPlatformProxy takes.
      persist: { path: resolve(stateDirectory, 'drizzle', 'best-serp-co', 'v3') }
    }),
    unstable_dev('scripts/fixtures/url-key-worker.ts', {
      compatibilityDate: '2026-07-13',
      experimental: { disableExperimentalWarning: true },
      logLevel: 'error'
    })
  ])
  proxyDispose = () => proxy.dispose()
  keyWorker = worker
  db = proxy.env.DB
  await db.batch([
    db.prepare(
      "INSERT INTO categories (slug, name, sort_order) VALUES ('tools', 'Tools', 0), ('apps', 'Apps', 1)"
    ),
    db.prepare(
      "INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'workerd-before')"
    ),
    db.prepare(
      `INSERT INTO users (id, name, email) VALUES ('user_owner', 'Owner', 'owner@example.com'),
        ('user_other', 'Other', 'other@example.com')`
    )
  ])
}, 180_000)

afterAll(async () => {
  await Promise.all([proxyDispose?.(), keyWorker?.stop()])
  if (stateDirectory) rmSync(stateDirectory, { force: true, recursive: true })
})

describe('#62 plans on Wrangler-local D1 (workerd)', () => {
  it('applied every migration and computes URL keys with the PSL inside workerd', async () => {
    const migrations = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    expect(migrations.results.map(row => (row as { name: string }).name)).toContain(
      '0003_submissions_data_model.sql'
    )
    expect(
      await keysFor([
        'https://www.Casino.EXAMPLE./',
        'https://shop.bbc.co.uk/',
        'https://someone.github.io/',
        'https://github.io/',
        'https://bücher.de/'
      ])
    ).toEqual([
      { blockKey: 'casino.example', coversSubdomains: true, hostKey: 'casino.example' },
      { blockKey: 'bbc.co.uk', coversSubdomains: true, hostKey: 'shop.bbc.co.uk' },
      { blockKey: 'someone.github.io', coversSubdomains: true, hostKey: 'someone.github.io' },
      { blockKey: 'github.io', coversSubdomains: false, hostKey: 'github.io' },
      { blockKey: 'xn--bcher-kva.de', coversSubdomains: true, hostKey: 'xn--bcher-kva.de' }
    ])
  })

  it('writes drafts with an ISO clock and refuses any other instant format', async () => {
    await insertDraft('sub-draft', 'https://draft.example/')
    await expect(
      insertDraft('sub-bad-clock', 'https://bad-clock.example/', '2026-10-06 12:00:00')
    ).rejects.toThrow(/listing_submissions_draft_saved_at_iso/u)
  })

  it('reminds, claims once, expires, and clears drafts', async () => {
    await insertDraft('sub-old', 'https://old.example/', daysBefore(31))
    await insertDraft('sub-squat', 'https://squat.example/')
    const due = await all<{ id: string; reminder: number; variant: string }>(
      D.selectDraftRemindersDuePlan({ limit: 10, now: NOW })
    )
    expect(due.map(row => [row.id, row.reminder, row.variant])).toEqual([
      ['sub-draft', 1, 'choose_plan'],
      ['sub-squat', 1, 'choose_plan']
    ])
    const claim = D.buildMarkDraftReminderSentPlans({
      now: NOW,
      reminder: 1,
      submissionId: 'sub-draft',
      variant: 'choose_plan'
    })
    await run(claim)
    await expect(run(claim)).rejects.toThrow(/malformed JSON/u)
    const expired = await all<{ id: string }>(D.selectExpiredDraftsPlan({ limit: 10, now: NOW }))
    expect(expired.map(row => row.id)).toEqual(['sub-old'])
    await run(D.buildExpireDraftPlans({ now: NOW, submissionId: 'sub-old' }))
    await run(
      S.buildClearDraftPlans({
        admin: 'admin',
        note: 'Squatting.',
        now: NOW,
        submissionId: 'sub-squat'
      })
    )
    expect(await submission('sub-old')).toMatchObject({
      status: 'withdrawn',
      withdrawal_reason: 'expired'
    })
    expect(await submission('sub-squat')).toMatchObject({
      status: 'withdrawn',
      withdrawal_reason: 'admin'
    })
  })

  it('runs a free submission through review, approval, upgrade, and the listing plans', async () => {
    await insertDraft('sub-free', 'https://www.Free-Tool.example./')
    await choose('sub-free', 'free')
    await run(
      S.buildReplaceSubmissionContentPlans({
        actor: 'user_owner',
        content: { ...stagedContent, content: 'Owner content', name: 'Free Tool' },
        expectedStatuses: ['pending_badge'],
        now: NOW,
        ownerUserId: 'user_owner',
        submissionId: 'sub-free'
      })
    )
    // Badge verification is the legacy capability operation; set its result directly.
    await db
      .prepare(
        "UPDATE listing_submissions SET status='verified', badge_verified_at=? WHERE id='sub-free'"
      )
      .bind(NOW)
      .run()
    const [pending] = S.selectVerifiedSubmissionNotificationPlans(10)
    if (!pending) throw new Error('No notification plan.')
    expect((await all<{ id: string }>(pending)).map(row => row.id)).toEqual(['sub-free'])
    await run([
      S.recordSubmissionNotificationPlan({
        externalId: '1',
        externalUrl: 'https://example.com/review/1',
        previewTokenHash: 'a'.repeat(64),
        recipient: 'reviewer',
        submissionId: 'sub-free'
      })
    ])
    await run(
      S.buildRequestSubmissionChangesPlans({
        note: 'Clarify pricing.',
        now: NOW,
        reviewer: 'reviewer',
        submissionId: 'sub-free'
      })
    )
    await run(
      S.buildResubmitSubmissionPlans({
        now: NOW,
        ownerUserId: 'user_owner',
        submissionId: 'sub-free'
      })
    )
    await run(
      S.buildReplaceSubmissionContentPlans({
        actor: 'reviewer',
        content: { ...stagedContent, content: 'Reviewed content', name: 'Free Tool' },
        expectedContentVersion: 2,
        expectedStatuses: ['verified'],
        now: NOW,
        submissionId: 'sub-free'
      })
    )
    const [snapshot] = await all<{ content_version: number; slug: string; status: string }>(
      S.selectSubmissionForDecisionPlan('sub-free')
    )
    expect(snapshot).toMatchObject({
      content_version: 3,
      slug: 'free-tool.example',
      status: 'verified'
    })
    const approval = await publication('verified-submission', 'sub-free')
    await run(
      S.buildApproveSubmissionPlans({
        afterChecksum: approval.afterChecksum,
        affectedRoute: '/products/free-tool.example/',
        beforeChecksum: approval.beforeChecksum,
        expectedContentVersion: 3,
        listingId: 'lst-free',
        manifestId: approval.manifestId,
        now: NOW,
        reviewer: 'reviewer',
        runId: approval.runId,
        submissionId: 'sub-free',
        version: approval.version,
        workflow: 'test/workerd'
      })
    )
    await run(
      S.buildUpgradeListingToPaidPlans({ actor: 'stripe', now: NOW, submissionId: 'sub-free' })
    )
    expect(await submission('sub-free')).toMatchObject({
      paid_at: NOW,
      plan: 'paid',
      status: 'approved'
    })

    await run(
      L.buildSetListingLinkRelPlans({
        linkRel: 'sponsored',
        listingId: 'lst-free',
        publication: await publication('link-rel', 'lst-free')
      })
    )
    await run(
      L.buildRevokeListingOwnerPlans({
        listingId: 'lst-free',
        publication: await publication('owner-revoke', 'lst-free'),
        reason: 'badge_removed',
        userId: 'user_owner'
      })
    )
    await run(
      L.buildGrantListingOwnerPlans({
        listingId: 'lst-free',
        publication: await publication('owner-grant', 'lst-free'),
        userId: 'user_owner',
        verifiedVia: 'paid_claim'
      })
    )
    const [owned] = await all<{ link_rel: string; owner_user_id: string }>(
      L.selectListingForPublicationPlan('lst-free')
    )
    expect(owned).toMatchObject({ link_rel: 'sponsored', owner_user_id: 'user_owner' })
    await run(
      L.buildUnpublishListingPlans({
        listingId: 'lst-free',
        publication: await publication('unpublish', 'lst-free'),
        reason: 'admin'
      })
    )
    expect(await listing('lst-free')).toMatchObject({ is_active: 0 })
    await run(
      L.buildRepublishListingPlans({
        listingId: 'lst-free',
        publication: await publication('republish', 'lst-free')
      })
    )
    expect(await listing('lst-free')).toMatchObject({ is_active: 1, link_rel: 'sponsored' })
  })

  it('stages, reviews, approves, rejects, and withdraws owner revisions', async () => {
    const create = (revisionId: string, name: string) =>
      R.buildCreateRevisionPlans({
        authorUserId: 'user_owner',
        content: { ...stagedContent, name },
        listingId: 'lst-free',
        now: NOW,
        revisionId
      })
    await run(create('rev-1', 'Owner revision'))
    await run(
      R.buildRequestRevisionChangesPlans({
        note: 'Shorter.',
        now: NOW,
        reviewer: 'reviewer',
        revisionId: 'rev-1'
      })
    )
    await run(
      R.buildResubmitRevisionPlans({ authorUserId: 'user_owner', now: NOW, revisionId: 'rev-1' })
    )
    await run(
      R.buildReplaceRevisionContentPlans({
        authorUserId: 'user_owner',
        content: { ...stagedContent, name: 'Owner revision, edited' },
        now: NOW,
        revisionId: 'rev-1'
      })
    )
    const [decision] = await all<{ content_version: number; listing_live: number }>(
      R.selectRevisionForDecisionPlan('rev-1')
    )
    expect(decision).toMatchObject({ content_version: 2, listing_live: 1 })
    await run(
      R.buildApproveRevisionPlans({
        expectedContentVersion: 2,
        listingId: 'lst-free',
        now: NOW,
        publication: await publication('revision-approval', 'rev-1'),
        reviewer: 'reviewer',
        revisionId: 'rev-1'
      })
    )
    expect(await listing('lst-free')).toMatchObject({
      is_active: 1,
      name: 'Owner revision, edited'
    })
    await run(create('rev-2', 'Rejected revision'))
    await run(
      R.buildRejectRevisionPlans({
        now: NOW,
        reason: 'Inaccurate.',
        reviewer: 'reviewer',
        revisionId: 'rev-2'
      })
    )
    await run(create('rev-3', 'Withdrawn revision'))
    await run(
      R.buildWithdrawRevisionPlans({ authorUserId: 'user_owner', now: NOW, revisionId: 'rev-3' })
    )
    expect(
      (await db.prepare('SELECT id, status FROM listing_revisions ORDER BY id').all()).results
    ).toEqual([
      { id: 'rev-1', status: 'approved' },
      { id: 'rev-2', status: 'rejected' },
      { id: 'rev-3', status: 'withdrawn' }
    ])
  })

  it('records every refund mode, a held payment, and an unapplied payment', async () => {
    // unpublish: the upgraded listing has no recent badge pass.
    await run(
      S.buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'unpublish',
        now: NOW,
        publication: await publication('refund-unpublish', 'sub-free'),
        submissionId: 'sub-free'
      })
    )
    expect(await listing('lst-free')).toMatchObject({ is_active: 0 })

    // keep_free: a recent conclusive pass keeps the listing live as free.
    await paidLive('sub-keep', 'https://keep.example/', 'lst-keep')
    await approveLive('sub-keep', 'lst-keep')
    await db
      .prepare(
        `INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive)
        VALUES ('lst-keep', ?, 'pass', NULL, 1)`
      )
      .bind(daysBefore(2))
      .run()
    await expect(
      db
        .prepare(
          `INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive)
          VALUES ('lst-keep', '2026-10-06 00:00:00', 'pass', NULL, 1)`
        )
        .run()
    ).rejects.toThrow(/badge_checks_checked_at_iso/u)
    await run(
      S.buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'keep_free',
        now: NOW,
        submissionId: 'sub-keep'
      })
    )
    expect(await submission('sub-keep')).toMatchObject({ plan: 'free', refunded_at: NOW })
    expect(await listing('lst-keep')).toMatchObject({
      is_active: 1,
      link_rel: 'nofollow',
      source: 'submission'
    })

    // already_unpublished: an admin took the approved paid listing down first.
    await paidLive('sub-down', 'https://down.example/', 'lst-down')
    await approveLive('sub-down', 'lst-down')
    await run(
      L.buildUnpublishListingPlans({
        listingId: 'lst-down',
        publication: await publication('unpublish', 'lst-down'),
        reason: 'admin'
      })
    )
    await run(
      S.buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'already_unpublished',
        now: NOW,
        submissionId: 'sub-down'
      })
    )
    expect(await submission('sub-down')).toMatchObject({ refunded_at: NOW })

    // after_rejection: a live paid submission rejected with `live`, tagged other.
    await paidLive('sub-rejected', 'https://rejected.example/', 'lst-rejected')
    await run(
      S.buildRejectSubmissionPlans({
        category: 'other',
        live: {
          listingId: 'lst-rejected',
          publication: await publication('reject-live', 'sub-rejected')
        },
        now: NOW,
        reason: 'Misleading claims.',
        reviewer: 'reviewer',
        submissionId: 'sub-rejected'
      })
    )
    expect(await listing('lst-rejected')).toMatchObject({ is_active: 0 })
    // The rejection is the refund-pending marker until the refund is recorded.
    const refundPending = async () =>
      (await all<{ id: string }>(S.selectRefundPendingSubmissionsPlan(50))).map(row => row.id)
    expect(await refundPending()).toContain('sub-rejected')
    await run(
      S.buildRefundSubmissionPlans({
        actor: 'admin',
        mode: 'after_rejection',
        now: NOW,
        submissionId: 'sub-rejected'
      })
    )
    expect(await submission('sub-rejected')).toMatchObject({ refunded_at: NOW, status: 'rejected' })
    expect(await refundPending()).not.toContain('sub-rejected')

    // A payment held for review, and one that arrives after the owner withdrew.
    await insertDraft('sub-held', 'https://held.example/')
    await choose('sub-held', 'paid')
    await run(
      S.buildRecordSubmissionPaymentPlans({
        actor: 'stripe',
        now: NOW,
        outcome: 'hold',
        submissionId: 'sub-held'
      })
    )
    expect(await submission('sub-held')).toMatchObject({ plan: 'paid', status: 'verified' })
    await insertDraft('sub-gone', 'https://gone.example/')
    await choose('sub-gone', 'paid')
    await run(
      S.buildWithdrawSubmissionPlans({
        now: NOW,
        ownerUserId: 'user_owner',
        submissionId: 'sub-gone'
      })
    )
    await run(
      S.buildRecordUnappliedPaymentPlans({ actor: 'stripe', now: NOW, submissionId: 'sub-gone' })
    )
    expect(await submission('sub-gone')).toMatchObject({
      paid_at: NOW,
      refunded_at: NOW,
      status: 'withdrawn'
    })
  })

  it('blocks a prohibited domain and its subdomains, a public suffix only exactly, until lifted', async () => {
    for (const [id, website] of [
      ['sub-casino', 'https://go.casino.example/'],
      ['sub-suffix', 'https://github.io/']
    ] as const) {
      await insertDraft(id, website)
      await choose(id, 'free')
      await run(
        S.buildRejectSubmissionPlans({
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
      'https://shop.casino.example./',
      'https://github.io/'
    ]) {
      await expect(insertDraft(`blocked-${website}`, website), website).rejects.toThrow(
        /blocked until an admin lifts the block/u
      )
    }
    await insertDraft('sub-separate-site', 'https://someone.github.io/')
    await run(
      S.buildLiftSubmissionUrlBlockPlans({
        admin: 'admin',
        note: 'Appealed.',
        now: NOW,
        urlKey: 'casino.example'
      })
    )
    await insertDraft('sub-after-lift', 'https://shop.casino.example/')
  })

  it('runs the admin panel plans and reads (#64)', async () => {
    // Reads: every queue view, the counts, one submission and revision, the listing search with
    // its JSON facet filters and numbered parameters, one listing, and the categories.
    for (const view of ['waiting', 'changes', 'all'] as const) {
      await all(Q.selectReviewQueuePlan(view))
    }
    const [counts] = await all<{ waiting: number }>(Q.selectReviewQueueCountsPlan())
    expect(typeof counts?.waiting).toBe('number')
    const reviewResults = await db.batch(
      Q.selectSubmissionReviewPlans('sub-free').map(plan =>
        db.prepare(plan.sql).bind(...plan.params)
      )
    )
    expect(reviewResults[0]?.results).toMatchObject([{ id: 'sub-free', status: 'approved' }])
    await db.batch(
      Q.selectRevisionReviewPlans('rev-1').map(plan => db.prepare(plan.sql).bind(...plan.params))
    )
    const [page, totals, facets] = await db.batch<Record<string, unknown>>(
      Q.selectAdminListingsPlans(
        { linkRels: ['sponsored'], query: 'FREE', sources: ['submission'], statuses: ['unlisted'] },
        { limit: 10, offset: 0 }
      ).map(plan => db.prepare(plan.sql).bind(...plan.params))
    )
    expect(page?.results).toMatchObject([{ admin_status: 'unlisted', slug: 'free-tool.example' }])
    expect(totals?.results).toMatchObject([{ matches: 1 }])
    expect(facets?.results.length).toBeGreaterThan(0)
    await db.batch(
      Q.selectAdminListingPlans('free-tool.example').map(plan =>
        db.prepare(plan.sql).bind(...plan.params)
      )
    )
    expect(await all(Q.selectActiveCategoriesPlan())).toHaveLength(2)
    expect(await all(Q.selectActiveUrlBlockPlan('casino.example'))).toEqual([])
    // "Allow resubmission" targets: a submission's own key, a listing's latest submission's key.
    expect(await all(Q.selectResubmissionTargetPlan({ submissionId: 'sub-free' }))).toEqual([
      { block_key: expect.any(String), id: 'sub-free' }
    ])
    expect(await all(Q.selectResubmissionTargetPlan({ listingId: 'lst-missing' }))).toEqual([])
    // A website move collides with another listing's host; a free host does not.
    expect(
      await all(
        Q.selectListingWebsiteConflictPlan({
          listingId: 'lst-free',
          website: 'https://www.keep.example/'
        })
      )
    ).toEqual([{ blocked: 0, listing: 1, submission: 0 }])
    expect(
      await all(
        Q.selectListingWebsiteConflictPlan({
          listingId: 'lst-free',
          website: 'https://new.example/'
        })
      )
    ).toEqual([{ blocked: 0, listing: 0, submission: 0 }])
    const reads = createAdminReadOperations({ client: createDatabase(db) })
    expect(await reads.getAdminListing('free-tool.example')).toMatchObject({
      adminStatus: 'unlisted',
      owner: { userId: 'user_owner', verifiedVia: 'paid_claim' }
    })

    // Writes: an admin edit of the live listing, then a transfer to another verified account.
    const [current] = await all<{ checksum: string }>(L.selectListingForPublicationPlan('lst-free'))
    await run(
      L.buildUpdateListingDetailsPlans({
        details: {
          categorySlug: 'tools',
          description: 'Edited by an admin',
          logoUrl: 'https://example.com/admin-logo.png',
          name: 'Free Tool (edited)',
          website: 'https://free-tool.example/'
        },
        expectedChecksum: String(current?.checksum),
        fields: ['name', 'description', 'category', 'logo'],
        listingId: 'lst-free',
        publication: await publication('listing-edit', 'lst-free')
      })
    )
    expect(await listing('lst-free')).toMatchObject({
      is_active: 0,
      name: 'Free Tool (edited)',
      status: 'approved'
    })
    await db.prepare("UPDATE users SET email_verified=1 WHERE id='user_other'").run()
    const [target] = await all<{ id: string }>(A.selectVerifiedUserByEmailPlan('Other@example.com'))
    expect(target?.id).toBe('user_other')
    await run(
      L.buildTransferListingOwnerPlans({
        fromUserId: 'user_owner',
        listingId: 'lst-free',
        publication: await publication('owner-transfer', 'lst-free'),
        toUserId: 'user_other'
      })
    )
    expect(
      (
        await all<{ event_type: string }>({
          params: ['lst-free'],
          sql: 'SELECT event_type FROM listing_events WHERE listing_id=? ORDER BY id'
        })
      ).map(row => row.event_type)
    ).toEqual(
      expect.arrayContaining(['edited', 'owner_transferred', 'link_rel_changed', 'unpublished'])
    )

    // The allowlist: add once, remove, and never remove the last admin.
    await run(A.buildAddAdminPlans({ addedBy: 'devin@serp.co', email: 'Workerd@Example.com' }))
    await expect(
      run(A.buildAddAdminPlans({ addedBy: 'devin@serp.co', email: 'workerd@example.com' }))
    ).rejects.toThrow()
    expect(
      (await all<{ email: string }>(A.selectAdminAllowlistPlan())).map(row => row.email)
    ).toContain('workerd@example.com')
    await run(A.buildRemoveAdminPlans({ email: 'workerd@example.com' }))
    await expect(run(A.buildRemoveAdminPlans({ email: 'devin@serp.co' }))).rejects.toThrow()
  })

  it('ran every exported plan builder on D1', () => {
    expect(builderNames.length).toBeGreaterThan(30)
    expect(builderNames.filter(name => !called.has(name))).toEqual([])
  })
})

describe('admin allowlist on Wrangler-local D1 (workerd, #78)', () => {
  it('checks each user against their own email and revokes one admin while another stays', async () => {
    const operations = createAuthOperations({
      client: createDatabase(db),
      rateLimitKey: 'workerd-rate-limit-key-'.repeat(2)
    })
    await db.batch([
      db.prepare(
        "INSERT INTO admin_allowlist (email, added_by) VALUES ('second-admin@example.com', 'test')"
      ),
      db.prepare(
        `INSERT INTO users (id, name, email, email_verified) VALUES
          ('auth_owner', 'Owner', 'devin@serp.co', 1),
          ('auth_second', 'Second', 'second-admin@example.com', 1),
          ('auth_visitor', 'Visitor', 'visitor@example.com', 1)`
      )
    ])
    expect((await operations.getAdminStatus('auth_visitor'))?.allowlisted).toBe(false)
    expect(await operations.syncUserRole('auth_visitor')).toBe('user')
    expect(await operations.syncUserRole('auth_owner')).toBe('admin')
    expect((await operations.getAdminStatus('auth_owner'))?.allowlisted).toBe(true)

    await db.prepare("DELETE FROM admin_allowlist WHERE email = 'devin@serp.co'").run()
    expect(await operations.getAdminStatus('auth_owner')).toMatchObject({
      allowlisted: false,
      role: 'admin'
    })
    expect((await operations.getAdminStatus('auth_second'))?.allowlisted).toBe(true)
    expect(await operations.syncUserRole('auth_owner')).toBe('user')
  })
})
