import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { captureApplicationSnapshot, type SnapshotTransport } from './d1-application-snapshot'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { runCanonicalPreview } from './d1-local-preview'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { applicationTableNames } from './d1-table-inventory'
import { project } from './project'

interface ParityReport {
  artifact?: { batchChecksums?: string[]; sqlChecksum?: string }
  parity: { importBatches: number }
  target: { checksum: string }
}

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

function readParityReport(): ParityReport {
  const reportPath = resolve(project.artifact.parityReportPath)
  if (!existsSync(reportPath)) {
    throw new Error(
      `Missing initial import parity report ${project.artifact.parityReportPath}. Generate the reviewed artifact with pnpm migration:generate first.`
    )
  }
  return parse(readFileSync(reportPath, 'utf8')) as ParityReport
}

function importBatchPath(index: number): string {
  return `${project.artifact.batchDirectory}/${String(index).padStart(4, '0')}.sql`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Reads every reviewed import batch, refusing any batch whose bytes differ from the report. */
function readReviewedBatches(report: ParityReport): string[] {
  const batches: string[] = []
  for (let index = 1; index <= report.parity.importBatches; index += 1) {
    const batch = readFileSync(resolve(importBatchPath(index)), 'utf8')
    const expected = report.artifact?.batchChecksums?.[index - 1]
    if (expected && sha256(batch) !== expected) {
      throw new Error(`${importBatchPath(index)} does not match its reviewed checksum.`)
    }
    batches.push(batch)
  }
  return batches
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
  const batches = readReviewedBatches(report)
  const combined = batches.join('\n')
  if (report.artifact?.sqlChecksum && sha256(combined) !== report.artifact.sqlChecksum) {
    throw new Error('Reviewed import batches do not reproduce the reviewed artifact checksum.')
  }
  // The batches exist for remote D1 request limits. Local D1 applies the identical,
  // checksum-verified SQL in one execution instead of one Wrangler start-up per batch.
  const directory = mkdtempSync(join(tmpdir(), 'best-serp-co-d1-import-'))
  try {
    const importPath = join(directory, 'import.sql')
    writeFileSync(importPath, combined)
    wrangler(['d1', 'execute', project.local.databaseName, '--file', importPath, '--yes'], true)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
  console.log(`Imported ${batches.length} reviewed D1 batches into local ${project.domain}.`)
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

function databaseTransport(database: DatabaseSync): {
  close: () => void
  transport: SnapshotTransport
} {
  return {
    close: () => database.close(),
    transport: {
      async query(statement) {
        return database
          .prepare(statement.sql)
          .all(...(statement.params as SQLInputValue[])) as Array<Record<string, unknown>>
      }
    }
  }
}

function localSnapshotTransport() {
  return databaseTransport(
    new DatabaseSync(localSqlitePath(configuredFreshD1StateRoot()), { readOnly: true })
  )
}

function expectedBootstrapTransport(report: ParityReport) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  for (const batch of readReviewedBatches(report)) database.exec(batch)
  return databaseTransport(database)
}

async function verify(): Promise<void> {
  const report = readParityReport()
  const expectedDatabase = expectedBootstrapTransport(report)
  let expected
  try {
    expected = await captureApplicationSnapshot(expectedDatabase.transport)
  } finally {
    expectedDatabase.close()
  }
  const actualDatabase = localSnapshotTransport()
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
      `Local D1 exact ${applicationTableNames.length}-table bootstrap parity failed${mismatches.length > 0 ? `: ${mismatches.join(', ')}` : ''}.`
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
    `Verified local D1 publication v${state[0]?.version}: exact ${applicationTableNames.length}-table snapshot ${actual.checksum}, checksum ${state[0]?.checksum}`
  )
}

function publish(args: string[]): void {
  const manifestPath = args[0]
  if (!manifestPath || args.length > 1)
    throw new Error('Usage: pnpm d1:local:publish -- <manifest.yaml>')
  execFileSync('pnpm', ['tsx', 'scripts/d1-publisher.ts', manifestPath], { stdio: 'inherit' })
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
  if (command === 'preview') {
    preview()
    return
  }
  throw new Error(
    `Unknown local D1 command: ${command || 'missing'}. Use migrate, import, verify, publish, or preview.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runLocalD1Command(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
