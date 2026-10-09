import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { captureApplicationSnapshot } from './d1-application-snapshot'
import {
  expectedBootstrapSnapshot,
  readParityReport,
  readReviewedImportSql,
  sqliteTransport
} from './d1-import-artifact'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { runCanonicalPreview } from './d1-local-preview'
import {
  assertLocalSeedTarget,
  isSeeded,
  resetLocalState,
  type SeedQuery,
  seedFactViolations,
  seedLocalFixtures
} from './d1-local-seed'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { parityTableNames } from './d1-table-inventory'
import { project } from './project'

function wrangler(args: string[], capture = false): string {
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
          configuredFreshD1StateRoot(),
          '--config',
          project.wranglerConfigPath
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

function query(command: string): unknown[] {
  const output = wrangler(
    ['d1', 'execute', project.local.databaseName, '--command', command, '--json'],
    true
  )
  const parsed = JSON.parse(output) as Array<{ results?: unknown[] }>
  return parsed[0]?.results || []
}

/** `pnpm db:migrations:list:local`: the apps/web/drizzle migrations local D1 has not applied yet. */
function listMigrations(): void {
  wrangler(['d1', 'migrations', 'list', project.local.databaseName])
}

function migrate(): void {
  wrangler(['d1', 'migrations', 'apply', project.local.databaseName])
}

function importArtifact(): void {
  const report = readParityReport()
  const current = query(
    `SELECT
      (SELECT checksum FROM publication_state WHERE id=1) AS checksum,
      (SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM listings) AS catalog_rows`
  ) as Array<{ catalog_rows?: number; checksum?: string | null }>
  if (current[0]?.checksum === report.target.checksum) {
    console.log(`Local D1 already matches ${report.target.checksum}; import is a no-op.`)
    return
  }
  if (current[0]?.checksum || current[0]?.catalog_rows)
    throw new Error(
      'Refusing a different or partial initial catalog; restore the clean pre-import state.'
    )
  const combined = readReviewedImportSql(report)
  // Local D1 applies the checksum-verified SQL in one execution instead of one Wrangler
  // start-up per batch.
  const directory = mkdtempSync(join(tmpdir(), 'best-serp-co-d1-import-'))
  try {
    const importPath = join(directory, 'import.sql')
    writeFileSync(importPath, combined)
    wrangler(['d1', 'execute', project.local.databaseName, '--file', importPath, '--yes'], true)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
  console.log(`Imported the reviewed initial catalog into local ${project.domain}.`)
}

/** Miniflare's D1 storage directory; its Cache API, KV, and R2 SQLite files live elsewhere. */
const D1_OBJECT_DIRECTORY = 'miniflare-D1DatabaseObject'

/**
 * The one D1 database file below `directory`. Only D1's own storage counts: a Worker preview also
 * persists Cache API (and other) SQLite files under the same state directory (#81).
 */
export function localSqlitePath(directory: string): string {
  const matches: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        entry.isFile() &&
        entry.name.endsWith('.sqlite') &&
        entry.name !== 'metadata.sqlite' &&
        basename(current) === D1_OBJECT_DIRECTORY
      ) {
        matches.push(path)
      }
    }
  }
  visit(directory)
  if (matches.length !== 1) {
    throw new Error(
      `Canonical local D1 state must contain exactly one SQLite database; found ${matches.length}: ${matches.join(', ')}. ` +
        `If the local database_id changed (#176), run pnpm db:seed:local, which deletes ${directory} and seeds it again.`
    )
  }
  return matches[0]
}

function localSnapshotDatabase(): DatabaseSync {
  return new DatabaseSync(localSqlitePath(configuredFreshD1StateRoot()), { readOnly: true })
}

function sqliteQuery(database: DatabaseSync): SeedQuery {
  return (sql, params = []) =>
    database.prepare(sql).all(...params) as Array<Record<string, unknown>>
}

/**
 * `pnpm db:verify:local`: a seeded local D1 (`pnpm db:seed:local`) is checked against the seed's
 * facts; an imported one (`pnpm db:import:local`) against the import's exact parity.
 */
async function verify(): Promise<void> {
  const database = localSnapshotDatabase()
  try {
    const query = sqliteQuery(database)
    if (isSeeded(query)) {
      const violations = seedFactViolations(query, { marker: true, media: true })
      if (violations.length > 0) {
        throw new Error(
          `Local D1 no longer matches the fixture seed; pnpm db:seed:local resets it.\n${violations.join('\n')}`
        )
      }
      console.log('Verified local D1 against the fixture seed facts.')
      return
    }
  } finally {
    database.close()
  }
  await verifyImport()
}

async function verifyImport(): Promise<void> {
  const report = readParityReport()
  const expected = await expectedBootstrapSnapshot(readReviewedImportSql(report))
  const actualDatabase = localSnapshotDatabase()
  let actual: Awaited<ReturnType<typeof captureApplicationSnapshot>>
  try {
    actual = await captureApplicationSnapshot(sqliteTransport(actualDatabase))
  } finally {
    actualDatabase.close()
  }
  const mismatches = parityTableNames.filter(
    table =>
      actual.tables[table].count !== expected.tables[table].count ||
      actual.tables[table].checksum !== expected.tables[table].checksum
  )
  if (actual.checksum !== expected.checksum || mismatches.length > 0) {
    throw new Error(
      `Local D1 exact ${parityTableNames.length}-table bootstrap parity failed${mismatches.length > 0 ? `: ${mismatches.join(', ')}` : ''}.`
    )
  }
  const state = query('SELECT version, checksum FROM publication_state WHERE id=1') as Array<{
    checksum?: string
    version?: number
  }>
  if (state[0]?.checksum !== report.target.checksum) {
    throw new Error('D1 publication checksum does not match the migration report.')
  }
  console.log(
    `Verified local D1 publication v${state[0]?.version}: exact ${parityTableNames.length}-table snapshot ${actual.checksum}, checksum ${state[0]?.checksum}`
  )
}

function publish(args: string[]): void {
  const manifestPath = args[0]
  if (!manifestPath || args.length > 1)
    throw new Error('Usage: pnpm db:publish:local -- <manifest.yaml>')
  execFileSync('pnpm', ['tsx', 'scripts/d1-publisher.ts', manifestPath], { stdio: 'inherit' })
}

/** `pnpm db:seed:local`: reset the local state, apply the migrations, and seed fixtures. */
async function seed(): Promise<void> {
  assertLocalSeedTarget()
  resetLocalState(configuredFreshD1StateRoot())
  migrate()
  await seedLocalFixtures()
}

function preview(): void {
  execFileSync('pnpm', ['--filter', project.appPackageName, 'build:worker'], {
    stdio: 'inherit'
  })
  runCanonicalPreview()
}

export async function runLocalD1Command(args: string[]): Promise<void> {
  const [command, ...rest] = args.filter(value => value !== '--')
  if (rest[0] === '--site') {
    throw new Error(
      `Local D1 commands no longer take --site; this repository targets only ${project.domain}.`
    )
  }
  validateCanonicalLocalConfig()
  if (command === 'publish') {
    publish(rest)
    return
  }
  if (rest.length > 0) throw new Error(`Unexpected arguments: ${rest.join(' ')}.`)
  if (command === 'list') {
    listMigrations()
    return
  }
  if (command === 'migrate') {
    migrate()
    return
  }
  if (command === 'import') {
    importArtifact()
    return
  }
  if (command === 'verify') {
    await verify()
    return
  }
  if (command === 'seed') {
    await seed()
    return
  }
  if (command === 'preview') {
    preview()
    return
  }
  throw new Error(
    `Unknown local D1 command: ${command || 'missing'}. Use list, migrate, seed, import, verify, publish, or preview.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runLocalD1Command(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
