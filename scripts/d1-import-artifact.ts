import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'
import { parse } from 'yaml'
import {
  type CanonicalApplicationSnapshot,
  captureApplicationSnapshot,
  type SnapshotTransport
} from './d1-application-snapshot'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { project } from './project'

/** The reviewed fields of `d1/artifacts/<name>-parity.yaml` that D1 tooling checks against. */
export interface ParityReport {
  artifact?: { batchChecksums?: string[]; sqlChecksum?: string }
  parity: {
    categoryMembershipCount?: number
    faqCount?: number
    featuredCount?: number
    importBatches: number
    mediaCount?: number
    primaryCategoryCount?: number
    resourceLinkCount?: number
  }
  target: {
    categoryCount?: number
    checksum: string
    listingCount?: number
    publicationVersion?: number
  }
}

export interface ImportArtifactPaths {
  batchDirectory: string
  compressedSqlPath: string
  parityReportPath: string
}

export const reviewedArtifactPaths: ImportArtifactPaths = {
  batchDirectory: project.artifact.batchDirectory,
  compressedSqlPath: project.artifact.compressedSqlPath,
  parityReportPath: project.artifact.parityReportPath
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function readParityReport(
  reportPath: string = reviewedArtifactPaths.parityReportPath
): ParityReport {
  if (!existsSync(resolve(reportPath))) {
    throw new Error(
      `Missing initial import parity report ${reportPath}. Generate the reviewed artifact with pnpm migration:generate first.`
    )
  }
  const report: ParityReport = parse(readFileSync(resolve(reportPath), 'utf8'))
  return report
}

function importBatchPath(batchDirectory: string, index: number): string {
  return `${batchDirectory}/${String(index).padStart(4, '0')}.sql`
}

/** Reads every reviewed import batch, refusing any batch whose bytes differ from the report. */
function readReviewedBatches(report: ParityReport, batchDirectory: string): string[] {
  const batches: string[] = []
  for (let index = 1; index <= report.parity.importBatches; index += 1) {
    const path = importBatchPath(batchDirectory, index)
    const batch = readFileSync(resolve(path), 'utf8')
    const expected = report.artifact?.batchChecksums?.[index - 1]
    if (expected && sha256(batch) !== expected) {
      throw new Error(`${path} does not match its reviewed checksum.`)
    }
    batches.push(batch)
  }
  return batches
}

/**
 * The combined import SQL, from the locally generated batches when present, otherwise from
 * the committed brotli artifact. Either way it must match the reviewed artifact checksum.
 */
export function readReviewedImportSql(
  report: ParityReport,
  paths: ImportArtifactPaths = reviewedArtifactPaths
): string {
  const combined = existsSync(resolve(importBatchPath(paths.batchDirectory, 1)))
    ? readReviewedBatches(report, paths.batchDirectory).join('\n')
    : existsSync(resolve(paths.compressedSqlPath))
      ? brotliDecompressSync(readFileSync(resolve(paths.compressedSqlPath))).toString('utf8')
      : undefined
  if (combined === undefined) {
    throw new Error(
      `Missing import SQL: neither ${paths.batchDirectory} nor ${paths.compressedSqlPath} exists. Run pnpm migration:generate.`
    )
  }
  if (report.artifact?.sqlChecksum && sha256(combined) !== report.artifact.sqlChecksum) {
    throw new Error('Import SQL does not reproduce the reviewed artifact checksum.')
  }
  return combined
}

export function sqliteTransport(database: DatabaseSync): SnapshotTransport {
  return {
    async query(statement) {
      // Snapshot statements bind only the integer page bounds they build themselves.
      return database.prepare(statement.sql).all(...(statement.params as SQLInputValue[]))
    }
  }
}

/**
 * The exact application snapshot a fresh database reaches after every `d1/drizzle` migration
 * and the reviewed import SQL, built in memory.
 */
export async function expectedBootstrapSnapshot(
  importSql: string
): Promise<CanonicalApplicationSnapshot> {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA foreign_keys = ON')
    for (const migration of freshMigrationNames()) {
      database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    }
    database.exec(importSql)
    return await captureApplicationSnapshot(sqliteTransport(database))
  } finally {
    database.close()
  }
}
