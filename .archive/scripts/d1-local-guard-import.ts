/**
 * ARCHIVED (serpcompany/best.serp.co#315): the v1 import's branches of `scripts/d1-local-guard.ts`
 * (`pnpm db:import:local`, and the import parity half of `pnpm db:verify:local`), cut from it as
 * they were before #315. History only: it is not built, linted, or run, and its imports name the
 * files as they were then (`d1-import-artifact.ts` and `d1-application-snapshot.ts` are archived
 * beside it). The live file keeps the seed-facts check.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureApplicationSnapshot } from './d1-application-snapshot'
import {
  expectedBootstrapSnapshot,
  readParityReport,
  readReviewedImportSql,
  sqliteTransport
} from './d1-import-artifact'
import { parityTableNames } from './d1-table-inventory'
import { project } from './project'

function query(command: string): unknown[] {
  const output = wrangler(
    ['d1', 'execute', project.local.databaseName, '--command', command, '--json'],
    true
  )
  const parsed = JSON.parse(output) as Array<{ results?: unknown[] }>
  return parsed[0]?.results || []
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
