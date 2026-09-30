import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireCutoverLock,
  acquireCutoverLockWithTransport,
  activeDeployment,
  finalizeActiveLock,
  sealProductionEvidence,
  validateProductionReceipt
} from './d1-replatform-production'

const digest = 'a'.repeat(64)
const identity = {
  activeDeploymentId: 'source-deployment',
  activeVersionId: 'source-version',
  accountId: 'account',
  allowedSiteIds: ['serp.software'],
  currentDatabaseId: 'source-id',
  protectedEnvironment: 'production',
  replacementDatabaseId: 'target-id',
  replacementDatabaseName: 'target-name',
  routeId: 'route',
  routePattern: 'serp.software/*',
  siteId: 'serp.software',
  sourceDatabaseId: 'source-id',
  sourceDatabaseName: 'source-name',
  verifiedAt: '2026-09-25T00:00:00.000Z',
  workerName: 'worker',
  zoneId: 'zone',
  zoneName: 'serp.software'
}

function evidence() {
  return {
    authorityRemoved: true,
    commitSha: 'b'.repeat(40),
    cutoverId: '123-1',
    frozenSnapshotChecksum: digest,
    identity: { ...identity, allowedSiteIds: [...identity.allowedSiteIds] },
    preview: { artifactId: 1, artifactName: 'preview', receiptSha256: digest, runId: 2 },
    rollback: {
      sourceVersionId: 'source-version',
      sourceVerified: true,
      targetRestored: true,
      targetVersionId: 'target-version'
    },
    siteId: 'serp.software',
    sourceBackupSha256: digest,
    status: 'locked-target-active',
    targetBackupSha256: digest,
    transfer: {
      materializeMode: 'imported',
      receiptId: 'receipt',
      snapshotChecksum: digest,
      totalRows: 17,
      verificationMode: 'verified-no-op'
    },
    version: 1
  }
}

describe('Production cutover sealed evidence', () => {
  it('seals and revalidates the exact measured schema', () => {
    const sealed = sealProductionEvidence(evidence())
    expect(validateProductionReceipt(sealed, sealed.sha256)).toEqual(sealed)
  })

  it.each([
    ['unknown field', value => Object.assign(value, { success: true })],
    ['wrong Site', value => Object.assign(value.identity, { siteId: 'pornvideodownloaders.com' })],
    ['wrong parity', value => Object.assign(value.transfer, { snapshotChecksum: 'c'.repeat(64) })],
    ['missing rollback', value => Object.assign(value.rollback, { sourceVerified: false })],
    ['same versions', value => Object.assign(value.rollback, { targetVersionId: 'source-version' })]
  ])('rejects %s without success defaults', (_label, mutate) => {
    const value = evidence() as Record<string, any>
    mutate(value)
    expect(() => sealProductionEvidence(value)).toThrow()
  })

  it('rejects receipt and protected-digest tampering', () => {
    const sealed = sealProductionEvidence(evidence())
    expect(() => validateProductionReceipt(sealed, 'c'.repeat(64))).toThrow('protected evidence')
    expect(() =>
      validateProductionReceipt(
        { ...sealed, evidence: { ...sealed.evidence, status: 'complete' } },
        sealed.sha256
      )
    ).toThrow()
  })
})

describe('Production cutover workflow contracts', () => {
  const load = (name: string) => {
    const source = readFileSync(resolve(`.github/workflows/${name}.yml`), 'utf8')
    return { source, workflow: yaml.load(source) as Record<string, any> }
  }

  it.each([
    'cutover-d1-replatform-production',
    'rollback-d1-replatform-production',
    'finalize-d1-replatform-production'
  ])('%s is main-only, Site-serialized, protected, and retains evidence for 90 days', name => {
    const { source, workflow } = load(name)
    expect(source).toContain("github.ref == 'refs/heads/main'")
    expect(workflow.concurrency.group).toBe('${{ inputs.site_id }}-production-d1')
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(source).toContain("'production' || 'pornvideodownloaders-production'")
    expect(source).toContain('retention-days: 90')
    expect(source).not.toMatch(/d1 delete|wrangler delete|time-travel restore/u)
  })

  it('orders freeze, exact snapshot, transfer, cutover, gates, rollback rehearsal, restoration, and sealing', () => {
    const { source } = load('cutover-d1-replatform-production')
    const ordered = [
      'Validate exact-main Preview trust and Production identity',
      'Deploy and observe exact-main source-bound Worker',
      'Retain immutable source and empty-target backups',
      'Acquire immutable Site-wide write lock',
      'Prove public writes are frozen',
      'Capture exact stable frozen 17-table source snapshot',
      'Apply fresh schema and resumably import exact frozen snapshot',
      'Deploy same commit target-bound and attest sole active version',
      'Run Production-safe catalog and frozen-write gates',
      'Rehearse immutable source-version rollback',
      'Restore exact target version and leave both databases locked',
      'Seal exact measured cutover receipt'
    ]
    let prior = -1
    for (const label of ordered) {
      const current = source.indexOf(label)
      expect(current, label).toBeGreaterThan(prior)
      prior = current
    }
    expect(source).toContain('if: always()')
    expect(source).not.toContain("outcome='succeeded'")
    expect(source.match(/Current Version ID:/gu)).toHaveLength(2)
    expect(source).toContain('browser-fixture --site')
    expect(source).not.toContain('E2E_LISTING_COUNT: ${{')
    expect(source).not.toContain('EVIDENCE_DIR: ${{ runner.temp }}')
    expect(source).not.toContain('printf \'%s\' "${{ inputs.cutover_id }}"')
  })

  it('rolls back by recorded immutable version only and finalizes only the active target lock', () => {
    const rollback = load('rollback-d1-replatform-production').source
    const finalize = load('finalize-d1-replatform-production').source
    expect(rollback).toContain('versions deploy "${source_version}@100"')
    expect(rollback).toContain('TRUSTED_RECOVERY_RECEIPT_SHA256')
    expect(rollback).toContain('validate-recovery')
    expect(rollback).not.toMatch(/build:worker|d1.*execute|migrations apply|backup production/u)
    expect(finalize).toContain('--database-id "$CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID"')
    expect(finalize).toContain('--database-id "$CLOUDFLARE_D1_PRODUCTION_DATABASE_ID" --cutover-id')
    expect(finalize).not.toContain('versions deploy')
  })
})

describe('Production provider boundaries', () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
    vi.unstubAllGlobals()
  })

  it('acquires and finalizes a lock through atomic REST batches with exact assertions', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'
    process.env.CLOUDFLARE_API_TOKEN = 'token'
    const bodies: unknown[] = []
    const responses = [
      [{ success: true, results: [] }],
      [
        {
          success: true,
          results: [
            {
              affected_records: 0,
              completed_at: null,
              error: null,
              id: 'd1-cutover-lock-v1:serp.software:cutover',
              input_checksum: '',
              manifest_identity: 'production-cutover-lock:cutover',
              outcome: 'started',
              schema_version: 1,
              site_id: 'serp.software',
              started_at: 'now',
              target_checksum: ''
            }
          ]
        }
      ],
      [
        { success: true, results: [] },
        { success: true, results: [{ value: 1 }] }
      ],
      [{ success: true, results: [{ outcome: 'succeeded', completed_at: 'later' }] }]
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ success: true, result: responses.shift() }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    await expect(
      acquireCutoverLock('database', 'serp.software', 'cutover', 'now')
    ).resolves.toContain('cutover')
    await expect(
      finalizeActiveLock('database', 'serp.software', 'cutover', 'later')
    ).resolves.toBeUndefined()
    expect(bodies[0]).toEqual(expect.objectContaining({ batch: expect.any(Array) }))
    expect((bodies[0] as { batch: unknown[] }).batch).toHaveLength(1)
    expect((bodies[2] as { batch: unknown[] }).batch).toHaveLength(2)
  })

  it('uses the real STRICT legacy lock schema and supports exact retries and later cutovers', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(readFileSync(resolve('d1/migrations/0001_public_catalog.sql'), 'utf8'))
    db.prepare('INSERT INTO sites (id) VALUES (?)').run('serp.software')
    const transport = {
      async query(statement: { params: unknown[]; sql: string }) {
        return db.prepare(statement.sql).all(...(statement.params as SQLInputValue[])) as Array<
          Record<string, unknown>
        >
      },
      async batch(statements: ReadonlyArray<{ params: unknown[]; sql: string }>) {
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const statement of statements)
            db.prepare(statement.sql).run(...(statement.params as SQLInputValue[]))
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
    }

    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'run-1', '2026-01-01')
    ).resolves.toBe('d1-cutover-lock-v1:serp.software:run-1')
    const first = db
      .prepare(
        'SELECT id,typeof(schema_version) AS schema_type,schema_version,manifest_identity,outcome FROM migration_runs'
      )
      .get() as Record<string, unknown>
    expect(first).toEqual(
      expect.objectContaining({
        manifest_identity: 'production-cutover-lock:run-1',
        outcome: 'started',
        schema_type: 'integer',
        schema_version: 1
      })
    )

    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'run-1', '2026-01-02')
    ).resolves.toContain('run-1')
    expect(db.prepare('SELECT COUNT(*) AS count FROM migration_runs').get()).toEqual({ count: 1 })
    db.prepare('UPDATE migration_runs SET manifest_identity=? WHERE id=?').run(
      'tampered-provenance',
      'd1-cutover-lock-v1:serp.software:run-1'
    )
    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'run-1', '2026-01-02')
    ).rejects.toThrow('sole exact immutable')
    db.prepare('UPDATE migration_runs SET manifest_identity=? WHERE id=?').run(
      'production-cutover-lock:run-1',
      'd1-cutover-lock-v1:serp.software:run-1'
    )
    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'conflict', '2026-01-02')
    ).rejects.toThrow('sole exact immutable')

    db.prepare("UPDATE migration_runs SET outcome='succeeded',completed_at=? WHERE id=?").run(
      '2026-01-03',
      'd1-cutover-lock-v1:serp.software:run-1'
    )
    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'run-2', '2026-02-01')
    ).resolves.toContain('run-2')
    db.prepare("UPDATE migration_runs SET outcome='failed',completed_at=? WHERE id=?").run(
      '2026-02-02',
      'd1-cutover-lock-v1:serp.software:run-2'
    )
    await expect(
      acquireCutoverLockWithTransport(transport, 'serp.software', 'run-3', '2026-03-01')
    ).resolves.toContain('run-3')
    expect(
      db
        .prepare('SELECT manifest_identity FROM migration_runs ORDER BY started_at')
        .all()
        .map(row => row.manifest_identity)
    ).toEqual([
      'production-cutover-lock:run-1',
      'production-cutover-lock:run-2',
      'production-cutover-lock:run-3'
    ])
    db.close()
  })

  it('reports bounded provider diagnostics without echoing SQL parameters', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'
    process.env.CLOUDFLARE_API_TOKEN = 'token'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ code: 7500, message: 'secret-value must not be reflected' }],
              result: [{ success: false }],
              success: false
            }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          )
      )
    )
    let message = ''
    try {
      await acquireCutoverLock('database', 'serp.software', 'secret-value', 'now')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('HTTP 400; provider codes 7500; failed result indexes 0')
    expect(message).not.toContain('secret-value')
    expect(message).not.toContain('INSERT INTO migration_runs')
  })

  it('observes the exact emitted sole version, script, route, and D1 binding', async () => {
    Object.assign(process.env, {
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_WORKER_PRODUCTION_NAME: 'worker',
      GITHUB_SHA: 'b'.repeat(40)
    })
    const results = [
      { name: 'worker' },
      [{ id: 'zone', name: 'serp.software', status: 'active' }],
      [{ id: 'route', pattern: 'serp.software/*', script: 'worker' }],
      {
        deployments: [{ id: 'deployment', versions: [{ percentage: 100, version_id: 'version' }] }]
      },
      {
        id: 'version',
        resources: {
          script: { etag: 'etag' },
          bindings: [{ type: 'd1', name: 'DB', database_id: 'database' }]
        }
      }
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, result: results.shift() }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    )
    await expect(activeDeployment('serp.software', 'database', 'version')).resolves.toEqual(
      expect.objectContaining({
        capturedVersionId: 'version',
        commitSha: 'b'.repeat(40),
        databaseId: 'database',
        routeId: 'route',
        scriptEtag: 'etag',
        versionId: 'version'
      })
    )
  })
})
