import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applicationTableNames,
  canonicalLocalConfig,
  d1TriggerNames,
  freshMigrationNames,
  freshMigrationsDirectory,
  requiredIndexNames
} from './d1-drizzle-local'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { canonicalPreviewCommand, localPreviewVarArgs } from './d1-local-preview'
import { resolveFreshD1StateRoot } from './d1-local-state'
import { applicationColumnInventory, importOrder, parityTableNames } from './d1-table-inventory'
import { project } from './project'

const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function runLocal(command: string, stateDirectory: string): string {
  return execFileSync('pnpm', ['tsx', 'scripts/d1-local-guard.ts', command], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      HARNESS_D1_STATE_DIRECTORY: stateDirectory,
      WRANGLER_SEND_METRICS: 'false'
    }
  })
}

/**
 * Runs a local D1 command that must fail and returns its stderr. The stderr is captured, not
 * passed through, so an expected failure never reads like a real one in the harness output.
 */
function failingLocalStderr(command: string, stateDirectory: string): string {
  try {
    execFileSync('pnpm', ['tsx', 'scripts/d1-local-guard.ts', command], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        HARNESS_D1_STATE_DIRECTORY: stateDirectory,
        WRANGLER_SEND_METRICS: 'false'
      },
      stdio: 'pipe'
    })
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? '')
  }
  throw new Error(`d1-local-guard ${command} succeeded, but it was expected to fail.`)
}

function runDrizzle(command: string, stateDirectory: string): string {
  return execFileSync('pnpm', ['tsx', 'scripts/d1-drizzle-local.ts', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_D1_STATE_DIRECTORY: stateDirectory,
      WRANGLER_SEND_METRICS: 'false'
    }
  })
}

function executeLocal(stateDirectory: string, command: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      project.local.databaseName,
      '--command',
      command,
      '--local',
      '--persist-to',
      resolve(stateDirectory, 'drizzle', 'best-serp-co'),
      '--config',
      project.wranglerConfigPath
    ],
    { stdio: 'ignore' }
  )
}

function mutateCanonicalState(stateDirectory: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      project.local.databaseName,
      '--command',
      "UPDATE listing_resource_links SET label=label || ' tampered' WHERE id=(SELECT id FROM listing_resource_links ORDER BY id LIMIT 1)",
      '--local',
      '--persist-to',
      resolve(stateDirectory, 'drizzle', 'best-serp-co'),
      '--config',
      project.wranglerConfigPath
    ],
    { stdio: 'ignore' }
  )
}

function freshDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  return database
}

interface LocalConfigFixture {
  assets: { binding: string; directory: string }
  d1_databases: Array<{
    binding: string
    database_id: string
    database_name: string
    migrations_dir: string
    migrations_table?: string
  }>
  main: string
  name: string
  vars: Record<string, string>
}

function validLocalConfig(): LocalConfigFixture {
  return {
    assets: {
      binding: 'ASSETS',
      directory: resolve(project.appDirectory, '.open-next/assets')
    },
    d1_databases: [
      {
        binding: 'DB',
        database_id: project.local.databaseId,
        database_name: project.local.databaseName,
        migrations_dir: resolve('d1/drizzle'),
        migrations_table: project.migrationsTable
      }
    ],
    main: resolve(project.workerEntryPath),
    name: project.local.workerName,
    vars: {
      D1_RUNTIME_ENV: 'local'
    }
  }
}

describe('fresh Drizzle D1 history', () => {
  it('uses a credential-free generator and one forward-only Wrangler history', () => {
    const config = readFileSync(resolve('drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './d1/drizzle'")
    expect(config).toContain("schema: './packages/data-ops/src/schema.ts'")
    expect(config).not.toMatch(/accountId|databaseId|token|process\.env/u)
    expect(freshMigrationNames()).toEqual([
      '0000_baseline.sql',
      '0001_email_deliveries.sql',
      '0002_better_auth.sql',
      '0003_submissions_data_model.sql',
      '0004_query_indexes.sql',
      '0005_admin_panel.sql',
      '0006_badge_program.sql',
      '0007_listing_claims.sql'
    ])
    expect(existsSync(resolve('d1/migrations'))).toBe(false)
    // Drizzle's journal lists exactly the SQL files, in order, each with its snapshot.
    const journal = JSON.parse(
      readFileSync(resolve(freshMigrationsDirectory, 'meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number; tag: string }> }
    expect(journal.entries.map(entry => `${entry.tag}.sql`)).toEqual(freshMigrationNames())
    expect(journal.entries.map(entry => entry.idx)).toEqual(
      freshMigrationNames().map((_, index) => index)
    )
    for (const entry of journal.entries) {
      const snapshot = `meta/${entry.tag.slice(0, 4)}_snapshot.json`
      expect(existsSync(resolve(freshMigrationsDirectory, snapshot)), snapshot).toBe(true)
    }

    const baseline = readFileSync(resolve(freshMigrationsDirectory, '0000_baseline.sql'), 'utf8')
    // The primary-category triggers live in the baseline; later triggers in their migration.
    for (const trigger of d1TriggerNames.filter(name => name.includes('primary'))) {
      expect(baseline).toContain(`CREATE TRIGGER ${trigger}`)
    }
    expect(baseline).toContain('COLLATE NOCASE')

    // Every table of every migration is STRICT (Drizzle cannot express it; see DATA_MODEL.md).
    // A rebuild creates `__new_<table>` and renames it over the table it replaces.
    const history = freshMigrationNames()
      .map(name => readFileSync(resolve(freshMigrationsDirectory, name), 'utf8'))
      .join('\n')
    const created = [...history.matchAll(/^CREATE TABLE `([^`]+)`/gmu)].map(match => match[1])
    const rebuilt = created.filter(name => name?.startsWith('__new_'))
    expect(created.filter(name => !name?.startsWith('__new_')).sort()).toEqual(
      [...applicationTableNames].sort()
    )
    expect(history.match(/^\) STRICT;/gmu)).toHaveLength(created.length)
    for (const name of rebuilt) {
      expect(history).toContain(`ALTER TABLE \`${name}\` RENAME TO \`${name?.slice(6)}\`;`)
    }
    // SQLite cannot add a CHECK constraint to an existing table without a rebuild, and
    // rebuilding `listings` would cascade-delete its children: it only ever gains columns.
    expect(rebuilt).not.toContain('__new_listings')
    expect(history).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/iu)
    for (const index of requiredIndexNames) expect(history).toContain(`\`${index}\``)
    for (const trigger of d1TriggerNames) expect(history).toContain(`CREATE TRIGGER ${trigger}`)
    expect(history).not.toMatch(/\bsite_id\b|`sites`/u)
  })

  it('seeds the admin allowlist with the owner only, deterministically', () => {
    const database = freshDatabase()
    const rows = database
      .prepare('SELECT email, created_at FROM admin_allowlist ORDER BY email')
      .all()
    // A fixed created_at keeps the bootstrap snapshot (verify-import, db:verify:local) exact.
    expect(rows.map(row => [String(row.email), String(row.created_at)])).toEqual([
      ['devin@serp.co', '2026-10-06 00:00:00']
    ])
    expect(() =>
      database.exec(
        "INSERT INTO admin_allowlist (email, added_by) VALUES ('Owner@Example.com', 'x')"
      )
    ).toThrow(/CHECK constraint/u)
    database.close()
  })

  it('keeps the exact table and column inventory in sync with the applied schema', () => {
    const database = freshDatabase()
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(row => String(row.name))
    expect(tables).toEqual([...applicationTableNames].sort())
    expect([...importOrder].sort()).toEqual([...applicationTableNames].sort())
    for (const table of applicationTableNames) {
      const columns = database
        .prepare(`PRAGMA table_info('${table}')`)
        .all()
        .map(row => String(row.name))
      expect(columns, `${table} columns`).toEqual([...applicationColumnInventory[table]])
    }
    const triggers = database
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map(row => String(row.name))
    expect(triggers).toEqual([...d1TriggerNames].sort())
    database.close()
  })

  it('keeps publication state a singleton', () => {
    const database = freshDatabase()
    database.exec("INSERT INTO publication_state (id,version,checksum) VALUES (1,0,'empty')")
    expect(() =>
      database.exec("INSERT INTO publication_state (id,version,checksum) VALUES (2,0,'second')")
    ).toThrow(/CHECK constraint/u)
    database.close()
  })

  it('upgrades a populated database to the #62 data model with foreign keys enforced', () => {
    // D1 enforces foreign keys and runs a migration in one transaction, so a rebuild that dropped
    // a parent still referenced by a child would cascade-delete the child rows.
    const database = new DatabaseSync(':memory:')
    const names = freshMigrationNames()
    const dataModelIndex = names.indexOf('0003_submissions_data_model.sql')
    const dataModel = names[dataModelIndex]
    expect(dataModelIndex).toBeGreaterThan(0)
    for (const migration of names.slice(0, dataModelIndex)) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, String(migration)), 'utf8'))
    }
    database.exec(`
      INSERT INTO categories (slug, name) VALUES ('tools', 'Tools');
      INSERT INTO listings (id, slug, name, description, website, status, source_kind,
        source_identity, checksum)
      VALUES ('lst_imported', 'imported.example', 'Imported', 'd', 'https://imported.example/',
        'draft', 'legacy-json-migration-v1', 'imported', 'c'),
        ('lst_submitted', 'submitted.example', 'Submitted', 'd', 'https://submitted.example/',
        'draft', 'verified-submission', 'sub', 'c');
      INSERT INTO listing_categories VALUES ('lst_imported', 1, 0, 1), ('lst_submitted', 1, 0, 1);
      UPDATE listings SET status = 'approved', published_at = '2026-05-16';
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, access_token_hash, listing_id)
      VALUES ('sub', 'submitted.example', 'Submitted', 'd', 'https://submitted.example/', 'c',
        'tools', 'https://submitted.example/logo.png', 'approved', 'digest', 'lst_submitted');
      INSERT INTO listing_submission_resource_links (submission_id, label, url)
        VALUES ('sub', 'Docs', 'https://submitted.example/docs');
      INSERT INTO listing_submission_faqs (submission_id, question, answer)
        VALUES ('sub', 'Q', 'A');
      INSERT INTO listing_submission_events (submission_id, event_type, actor)
        VALUES ('sub', 'approved', 'reviewer');
      INSERT INTO listing_submission_notifications (submission_id, channel, external_id,
        external_url, recipient) VALUES ('sub', 'github_issue', '1', 'https://example.com/1', 'r');
    `)
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    database.exec('BEGIN')
    database.exec(readFileSync(resolve(freshMigrationsDirectory, String(dataModel)), 'utf8'))
    database.exec('COMMIT')

    for (const table of [
      'listing_submissions',
      'listing_submission_resource_links',
      'listing_submission_faqs',
      'listing_submission_events',
      'listing_submission_notifications'
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
        count: 1
      })
    }
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.prepare('SELECT id, source, link_rel FROM listings ORDER BY id').all()).toEqual(
      [
        { id: 'lst_imported', link_rel: 'follow', source: 'admin' },
        { id: 'lst_submitted', link_rel: 'follow', source: 'submission' }
      ]
    )
    expect(
      database
        .prepare('SELECT status, plan, owner_user_id, access_token_hash FROM listing_submissions')
        .get()
    ).toEqual({
      access_token_hash: 'digest',
      owner_user_id: null,
      plan: 'free',
      status: 'approved'
    })
    // The rebuilt children follow the renamed parent, so cascades still reach them.
    expect(
      database.prepare("SELECT sql FROM sqlite_master WHERE name='listing_submission_faqs'").get()
    ).toMatchObject({ sql: expect.stringContaining('REFERENCES "listing_submissions"') })
    // Every later migration (0004: query indexes, #77; 0005: admin panel, #64) applies to the populated database too.
    for (const migration of names.slice(dataModelIndex + 1)) {
      database.exec('BEGIN')
      database.exec(readFileSync(resolve(freshMigrationsDirectory, String(migration)), 'utf8'))
      database.exec('COMMIT')
    }
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(database.prepare('SELECT COUNT(*) AS count FROM listings').get()).toEqual({ count: 2 })
    database.exec("DELETE FROM listing_submissions WHERE id = 'sub'")
    expect(database.prepare('SELECT COUNT(*) AS count FROM listing_submission_faqs').get()).toEqual(
      {
        count: 0
      }
    )
    database.close()
  })

  it('upgrades a populated database to the #64 listing log and admin ownership', () => {
    // `listing_owners` is rebuilt to accept `verified_via = 'admin'`; nothing references it, so
    // the rebuild keeps every row, including revoked history, under enforced foreign keys.
    const database = new DatabaseSync(':memory:')
    const names = freshMigrationNames()
    const adminPanel = '0005_admin_panel.sql'
    for (const migration of names.slice(0, names.indexOf(adminPanel))) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, String(migration)), 'utf8'))
    }
    database.exec(`
      INSERT INTO categories (slug, name) VALUES ('tools', 'Tools');
      INSERT INTO listings (id, slug, name, description, website, status, source_kind,
        source_identity, checksum)
      VALUES ('lst_owned', 'owned.example', 'Owned', 'd', 'https://owned.example/', 'draft',
        'legacy-json-migration-v1', 'owned', 'c');
      INSERT INTO listing_categories VALUES ('lst_owned', 1, 0, 1);
      UPDATE listings SET status = 'approved', published_at = '2026-05-16';
      INSERT INTO users (id, name, email, email_verified)
        VALUES ('user_a', 'A', 'a@example.com', 1), ('user_b', 'B', 'b@example.com', 1);
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at, revoked_at,
        revoked_reason)
      VALUES ('lst_owned', 'user_a', 'badge_claim', '2026-09-03T00:00:00.000Z',
        '2026-09-20T00:00:00.000Z', 'badge_removed'),
        ('lst_owned', 'user_b', 'paid_claim', '2026-09-21T00:00:00.000Z', NULL, NULL);
    `)
    database.exec('BEGIN')
    database.exec(readFileSync(resolve(freshMigrationsDirectory, adminPanel), 'utf8'))
    database.exec('COMMIT')

    expect(
      database
        .prepare('SELECT user_id, verified_via, revoked_reason FROM listing_owners ORDER BY id')
        .all()
    ).toEqual([
      { revoked_reason: 'badge_removed', user_id: 'user_a', verified_via: 'badge_claim' },
      { revoked_reason: null, user_id: 'user_b', verified_via: 'paid_claim' }
    ])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    database.exec(`
      UPDATE listing_owners SET revoked_at = '2026-10-06T00:00:00.000Z',
        revoked_reason = 'transferred' WHERE user_id = 'user_b';
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('lst_owned', 'user_a', 'admin', '2026-10-06T00:00:00.000Z');
      INSERT INTO listing_events (listing_id, event_type, actor)
        VALUES ('lst_owned', 'owner_transferred', 'admin@example.com');
    `)
    // One current owner per listing still holds after the rebuild.
    expect(() =>
      database.exec(`INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('lst_owned', 'user_b', 'admin', '2026-10-06T00:00:00.000Z')`)
    ).toThrow(/UNIQUE constraint/u)
    expect(() =>
      database.exec(`INSERT INTO listing_events (listing_id, event_type, actor)
        VALUES ('lst_owned', 'deleted', 'admin@example.com')`)
    ).toThrow(/CHECK constraint/u)
    database.exec("UPDATE listings SET is_active = 0 WHERE id = 'lst_owned'")
    database.exec("DELETE FROM listings WHERE id = 'lst_owned'")
    expect(database.prepare('SELECT COUNT(*) AS count FROM listing_events').get()).toEqual({
      count: 0
    })
    database.close()
  })

  it('upgrades populated badge checks to the #66 check kinds', () => {
    // `badge_checks` is rebuilt to add `kind`; nothing references it, so every row is kept as a
    // weekly check under enforced foreign keys, and the CHECKs and index survive.
    const database = new DatabaseSync(':memory:')
    const names = freshMigrationNames()
    const badgeProgram = '0006_badge_program.sql'
    for (const migration of names.slice(0, names.indexOf(badgeProgram))) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, String(migration)), 'utf8'))
    }
    database.exec(`
      INSERT INTO listings (id, slug, name, description, website, status, source_kind,
        source_identity, checksum)
      VALUES ('lst_badge', 'badge.example', 'Badge', 'd', 'https://badge.example/', 'draft',
        'legacy-json-migration-v1', 'badge', 'c');
      INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive)
      VALUES ('lst_badge', '2026-10-01T00:00:00.000Z', 'pass', NULL, 1),
        ('lst_badge', '2026-10-02T00:00:00.000Z', 'fail', 'fetch_timeout', 0);
    `)
    database.exec('BEGIN')
    database.exec(readFileSync(resolve(freshMigrationsDirectory, badgeProgram), 'utf8'))
    database.exec('COMMIT')

    expect(
      database.prepare('SELECT id, outcome, reason, conclusive, kind FROM badge_checks').all()
    ).toEqual([
      { conclusive: 1, id: 1, kind: 'weekly', outcome: 'pass', reason: null },
      { conclusive: 0, id: 2, kind: 'weekly', outcome: 'fail', reason: 'fetch_timeout' }
    ])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'badge_checks'"
        )
        .all()
    ).toEqual([{ name: 'badge_checks_listing_time_idx' }])
    expect(() =>
      database.exec(`INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive,
        kind) VALUES ('lst_badge', '2026-10-03T00:00:00.000Z', 'pass', NULL, 1, 'manual')`)
    ).toThrow(/CHECK constraint/u)
    database.exec(`INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive,
      kind) VALUES ('lst_badge', '2026-10-03T00:00:00.000Z', 'fail', 'badge_missing', 1,
      'confirmation')`)
    database.exec("DELETE FROM listings WHERE id = 'lst_badge'")
    expect(database.prepare('SELECT COUNT(*) AS count FROM badge_checks').get()).toEqual({
      count: 0
    })
    database.close()
  })

  it('migrates empty canonical local state and verifies the exact fresh schema', () => {
    const stateDirectory = temporaryDirectory('best-serp-co-drizzle-')
    // pnpm db:migrations:list:local lists what pnpm db:migrate:local will apply: every migration.
    const listed = runLocal('list', stateDirectory)
    const migrated = runLocal('migrate', stateDirectory)
    for (const name of freshMigrationNames()) {
      expect(listed, name).toContain(name)
      expect(migrated, name).toContain(name)
    }
    expect(runDrizzle('verify', stateDirectory)).toContain('"status":"verified"')
    expect(runLocal('list', stateDirectory)).toContain('No migrations to apply')
    expect(runLocal('migrate', stateDirectory)).toContain('No migrations to apply')
  }, 180_000)

  it.runIf(
    existsSync(resolve(project.artifact.batchDirectory, '0001.sql')) ||
      existsSync(resolve(project.artifact.compressedSqlPath))
  )(
    'bootstraps the reviewed initial artifact with exact repeatable parity',
    () => {
      const stateDirectory = temporaryDirectory('best-serp-co-bootstrap-')
      runLocal('migrate', stateDirectory)
      runLocal('import', stateDirectory)
      expect(runLocal('verify', stateDirectory)).toContain('Verified local D1 publication')
      expect(runLocal('import', stateDirectory)).toContain('import is a no-op')
      expect(runLocal('verify', stateDirectory)).toContain('Verified local D1 publication')
      // Accounts created at runtime (sign-ins, code limits) are outside bootstrap parity.
      executeLocal(
        stateDirectory,
        "INSERT INTO users (id, name, email, email_verified) VALUES ('u1', '', 'a@example.com', 1); INSERT INTO auth_rate_limit_hits (bucket, hit_at) VALUES ('b', 1)"
      )
      // The count comes from the table inventory, so a migration that adds a table cannot
      // leave a stale number here (#77).
      const parityTables = `${parityTableNames.length}-table`
      expect(runLocal('verify', stateDirectory)).toContain(`exact ${parityTables} snapshot`)
      mutateCanonicalState(stateDirectory)
      // The tampered table, and nothing else, must fail parity (not a crash or a missing report).
      expect(failingLocalStderr('verify', stateDirectory)).toContain(
        `Local D1 exact ${parityTables} bootstrap parity failed: listing_resource_links.`
      )
    },
    240_000
  )

  it('rejects the retired --site argument with remediation', () => {
    expect(() =>
      execFileSync(
        'pnpm',
        ['tsx', 'scripts/d1-local-guard.ts', 'verify', '--site', 'serp.software'],
        {
          encoding: 'utf8',
          stdio: 'pipe'
        }
      )
    ).toThrow(/no longer take --site/u)
  }, 60_000)

  it('uses the checked-in isolated local identity only', () => {
    const local = canonicalLocalConfig()
    expect(local).toEqual({
      configPath: 'apps/web/wrangler.jsonc',
      databaseName: 'best-serp-co-local'
    })
    const config = JSON.parse(readFileSync(local.configPath, 'utf8')) as {
      d1_databases: Array<{ database_id: string; migrations_dir: string; migrations_table: string }>
      main: string
      name: string
      vars: Record<string, string>
    }
    expect(config.name).toBe('best-serp-co-local')
    expect(config.main).toBe('worker.ts')
    expect(config.d1_databases).toHaveLength(1)
    expect(config.d1_databases[0]?.database_id).toBe('00000000-0000-0000-0000-000000000001')
    expect(config.d1_databases[0]?.migrations_dir).toBe('../../d1/drizzle')
    expect(config.d1_databases[0]?.migrations_table).toBe('d1_migrations')
    expect(config.vars.D1_RUNTIME_ENV).toBe('local')
    expect(Object.keys(config.vars)).not.toContain('SITE_ID')
    expect(Object.keys(config.vars)).not.toContain('NEXT_PUBLIC_SITE_ID')
  })

  it('rejects local configs with remote identities, retired variables, or miswiring', () => {
    const directory = temporaryDirectory('best-serp-co-local-config-')
    const validConfigPath = join(directory, 'valid.jsonc')
    writeFileSync(validConfigPath, JSON.stringify(validLocalConfig()))
    expect(() => validateCanonicalLocalConfig(validConfigPath)).not.toThrow()

    const assertRejected = (
      name: string,
      mutate: (config: LocalConfigFixture) => void,
      message: RegExp
    ) => {
      const config = validLocalConfig()
      mutate(config)
      const configPath = join(directory, `${name}.jsonc`)
      writeFileSync(configPath, JSON.stringify(config))
      expect(() => validateCanonicalLocalConfig(configPath), name).toThrow(message)
    }
    assertRejected(
      'runtime-env',
      config => {
        config.vars.D1_RUNTIME_ENV = 'production'
      },
      /dedicated local best\.serp\.co Worker/u
    )
    assertRejected(
      'worker-name',
      config => {
        config.name = 'best-serp-co-production'
      },
      /dedicated local/u
    )
    assertRejected(
      'site-id',
      config => {
        config.vars.SITE_ID = 'best.serp.co'
      },
      /retired multi-site variables: SITE_ID/u
    )
    assertRejected(
      'public-site-id',
      config => {
        config.vars.NEXT_PUBLIC_SITE_ID = 'best.serp.co'
      },
      /NEXT_PUBLIC_SITE_ID/u
    )
    assertRejected(
      'worker-main',
      config => {
        config.main = resolve('apps/web/.open-next/worker.js')
      },
      /OpenNext Worker/u
    )
    assertRejected(
      'assets',
      config => {
        config.assets.directory = resolve('apps/other/.open-next/assets')
      },
      /OpenNext Worker/u
    )
    assertRejected(
      'database',
      config => {
        const binding = config.d1_databases[0]
        if (binding) binding.database_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      },
      /non-local, staging, or production D1 identity/u
    )
    assertRejected(
      'migrations',
      config => {
        const binding = config.d1_databases[0]
        if (binding) binding.migrations_dir = resolve('d1/migrations')
      },
      /d1\/drizzle/u
    )
    assertRejected(
      'migrations-table',
      config => {
        const binding = config.d1_databases[0]
        if (binding) delete binding.migrations_table
      },
      /migrations_table "d1_migrations"/u
    )
    assertRejected(
      'other-migrations-table',
      config => {
        const binding = config.d1_databases[0]
        if (binding) binding.migrations_table = 'migrations'
      },
      /migrations_table "d1_migrations"/u
    )
  })

  it('makes direct app preview and Playwright consume canonical initialized state', () => {
    const stateRoot = resolve('/tmp/canonical-preview-contract')
    const previous = process.env.HARNESS_D1_STATE_DIRECTORY
    process.env.HARNESS_D1_STATE_DIRECTORY = stateRoot
    try {
      const command = canonicalPreviewCommand()
      const expected = resolveFreshD1StateRoot({
        harnessStateDirectory: stateRoot,
        repositoryRoot: resolve('.')
      })
      expect(command.statePath).toBe(expected)
      expect(command.args.slice(0, 2)).toEqual(['--filter', 'web'])
      const configFlag = command.args.indexOf('--config')
      const configPath = command.args[configFlag + 1]
      expect(configPath).toBe(resolve(project.wranglerConfigPath))
      expect(configPath && existsSync(configPath)).toBe(true)
      expect(command.args).toContain(expected)
      expect(command.args).toContain('--test-scheduled')
      expect(expected.startsWith('/')).toBe(true)

      const appPackage = JSON.parse(
        readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
      ) as { name: string; scripts: Record<string, string> }
      expect(appPackage.name).toBe(project.appPackageName)
      expect(appPackage.scripts['preview:worker']).toContain('scripts/d1-local-preview.ts')
      expect(appPackage.scripts['preview:worker']).not.toContain('--site')

      expect(localPreviewVarArgs(undefined)).toEqual([])
      expect(localPreviewVarArgs('CF_ACCESS_REQUIRED=on,CF_ACCESS_AUD=abc123')).toEqual([
        '--var',
        'CF_ACCESS_REQUIRED:on',
        '--var',
        'CF_ACCESS_AUD:abc123'
      ])
      expect(localPreviewVarArgs('LOCAL_BADGE_PROGRAM=on,LOCAL_CLAIMS=on')).toEqual([
        '--var',
        'LOCAL_BADGE_PROGRAM:on',
        '--var',
        'LOCAL_CLAIMS:on'
      ])
      for (const refused of [
        'SITE_ENVIRONMENT=production',
        'D1_RUNTIME_ENV=production',
        'CF_ACCESS_REQUIRED',
        'CF_ACCESS_AUD=a b',
        'CF_ACCESS_AUD=a;rm -rf /'
      ]) {
        expect(() => localPreviewVarArgs(refused), refused).toThrow(/LOCAL_PREVIEW_VARS/u)
      }

      const playwright = readFileSync(resolve('apps/e2e/playwright.config.ts'), 'utf8')
      expect(playwright).toContain('pnpm db:migrate:local')
      expect(playwright).toContain('pnpm db:import:local')
      expect(playwright).toContain('pnpm db:verify:local')
      expect(playwright).toContain('pnpm worker:preview')
      expect(playwright).not.toContain('pornvideodownloaders')
    } finally {
      if (previous === undefined) delete process.env.HARNESS_D1_STATE_DIRECTORY
      else process.env.HARNESS_D1_STATE_DIRECTORY = previous
    }
  })

  it('exposes one target-neutral generator and site-free local D1 commands', () => {
    const scripts = (
      JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['db:generate']).toBe('pnpm exec drizzle-kit generate --config drizzle.config.ts')
    expect(Object.keys(scripts).filter(name => name.startsWith('d1:'))).toEqual([])
    expect(scripts['db:migrations:list:local']).toBe('pnpm tsx scripts/d1-local-guard.ts list')
    for (const command of ['migrate', 'import', 'verify', 'publish']) {
      expect(scripts[`db:${command}:local`]).toBe(`pnpm tsx scripts/d1-local-guard.ts ${command}`)
    }
    expect(Object.values(scripts).join('\n')).not.toMatch(/--site\b/u)
  })
})
