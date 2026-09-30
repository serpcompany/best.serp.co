import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { captureApplicationSnapshot, type SnapshotTransport } from './d1-application-snapshot'
import { freshMigrationNames } from './d1-drizzle-local'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { applicationTableNames } from './d1-replatform-inventory'
import { resolveSiteTarget, type SiteTarget } from './site-targets'

function statePath(target: SiteTarget): string {
  return configuredFreshD1StateRoot(target.siteId)
}

function wrangler(target: SiteTarget, args: string[], capture = false): string {
  try {
    return (
      execFileSync(
        'pnpm',
        [
          'exec',
          'wrangler',
          ...args,
          '--local',
          '--persist-to',
          statePath(target),
          '--config',
          target.local.configPath
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
          maxBuffer: 64 * 1024 * 1024,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        }
      ) || ''
    )
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    if (capture && stderr) throw new Error(String(stderr).trim())
    throw error
  }
}

function query(target: SiteTarget, command: string): unknown[] {
  const output = wrangler(
    target,
    ['d1', 'execute', target.local.databaseName, '--command', command, '--json'],
    true
  )
  const parsed = JSON.parse(output) as Array<{ results?: unknown[] }>
  return parsed[0]?.results || []
}

function migrate(target: SiteTarget): void {
  wrangler(target, ['d1', 'migrations', 'apply', target.local.databaseName])
}

function importArtifact(target: SiteTarget): void {
  const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
    parity: { importBatches: number }
    target: { checksum: string }
  }
  const current = query(
    target,
    `SELECT
      (SELECT checksum FROM publication_state WHERE site_id='${target.siteId}') AS checksum,
      EXISTS(SELECT 1 FROM sites WHERE id='${target.siteId}') AS site_exists`
  ) as Array<{ checksum?: string | null; site_exists?: number }>
  if (current[0]?.checksum === report.target.checksum) {
    console.log(`Local D1 already matches ${report.target.checksum}; import is a no-op.`)
    return
  }
  if (current[0]?.checksum || current[0]?.site_exists)
    throw new Error(
      'Refusing a different or partial initial catalog; restore the clean pre-import state.'
    )
  for (let index = 1; index <= report.parity.importBatches; index += 1) {
    const batchPath = `${target.artifactBatchDirectory}/${String(index).padStart(4, '0')}.sql`
    wrangler(target, ['d1', 'execute', target.local.databaseName, '--file', batchPath, '--yes'])
    console.log(`Imported D1 batch ${index}/${report.parity.importBatches}`)
  }
}

function localSqlitePath(directory: string): string {
  const matches: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        entry.isFile() &&
        entry.name.endsWith('.sqlite') &&
        entry.name !== 'metadata.sqlite'
      ) {
        matches.push(path)
      }
    }
  }
  visit(directory)
  if (matches.length !== 1) {
    throw new Error(
      `Canonical local D1 state must contain exactly one SQLite database; found ${matches.length}: ${matches.join(', ')}`
    )
  }
  return matches[0]!
}

function localSnapshotTransport(target: SiteTarget): {
  close: () => void
  transport: SnapshotTransport
} {
  const database = new DatabaseSync(localSqlitePath(statePath(target)), { readOnly: true })
  return {
    close: () => database.close(),
    transport: {
      async query(statement) {
        return database.prepare(statement.sql).all(...statement.params) as Array<
          Record<string, unknown>
        >
      }
    }
  }
}

function expectedBootstrapTransport(target: SiteTarget): {
  close: () => void
  transport: SnapshotTransport
} {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve('d1/drizzle', migration), 'utf8'))
  }
  const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
    parity: { importBatches: number }
  }
  for (let index = 1; index <= report.parity.importBatches; index += 1) {
    const batchPath = `${target.artifactBatchDirectory}/${String(index).padStart(4, '0')}.sql`
    database.exec(readFileSync(resolve(batchPath), 'utf8'))
  }
  return {
    close: () => database.close(),
    transport: {
      async query(statement) {
        return database.prepare(statement.sql).all(...statement.params) as Array<
          Record<string, unknown>
        >
      }
    }
  }
}

async function verify(target: SiteTarget): Promise<void> {
  const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
    target: { checksum: string }
  }
  const expectedDatabase = expectedBootstrapTransport(target)
  let expected
  try {
    expected = await captureApplicationSnapshot(expectedDatabase.transport)
  } finally {
    expectedDatabase.close()
  }
  const actualDatabase = localSnapshotTransport(target)
  let actual
  try {
    actual = await captureApplicationSnapshot(actualDatabase.transport)
  } finally {
    actualDatabase.close()
  }
  const mismatches = applicationTableNames.filter(
    table =>
      actual.tables[table].count !== expected.tables[table].count ||
      actual.tables[table].checksum !== expected.tables[table].checksum
  )
  if (actual.checksum !== expected.checksum || mismatches.length > 0) {
    throw new Error(
      `Local D1 exact 17-table bootstrap parity failed${mismatches.length > 0 ? `: ${mismatches.join(', ')}` : ''}.`
    )
  }
  const state = query(
    target,
    `SELECT version, checksum FROM publication_state WHERE site_id = '${target.siteId}'`
  ) as Array<{ checksum?: string; version?: number }>
  if (state[0]?.checksum !== report.target.checksum) {
    throw new Error('D1 publication checksum does not match the migration report.')
  }
  console.log(
    `Verified local D1 publication v${state[0]?.version}: exact 17-table snapshot ${actual.checksum}, checksum ${state[0]?.checksum}`
  )
}

function publish(target: SiteTarget, args: string[]): void {
  const manifestPath = args[0]
  if (!manifestPath) throw new Error('Usage: pnpm d1:local:publish -- <manifest.yaml>')
  const manifest = parse(readFileSync(resolve(manifestPath), 'utf8')) as { siteId?: string }
  if (manifest.siteId !== target.siteId)
    throw new Error(
      `Manifest site ${manifest.siteId || 'missing'} does not match ${target.siteId}.`
    )
  execFileSync('pnpm', ['tsx', 'scripts/d1-publisher.ts', manifestPath], { stdio: 'inherit' })
}

function preview(target: SiteTarget): void {
  execFileSync('pnpm', ['--filter', target.appPackageName, 'build:worker'], { stdio: 'inherit' })
  const result = spawnSync('pnpm', ['--filter', target.appPackageName, 'preview:worker'], {
    env: process.env,
    stdio: 'inherit'
  })
  if (result.status) process.exitCode = result.status
}

export async function runLocalD1Command(args: string[]): Promise<void> {
  const [command, siteFlag, siteValue, ...rest] = args
  if (siteFlag !== '--site') {
    throw new Error(
      'Local D1 commands require an explicit --site pornvideodownloaders.com|serp.software.'
    )
  }
  const target = resolveSiteTarget(siteValue)
  validateCanonicalLocalConfig(target)
  if (command === 'migrate') {
    migrate(target)
    return
  }
  if (command === 'import') {
    importArtifact(target)
    return
  }
  if (command === 'verify') {
    await verify(target)
    return
  }
  if (command === 'publish') {
    publish(target, rest)
    return
  }
  if (command === 'preview') {
    preview(target)
    return
  }
  throw new Error(`Unknown local D1 command: ${command || 'missing'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runLocalD1Command(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
