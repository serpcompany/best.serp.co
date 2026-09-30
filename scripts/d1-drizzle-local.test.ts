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
import { canonicalPreviewCommand } from './d1-local-preview'
import { resolveFreshD1StateRoot } from './d1-local-state'
import { applicationColumnInventory, importOrder } from './d1-table-inventory'
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
        migrations_dir: resolve('d1/drizzle')
      }
    ],
    main: resolve(project.appDirectory, '.open-next/worker.js'),
    name: project.local.workerName,
    vars: {
      D1_RUNTIME_ENV: 'local'
    }
  }
}

describe('fresh Drizzle D1 history', () => {
  it('uses a credential-free generator and one baseline Wrangler history', () => {
    const config = readFileSync(resolve('drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './d1/drizzle'")
    expect(config).toContain("schema: './packages/data-ops/src/schema.ts'")
    expect(config).not.toMatch(/accountId|databaseId|token|process\.env/u)
    expect(freshMigrationNames()).toEqual(['0000_baseline.sql'])
    expect(existsSync(resolve('d1/migrations'))).toBe(false)

    const migration = readFileSync(resolve(freshMigrationsDirectory, '0000_baseline.sql'), 'utf8')
    expect(migration.match(/^CREATE TABLE/gmu)).toHaveLength(applicationTableNames.length)
    expect(migration.match(/^\) STRICT;/gmu)).toHaveLength(applicationTableNames.length)
    for (const trigger of d1TriggerNames) expect(migration).toContain(`CREATE TRIGGER ${trigger}`)
    for (const index of requiredIndexNames) expect(migration).toContain(`\`${index}\``)
    expect(migration).toContain('COLLATE NOCASE')
    expect(migration).not.toMatch(/site_id|`sites`/u)
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

  it('migrates empty canonical local state and verifies the exact fresh schema', () => {
    const stateDirectory = temporaryDirectory('best-serp-co-drizzle-')
    expect(runLocal('migrate', stateDirectory)).toContain('0000_baseline.sql')
    expect(runDrizzle('verify', stateDirectory)).toContain('"status":"verified"')
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
      mutateCanonicalState(stateDirectory)
      expect(() => runLocal('verify', stateDirectory)).toThrow()
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
      d1_databases: Array<{ database_id: string; migrations_dir: string }>
      main: string
      name: string
      vars: Record<string, string>
    }
    expect(config.name).toBe('best-serp-co-local')
    expect(config.main).toBe('.open-next/worker.js')
    expect(config.d1_databases).toHaveLength(1)
    expect(config.d1_databases[0]?.database_id).toBe('00000000-0000-0000-0000-000000000001')
    expect(config.d1_databases[0]?.migrations_dir).toBe('../../d1/drizzle')
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
        config.main = resolve('apps/other/.open-next/worker.js')
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
      expect(expected.startsWith('/')).toBe(true)

      const appPackage = JSON.parse(
        readFileSync(resolve(project.appDirectory, 'package.json'), 'utf8')
      ) as { name: string; scripts: Record<string, string> }
      expect(appPackage.name).toBe(project.appPackageName)
      expect(appPackage.scripts['preview:worker']).toContain('scripts/d1-local-preview.ts')
      expect(appPackage.scripts['preview:worker']).not.toContain('--site')

      const playwright = readFileSync(resolve('apps/e2e/playwright.config.ts'), 'utf8')
      expect(playwright).toContain('pnpm d1:local:migrate')
      expect(playwright).toContain('pnpm d1:local:import')
      expect(playwright).toContain('pnpm d1:local:verify')
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
    expect(scripts['d1:generate']).toBe('pnpm exec drizzle-kit generate --config drizzle.config.ts')
    expect(Object.keys(scripts).filter(name => name.startsWith('d1:drizzle:'))).toEqual([])
    for (const command of ['migrate', 'import', 'verify', 'publish']) {
      expect(scripts[`d1:local:${command}`]).toBe(`pnpm tsx scripts/d1-local-guard.ts ${command}`)
    }
    expect(Object.values(scripts).join('\n')).not.toMatch(/--site\b/u)
  })
})
