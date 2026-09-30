import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertDatabaseReady,
  authorizeRelease,
  backupDatabase,
  checkDatabase,
  type D1Row,
  type D1Target,
  deployWorker,
  importReviewedCatalog,
  inlineIntegerParameters,
  type ProcessRunner,
  parseReleaseArguments,
  parseWranglerRows,
  readOnlyCommands,
  releaseAuthorizations,
  releaseCommands,
  validateRemoteConfig,
  verifyImportedCatalog,
  wranglerD1
} from './cloudflare-release'
import { freshMigrationNames } from './d1-drizzle-local'
import type { ImportArtifactPaths, ParityReport } from './d1-import-artifact'
import { sha256 } from './d1-import-artifact'
import { project } from './project'

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-release-'))
afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }))

const at = '2026-01-01T00:00:00.000Z'
const targetChecksum = 'b'.repeat(64)
const fixtureSql = [
  'PRAGMA foreign_keys = ON;',
  `INSERT INTO migration_runs (id, schema_version, manifest_identity, input_checksum, target_checksum, affected_records, outcome, started_at, completed_at) VALUES ('migration-fixture', 1, 'fixture-v1', '${'a'.repeat(64)}', '${targetChecksum}', 1, 'started', '${at}', NULL);`,
  `INSERT INTO categories (slug, name, description, sort_order, is_active, created_at, updated_at) VALUES ('video-downloaders', 'Video Downloaders', 'Fixture category.', 0, 1, '${at}', '${at}');`,
  `INSERT INTO listings (id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_fixture0001', 'fixture-tool', 'Fixture Tool', 'A fixture listing.', 'https://example.com/', NULL, NULL, NULL, 0, 1, 1, 'draft', '${at}', 0, 'fixture', 'fixture-tool', NULL, '${'c'.repeat(64)}', '${at}', '${at}');`,
  `INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_fixture0001', id, 0, 1 FROM categories WHERE slug = 'video-downloaders';`,
  `INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_fixture0001', 'logo', '/logo.png', 0);`,
  `UPDATE listings SET status = 'approved' WHERE id = 'lst_fixture0001';`,
  `INSERT INTO publication_state (id, version, manifest_id, checksum, published_at) VALUES (1, 1, 'fixture-v1', '${targetChecksum}', '${at}');`,
  `UPDATE migration_runs SET outcome = 'succeeded', completed_at = '${at}' WHERE id = 'migration-fixture';`
].join('\n')

const paths: ImportArtifactPaths = {
  batchDirectory: join(fixtureDirectory, 'no-batches'),
  compressedSqlPath: join(fixtureDirectory, 'fixture.sql.br'),
  parityReportPath: join(fixtureDirectory, 'parity.yaml')
}
writeFileSync(paths.compressedSqlPath, brotliCompressSync(Buffer.from(fixtureSql)))

function fixtureReport(overrides: Partial<ParityReport['target']> = {}): ParityReport {
  return {
    artifact: { sqlChecksum: sha256(fixtureSql) },
    parity: {
      categoryMembershipCount: 1,
      faqCount: 0,
      featuredCount: 1,
      importBatches: 1,
      mediaCount: 1,
      primaryCategoryCount: 1,
      resourceLinkCount: 0
    },
    target: {
      categoryCount: 1,
      checksum: targetChecksum,
      listingCount: 1,
      publicationVersion: 1,
      ...overrides
    }
  }
}

/** A D1 target backed by in-memory SQLite that records the operations Wrangler would run. */
function sqliteD1(database = new DatabaseSync(':memory:')) {
  const exports: string[] = []
  const target: D1Target = {
    applyMigrations() {
      database.exec(
        'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
      )
      const applied = new Set(
        database
          .prepare('SELECT name FROM d1_migrations')
          .all()
          .map(row => String(row.name))
      )
      for (const name of freshMigrationNames()) {
        if (applied.has(name)) continue
        database.exec(readFileSync(resolve('d1/drizzle', name), 'utf8'))
        database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
      }
    },
    executeFile(path) {
      database.exec(readFileSync(path, 'utf8'))
    },
    exportTo(path) {
      exports.push(path)
      writeFileSync(path, '-- exported\n')
    },
    async query(sql) {
      return database.prepare(sql).all() as D1Row[]
    }
  }
  return { database, exports, target }
}

const sha = '0123456789abcdef0123456789abcdef01234567'

function workflowEnv(workflow: string, confirmation?: string | null): NodeJS.ProcessEnv {
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/${workflow}@refs/heads/main`,
    ...(confirmation ? { RELEASE_CONFIRM: confirmation } : {})
  }
}

const cleanGit = (args: string[]): string => (args[0] === 'status' ? '' : `${sha}\n`)
const mutatingCommands = releaseCommands.filter(command => !readOnlyCommands.has(command))

describe('release authorization', () => {
  it('allows read-only checks without a workflow and refuses mutations outside Actions', () => {
    const git = () => {
      throw new Error('read-only commands never inspect the checkout')
    }
    expect(() => authorizeRelease('check-database', 'production', {}, git)).not.toThrow()
    expect(() => authorizeRelease('verify-import', 'production', {}, git)).not.toThrow()
    for (const command of mutatingCommands) {
      expect(() => authorizeRelease(command, 'staging', {}, cleanGit)).toThrow(
        'protected GitHub Actions workflow'
      )
    }
  })

  it('binds every mutating command to its owning workflow, environment, and confirmation', () => {
    for (const [workflow, authorization] of Object.entries(releaseAuthorizations)) {
      const other = authorization.environment === 'staging' ? 'production' : 'staging'
      for (const command of mutatingCommands) {
        const env = workflowEnv(workflow, authorization.confirmation)
        if (authorization.commands.includes(command)) {
          expect(() =>
            authorizeRelease(command, authorization.environment, env, cleanGit)
          ).not.toThrow()
          expect(() => authorizeRelease(command, other, env, cleanGit)).toThrow(
            `may not change ${other}`
          )
          if (authorization.confirmation) {
            expect(() =>
              authorizeRelease(
                command,
                authorization.environment,
                { ...env, RELEASE_CONFIRM: 'yes' },
                cleanGit
              )
            ).toThrow(authorization.confirmation)
          }
        } else {
          expect(() => authorizeRelease(command, authorization.environment, env, cleanGit)).toThrow(
            `may not run ${command}`
          )
        }
      }
    }
  })

  it('keeps production behind typed confirmations and the import behind the bootstrap', () => {
    const production = Object.entries(releaseAuthorizations).filter(
      ([, authorization]) => authorization.environment === 'production'
    )
    expect(production.map(([workflow]) => workflow).sort()).toEqual([
      'approve-d1-submission.yml',
      'bootstrap-production-d1.yml',
      'deploy-production.yml',
      'publish-d1.yml'
    ])
    for (const [, authorization] of production) {
      expect(authorization.confirmation).toMatch(/-production$/u)
    }
    expect(releaseAuthorizations['deploy-staging.yml']).toEqual({
      commands: ['migrate', 'deploy'],
      confirmation: null,
      environment: 'staging'
    })
    expect(
      Object.entries(releaseAuthorizations)
        .filter(([, authorization]) => authorization.commands.includes('import'))
        .map(([workflow]) => workflow)
    ).toEqual(['bootstrap-production-d1.yml'])
    expect(releaseAuthorizations['bootstrap-production-d1.yml']?.commands).toEqual(['import'])
    expect(releaseAuthorizations['publish-d1.yml']?.commands).toEqual(['backup'])
    expect(releaseAuthorizations['approve-d1-submission.yml']?.commands).toEqual(['backup'])
  })

  it('refuses other repositories, branches, workflows, refs, and unreviewed checkouts', () => {
    const env = workflowEnv('deploy-production.yml', project.confirmation.deploy)
    const refuse = (overrides: NodeJS.ProcessEnv, git = cleanGit) =>
      expect(() => authorizeRelease('deploy', 'production', { ...env, ...overrides }, git))
    refuse({
      GITHUB_WORKFLOW_REF: 'someone/fork/.github/workflows/deploy-production.yml@refs/heads/main'
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/deploy-production.yml@refs/heads/feature`
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/main-validation.yml@refs/heads/main`
    }).toThrow('not a protected')
    refuse({ GITHUB_REF: 'refs/heads/feature' }).toThrow('reviewed main')
    refuse({ GITHUB_SHA: '' }).toThrow('reviewed main')
    refuse({}, args => (args[0] === 'status' ? '?? stray.txt\n' : sha)).toThrow('clean checkout')
    refuse({}, args => (args[0] === 'status' ? '' : 'f'.repeat(40))).toThrow('GITHUB_SHA')
  })
})

describe('remote Wrangler identity', () => {
  it('accepts the reviewed staging and production blocks of wrangler.jsonc', () => {
    expect(() => validateRemoteConfig('staging')).not.toThrow()
    expect(() => validateRemoteConfig('production')).not.toThrow()
    expect(project.remote.production.origin).toBe(project.publicUrl)
    expect(project.remote.production.workersDev).toBe(false)
  })

  it('refuses a drifted environment identity', () => {
    const base = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8'))
    for (const environment of ['staging', 'production'] as const) {
      base.env[environment].d1_databases[0].migrations_dir = resolve('d1/drizzle')
    }
    const mutations: Array<[string, (config: typeof base) => void]> = [
      [
        'workers_dev',
        config => {
          config.env.production.workers_dev = true
        }
      ],
      [
        'DB binding',
        config => {
          config.env.production.d1_databases[0].database_id = 'x'
        }
      ],
      [
        'D1_RUNTIME_ENV',
        config => {
          config.env.production.vars.D1_RUNTIME_ENV = 'staging'
        }
      ],
      [
        'name must be',
        config => {
          config.env.production.name = 'best-serp-co-staging'
        }
      ],
      [
        'migrations',
        config => {
          config.env.production.d1_databases[0].migrations_dir = '/tmp/other'
        }
      ]
    ]
    const baselinePath = join(fixtureDirectory, 'wrangler.baseline.jsonc')
    writeFileSync(baselinePath, JSON.stringify(base))
    expect(() => validateRemoteConfig('production', baselinePath)).not.toThrow()
    for (const [message, mutate] of mutations) {
      const config = JSON.parse(JSON.stringify(base))
      mutate(config)
      const path = join(fixtureDirectory, 'wrangler.mutated.jsonc')
      writeFileSync(path, JSON.stringify(config))
      expect(() => validateRemoteConfig('production', path)).toThrow(message)
    }
  })
})

describe('Wrangler invocation', () => {
  function recordingRunner(output = '[{"results":[{"name":"x"}],"success":true}]') {
    const calls: Array<{ args: string[]; capture: boolean; command: string }> = []
    const runner: ProcessRunner = {
      run(command, args, { capture }) {
        calls.push({ args, capture, command })
        return capture ? output : ''
      }
    }
    return { calls, runner }
  }

  it('pins remote D1 commands to the environment database, config, and --remote', async () => {
    const { calls, runner } = recordingRunner()
    const d1 = wranglerD1('production', { kind: 'remote' }, runner)
    await expect(d1.query('SELECT 1')).resolves.toEqual([{ name: 'x' }])
    d1.applyMigrations()
    d1.executeFile('/tmp/import.sql')
    d1.exportTo('/tmp/backup.sql')
    const pinned = [
      'best-serp-co-production',
      '--remote',
      '--env',
      'production',
      '--config',
      'apps/web/wrangler.jsonc'
    ]
    expect(calls.map(call => [call.command, ...call.args])).toEqual([
      ['pnpm', 'exec', 'wrangler', 'd1', 'execute', ...pinned, '--command', 'SELECT 1', '--json'],
      ['pnpm', 'exec', 'wrangler', 'd1', 'migrations', 'apply', ...pinned],
      [
        'pnpm',
        'exec',
        'wrangler',
        'd1',
        'execute',
        ...pinned,
        '--file',
        '/tmp/import.sql',
        '--yes'
      ],
      [
        'pnpm',
        'exec',
        'wrangler',
        'd1',
        'export',
        ...pinned,
        '--output',
        '/tmp/backup.sql',
        '--skip-confirmation'
      ]
    ])
  })

  it('rehearses against an isolated local state without --remote', () => {
    const { calls, runner } = recordingRunner()
    wranglerD1(
      'staging',
      { kind: 'rehearsal', persistTo: '/tmp/rehearsal' },
      runner
    ).applyMigrations()
    expect(calls[0]?.args).toEqual([
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'best-serp-co-staging',
      '--local',
      '--persist-to',
      '/tmp/rehearsal',
      '--env',
      'staging',
      '--config',
      'apps/web/wrangler.jsonc'
    ])
  })

  it('parses only successful D1 results and inlines only integer parameters', () => {
    expect(parseWranglerRows('[{"results":[{"a":1}],"success":true}]')).toEqual([{ a: 1 }])
    expect(() => parseWranglerRows('[{"results":[],"success":false}]')).toThrow('unsuccessful')
    expect(() => parseWranglerRows('{}')).toThrow('malformed')
    expect(inlineIntegerParameters('SELECT 1 LIMIT ? OFFSET ?', [250, 500])).toBe(
      'SELECT 1 LIMIT 250 OFFSET 500'
    )
    expect(() => inlineIntegerParameters('SELECT ?', ["1'; DROP TABLE x"])).toThrow('integer')
    expect(() => inlineIntegerParameters('SELECT ?', [1, 2])).toThrow('count')
  })
})

describe('one-time catalog bootstrap', () => {
  it('migrates, imports, and verifies an empty database exactly once', async () => {
    const { target } = sqliteD1()
    const report = fixtureReport()

    const empty = await checkDatabase(target)
    expect(empty.missingMigrations).toEqual(freshMigrationNames())
    expect(() => assertDatabaseReady(empty, 'production')).toThrow('database-and-worker')

    target.applyMigrations()
    await expect(
      checkDatabase(target).then(readiness => assertDatabaseReady(readiness, 'production'))
    ).rejects.toThrow('bootstrap-production-d1.yml')

    await expect(importReviewedCatalog(target, 'production', { paths, report })).resolves.toEqual({
      sqlChecksum: sha256(fixtureSql),
      status: 'imported'
    })
    await expect(
      verifyImportedCatalog(target, 'production', { pageSize: 1, paths, report })
    ).resolves.toMatchObject({ checksum: targetChecksum, listings: 1, version: 1 })
    const ready = await checkDatabase(target)
    expect(() => assertDatabaseReady(ready, 'production')).not.toThrow()
    expect(ready.publication).toEqual({ checksum: targetChecksum, rows: 1, version: 1 })

    await expect(importReviewedCatalog(target, 'production', { paths, report })).resolves.toEqual({
      sqlChecksum: sha256(fixtureSql),
      status: 'already-imported'
    })
  })

  it('applies the migrations itself when bootstrapping a database with no tables', async () => {
    const { target } = sqliteD1()
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
    ).resolves.toMatchObject({ status: 'imported' })
    const readiness = await checkDatabase(target)
    expect(readiness.appliedMigrations).toEqual(freshMigrationNames())
    expect(() => assertDatabaseReady(readiness, 'production')).not.toThrow()
  })

  it('refuses a populated database before applying any migration', async () => {
    const { database, target } = sqliteD1()
    database.exec(
      "CREATE TABLE publication_state (id INTEGER PRIMARY KEY, version INTEGER, checksum TEXT); INSERT INTO publication_state VALUES (1, 7, 'live')"
    )
    let migrations = 0
    const spy: D1Target = {
      ...target,
      applyMigrations: () => {
        migrations += 1
      }
    }
    await expect(
      importReviewedCatalog(spy, 'production', { paths, report: fixtureReport() })
    ).rejects.toThrow('only into an empty database')
    expect(migrations).toBe(0)
  })

  it('refuses a database that already holds other or partial catalog data', async () => {
    for (const statement of [
      `INSERT INTO categories (slug, name) VALUES ('other', 'Other')`,
      `INSERT INTO migration_runs (id, schema_version, manifest_identity, input_checksum, target_checksum, affected_records, outcome) VALUES ('partial', 1, 'partial', 'x', 'y', 0, 'started')`,
      `INSERT INTO publication_state (id, version, checksum) VALUES (1, 3, '${'d'.repeat(64)}')`
    ]) {
      const { database, target } = sqliteD1()
      target.applyMigrations()
      database.exec(statement)
      await expect(
        importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
      ).rejects.toThrow('only into an empty database')
    }
  })

  it('refuses an unverifiable or tampered artifact before touching D1', async () => {
    const { target } = sqliteD1()
    target.applyMigrations()
    const unverified = fixtureReport()
    unverified.artifact = {}
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: unverified })
    ).rejects.toThrow('no artifact.sqlChecksum')
    const tampered = fixtureReport()
    tampered.artifact = { sqlChecksum: 'e'.repeat(64) }
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: tampered })
    ).rejects.toThrow('reviewed artifact checksum')
    expect((await checkDatabase(target)).publication.rows).toBe(0)
  })

  it('names every table and parity count that differs from the reviewed import', async () => {
    const { database, target } = sqliteD1()
    target.applyMigrations()
    await importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })

    await expect(
      verifyImportedCatalog(target, 'production', {
        paths,
        report: fixtureReport({ listingCount: 2 })
      })
    ).rejects.toThrow('listing_count is 1, expected 2')

    database.exec("UPDATE listings SET name = 'Tampered' WHERE id = 'lst_fixture0001'")
    await expect(
      verifyImportedCatalog(target, 'production', { paths, report: fixtureReport() })
    ).rejects.toThrow('Tables: listings.')
  })

  it('refuses to deploy older code over a database with unknown migrations', async () => {
    const { database, target } = sqliteD1()
    target.applyMigrations()
    await importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
    database.exec("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')")
    await expect(
      checkDatabase(target).then(readiness => assertDatabaseReady(readiness, 'staging'))
    ).rejects.toThrow('does not contain (9999_future.sql)')
  })
})

describe('backup and deploy', () => {
  it('records an empty database explicitly and exports a populated one', async () => {
    const empty = sqliteD1()
    const emptyBackup = await backupDatabase(
      empty.target,
      'production',
      join(fixtureDirectory, 'backups', 'empty.sql')
    )
    expect(emptyBackup.empty).toBe(true)
    expect(empty.exports).toEqual([])
    expect(readFileSync(emptyBackup.output, 'utf8')).toContain(
      'best-serp-co-production had no tables'
    )

    const populated = sqliteD1()
    populated.target.applyMigrations()
    const output = join(fixtureDirectory, 'backups', 'populated.sql')
    const backup = await backupDatabase(populated.target, 'production', output)
    expect(populated.exports).toEqual([output])
    expect(backup).toMatchObject({ empty: false, output, sha256: sha256('-- exported\n') })
  })

  it('deploys the built Worker only onto a ready database', async () => {
    const entrypoint = join(fixtureDirectory, 'worker.js')
    const calls: string[][] = []
    const runner: ProcessRunner = {
      run(command, args) {
        calls.push([command, ...args])
        return ''
      }
    }
    const { target } = sqliteD1()
    await expect(
      deployWorker(target, 'production', runner, join(fixtureDirectory, 'missing.js'))
    ).rejects.toThrow('pnpm worker:build')
    writeFileSync(entrypoint, '')
    target.applyMigrations()
    await expect(deployWorker(target, 'production', runner, entrypoint)).rejects.toThrow(
      'no catalog publication'
    )
    expect(calls).toEqual([])
    await importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
    await deployWorker(target, 'production', runner, entrypoint)
    expect(calls).toEqual([
      ['pnpm', '--filter', 'web', 'exec', 'opennextjs-cloudflare', 'deploy', '--env', 'production']
    ])
  })
})

describe('release arguments', () => {
  it('parses explicit commands, environments, and options', () => {
    expect(parseReleaseArguments(['--', 'migrate', 'staging'])).toEqual({
      command: 'migrate',
      environment: 'staging'
    })
    expect(parseReleaseArguments(['backup', 'production', '--output', '/tmp/b.sql'])).toEqual({
      command: 'backup',
      environment: 'production',
      output: '/tmp/b.sql'
    })
    expect(parseReleaseArguments(['import', 'production', '--rehearse', '/tmp/r'])).toMatchObject({
      rehearse: '/tmp/r'
    })
    expect(() => parseReleaseArguments(['publish', 'production'])).toThrow('command must be')
    expect(() => parseReleaseArguments(['migrate', 'preview'])).toThrow('staging or production')
    expect(() => parseReleaseArguments(['backup', 'production'])).toThrow('--output')
    expect(() => parseReleaseArguments(['migrate', 'staging', '--site', 'x'])).toThrow('Usage')
    expect(() => parseReleaseArguments(['import', 'production', '--rehearse', 'rel'])).toThrow(
      'absolute'
    )
    for (const command of ['deploy', 'backup']) {
      expect(() =>
        parseReleaseArguments([command, 'staging', '--output', '/tmp/o', '--rehearse', '/tmp/r'])
      ).toThrow('cannot be rehearsed')
    }
  })
})
