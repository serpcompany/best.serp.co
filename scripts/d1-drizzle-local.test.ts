import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  requiredIndexNames
} from './d1-drizzle-local'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { canonicalPreviewCommand } from './d1-local-preview'
import { resolveFreshD1StateRoot } from './d1-local-state'
import { resolveSiteTarget } from './site-targets'

const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
})

function runLocal(command: string, siteId: string, stateDirectory: string): string {
  return execFileSync('pnpm', ['tsx', 'scripts/d1-local-guard.ts', command, '--site', siteId], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_D1_STATE_DIRECTORY: stateDirectory,
      WRANGLER_SEND_METRICS: 'false'
    }
  })
}

function mutateCanonicalState(siteId: string, stateDirectory: string): void {
  const target = resolveSiteTarget(siteId)
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      target.local.databaseName,
      '--command',
      "UPDATE listing_resource_links SET label=label || ' tampered' WHERE id=(SELECT id FROM listing_resource_links ORDER BY id LIMIT 1)",
      '--local',
      '--persist-to',
      resolve(stateDirectory, 'drizzle', siteId.replaceAll('.', '-')),
      '--config',
      target.local.configPath
    ],
    { stdio: 'ignore' }
  )
}

const legacyMigrationHashes = {
  '0001_public_catalog.sql': '041c03c75b7f20d74e64ea7bcfa86fc6518b6bc2d06213f00ad9bef0fe824c6a',
  '0002_listing_slug_redirects.sql':
    '7f99476cbf5064294a3fc485824b024fe4baf04cfb13242d53464a039ec63604',
  '0003_publication_run_provenance.sql':
    'c779ae13f3c444720dc9286c37e706b42a32753ef01f1253ed81aa27c2163e48',
  '0004_listing_display_order.sql':
    'ed32d025f2f89a5fd7791edd1b4aa63f403696d2628f0a6e31130873e1d95a64',
  '0005_listing_submissions.sql':
    'c81f10ef8a4cf306edc5b6045804910b5862750d81c4bf218901a192c734f767',
  '0006_submission_rate_limits.sql':
    '4e2342df1e8522ea5e782cae8ba0362bdb434a675151f2a652591fcb37592130',
  '0007_submission_notifications.sql':
    '2f7962566c298c5ef50bd6e34cc1546c2a21dfe70a8a76d831cbabec09282fc7',
  '0008_submission_review_preview.sql':
    '75f4a902a18104a396287ed132c2248cf9149816d5d3c0585b94c725071df09c',
  '0009_related_listing_name_index.sql':
    'cf188292330ed97c1879bb9ad54c4a1556b6f16f39fd505486dcf3f1a2772117'
} as const

describe('fresh Drizzle D1 history', () => {
  it('keeps the released legacy migration lineage byte-for-byte immutable', () => {
    for (const [name, expectedHash] of Object.entries(legacyMigrationHashes)) {
      const actualHash = createHash('sha256')
        .update(readFileSync(resolve('d1/migrations', name)))
        .digest('hex')
      expect(actualHash, name).toBe(expectedHash)
    }
  })

  it('uses a credential-free generator and a separate canonical Wrangler history', () => {
    const config = readFileSync(resolve('drizzle.config.ts'), 'utf8')
    expect(config).toContain("out: './d1/drizzle'")
    expect(config).toContain("schema: './packages/data-ops/src/schema.ts'")
    expect(config).not.toMatch(/accountId|databaseId|token|process\.env/u)
    expect(freshMigrationNames()).toEqual(['0000_remarkable_manta.sql'])

    const migration = readFileSync(resolve('d1/drizzle/0000_remarkable_manta.sql'), 'utf8')
    expect(migration.match(/^CREATE TABLE/gmu)).toHaveLength(applicationTableNames.length)
    expect(migration.match(/^\) STRICT;/gmu)).toHaveLength(applicationTableNames.length)
    for (const trigger of d1TriggerNames) expect(migration).toContain(`CREATE TRIGGER ${trigger}`)
    for (const index of requiredIndexNames) expect(migration).toContain(`\`${index}\``)
    expect(migration).toContain('COLLATE NOCASE')
  })

  it('models every legacy application table, column, and foreign key in the fresh schema', () => {
    const legacy = new DatabaseSync(':memory:')
    const fresh = new DatabaseSync(':memory:')
    legacy.exec('PRAGMA foreign_keys = ON')
    fresh.exec('PRAGMA foreign_keys = ON')
    for (const name of Object.keys(legacyMigrationHashes)) {
      legacy.exec(readFileSync(resolve('d1/migrations', name), 'utf8'))
    }
    fresh.exec(readFileSync(resolve('d1/drizzle/0000_remarkable_manta.sql'), 'utf8'))

    const tableNames = (database: DatabaseSync) =>
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map(row => String(row.name))
    expect(tableNames(fresh)).toEqual(tableNames(legacy))

    for (const table of applicationTableNames) {
      const columns = (database: DatabaseSync) =>
        database
          .prepare(`PRAGMA table_info('${table}')`)
          .all()
          .map(row => ({
            name: row.name,
            notNull: row.pk ? 1 : row.notnull,
            primaryKey: row.pk,
            type: row.type
          }))
      const foreignKeys = (database: DatabaseSync) =>
        database
          .prepare(`PRAGMA foreign_key_list('${table}')`)
          .all()
          .map(row => ({
            from: row.from,
            onDelete: row.on_delete,
            table: row.table,
            to: row.to
          }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      expect(columns(fresh), `${table} columns`).toEqual(columns(legacy))
      expect(foreignKeys(fresh), `${table} foreign keys`).toEqual(foreignKeys(legacy))
    }

    legacy.close()
    fresh.close()
  })

  it.each(['serp.software', 'pornvideodownloaders.com'] as const)(
    'migrates and bootstraps %s from empty canonical state with exact repeatable parity',
    siteId => {
      const stateDirectory = mkdtempSync(join(tmpdir(), `directory-platform-drizzle-${siteId}-`))
      temporaryDirectories.push(stateDirectory)

      const firstApply = runLocal('migrate', siteId, stateDirectory)
      expect(firstApply).toContain('0000_remarkable_manta.sql')
      runLocal('import', siteId, stateDirectory)
      expect(runLocal('verify', siteId, stateDirectory)).toContain('Verified local D1 publication')

      const secondApply = runLocal('migrate', siteId, stateDirectory)
      expect(secondApply).toContain('No migrations to apply')
      expect(runLocal('import', siteId, stateDirectory)).toContain('import is a no-op')
      expect(runLocal('verify', siteId, stateDirectory)).toContain('Verified local D1 publication')
      if (siteId === 'serp.software') {
        mutateCanonicalState(siteId, stateDirectory)
        expect(() => runLocal('verify', siteId, stateDirectory)).toThrow()
      }
    },
    120_000
  )

  it('uses checked-in isolated site-explicit local identities only', () => {
    const serp = canonicalLocalConfig(resolveSiteTarget('serp.software'))
    const pvd = canonicalLocalConfig(resolveSiteTarget('pornvideodownloaders.com'))
    const serpConfig = readFileSync(serp.configPath, 'utf8')
    const pvdConfig = readFileSync(pvd.configPath, 'utf8')

    expect(serp.databaseName).not.toBe(pvd.databaseName)
    expect(serpConfig).toContain('serp.software')
    expect(pvdConfig).toContain('pornvideodownloaders.com')
    expect(serpConfig).toContain('../../../d1/drizzle')
    expect(pvdConfig).toContain('../../../d1/drizzle')
    expect(serpConfig).toContain('../../../apps/serp.software/.open-next/worker.js')
    expect(pvdConfig).toContain('../../../apps/pornvideodownloaders.com/.open-next/worker.js')
    expect(serpConfig).toContain('"binding": "ASSETS"')
    expect(pvdConfig).toContain('"AUTH_TRUST_HOST": "true"')
    expect(`${serpConfig}\n${pvdConfig}`).not.toMatch(/preview|production|CLOUDFLARE_/u)
  })

  it('rejects a canonical local config that selects the legacy migration history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'directory-platform-legacy-local-config-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'local.jsonc')
    const target = resolveSiteTarget('serp.software')
    writeFileSync(
      configPath,
      JSON.stringify({
        assets: {
          binding: 'ASSETS',
          directory: resolve('apps/serp.software/.open-next/assets')
        },
        d1_databases: [
          {
            binding: 'DB',
            database_id: target.local.databaseId,
            database_name: target.local.databaseName,
            migrations_dir: resolve('d1/migrations')
          }
        ],
        main: resolve('apps/serp.software/.open-next/worker.js'),
        name: target.local.workerName,
        vars: {
          D1_RUNTIME_ENV: 'local',
          NEXT_PUBLIC_SITE_ID: target.siteId,
          SITE_ID: target.siteId
        }
      })
    )
    expect(() =>
      validateCanonicalLocalConfig({
        ...target,
        local: { ...target.local, configPath }
      })
    ).toThrow(/legacy d1\/migrations is recovery-only/u)
  })

  it('rejects cross-site variables and application or asset miswiring', () => {
    const directory = mkdtempSync(join(tmpdir(), 'directory-platform-local-miswire-'))
    temporaryDirectories.push(directory)
    const target = resolveSiteTarget('serp.software')
    const validConfig = {
      assets: {
        binding: 'ASSETS',
        directory: resolve('apps/serp.software/.open-next/assets')
      },
      d1_databases: [
        {
          binding: 'DB',
          database_id: target.local.databaseId,
          database_name: target.local.databaseName,
          migrations_dir: resolve('d1/drizzle')
        }
      ],
      main: resolve('apps/serp.software/.open-next/worker.js'),
      name: target.local.workerName,
      vars: {
        D1_RUNTIME_ENV: 'local',
        NEXT_PUBLIC_SITE_ID: target.siteId,
        SITE_ID: target.siteId
      }
    }
    const assertRejected = (name: string, mutate: (config: typeof validConfig) => void) => {
      const config = structuredClone(validConfig)
      mutate(config)
      const configPath = join(directory, `${name}.jsonc`)
      writeFileSync(configPath, JSON.stringify(config))
      expect(() =>
        validateCanonicalLocalConfig({
          ...target,
          local: { ...target.local, configPath }
        })
      ).toThrow()
    }
    assertRejected('site-id', config => {
      config.vars.SITE_ID = 'pornvideodownloaders.com'
    })
    assertRejected('public-site-id', config => {
      config.vars.NEXT_PUBLIC_SITE_ID = 'pornvideodownloaders.com'
    })
    assertRejected('worker-main', config => {
      config.main = resolve('apps/pornvideodownloaders.com/.open-next/worker.js')
    })
    assertRejected('assets', config => {
      config.assets.directory = resolve('apps/pornvideodownloaders.com/.open-next/assets')
    })
  })

  it('makes direct app preview and Playwright consume canonical initialized state', () => {
    const stateRoot = resolve('/tmp/canonical-preview-contract')
    const previous = process.env.HARNESS_D1_STATE_DIRECTORY
    process.env.HARNESS_D1_STATE_DIRECTORY = stateRoot
    try {
      for (const siteId of ['serp.software', 'pornvideodownloaders.com'] as const) {
        const command = canonicalPreviewCommand(siteId)
        const expected = resolveFreshD1StateRoot({
          harnessStateDirectory: stateRoot,
          repositoryRoot: resolve('.'),
          siteId
        })
        expect(command.statePath).toBe(expected)
        const configFlag = command.args.indexOf('--config')
        const configPath = command.args[configFlag + 1]
        expect(configPath).toBe(resolve(resolveSiteTarget(siteId).local.configPath))
        expect(configPath && existsSync(configPath)).toBe(true)
        expect(configPath?.startsWith('/')).toBe(true)
        expect(command.args).toContain(expected)
        expect(expected.startsWith('/')).toBe(true)
        const appPackage = JSON.parse(
          readFileSync(resolve('apps', siteId, 'package.json'), 'utf8')
        ) as { scripts: Record<string, string> }
        expect(appPackage.scripts['preview:worker']).toContain('scripts/d1-local-preview.ts')
        expect(appPackage.scripts['preview:worker']).toContain(`--site ${siteId}`)
      }
      const playwright = readFileSync(resolve('apps/e2e/playwright.config.ts'), 'utf8')
      expect(playwright).toContain('pnpm d1:local:migrate')
      expect(playwright).toContain('pnpm d1:local:import')
      expect(playwright).toContain('pnpm d1:local:verify')
      expect(playwright).toContain('pnpm worker:preview')
      expect(playwright).toContain('pnpm preview:pornvideodownloaders')
    } finally {
      if (previous === undefined) delete process.env.HARNESS_D1_STATE_DIRECTORY
      else process.env.HARNESS_D1_STATE_DIRECTORY = previous
    }
  })

  it('exposes one target-neutral generator and no duplicate Drizzle local aliases', () => {
    const scripts = (
      JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['d1:generate']).toBe('pnpm exec drizzle-kit generate --config drizzle.config.ts')
    expect(Object.keys(scripts).filter(name => name.startsWith('d1:drizzle:'))).toEqual([])
  })
})
