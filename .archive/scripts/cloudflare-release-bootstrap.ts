/**
 * ARCHIVED (serpcompany/best.serp.co#315): the one-time production bootstrap commands of
 * `scripts/cloudflare-release.ts` (`import` and `verify-import`, which
 * `.github/workflows/bootstrap-production-d1.yml` ran under the `bootstrap-best.serp.co-production`
 * confirmation), cut from it as they were before #315. Production has diverged from the v1
 * import, so a re-import would lose its publications, decisions, claims, payments, and media;
 * recovery is D1 Time Travel (docs/D1_RECOVERY.md). History only: not built, linted, or run; its
 * imports name the files as they were then. The release authorization it ran under was:
 *
 *   'bootstrap-production-d1.yml': {
 *     // `import` applies migrations itself, and only after proving the database is empty. It
 *     // applies every migration at this commit, so it needs the same staging proof as `migrate`.
 *     branch: 'main',
 *     commands: ['import'],
 *     confirmation: project.confirmation.bootstrap,
 *     environment: 'production',
 *     events: ['workflow_dispatch'],
 *     requireVerifiedStaging: ['import']
 *   }
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDatabase, type D1Row, type D1Target } from './cloudflare-release'
import { captureApplicationSnapshot, type SnapshotTransport } from './d1-application-snapshot'
import {
  expectedBootstrapSnapshot,
  type ImportArtifactPaths,
  type ParityReport,
  readParityReport,
  readReviewedImportSql,
  reviewedArtifactPaths,
  sha256
} from './d1-import-artifact'
import { parityTableNames, runtimeTableNames } from './d1-table-inventory-parity'
import { project, type RemoteEnvironment } from './project'

/** Inlines the integer LIMIT/OFFSET parameters snapshot pages use; Wrangler cannot bind them. */
export function inlineIntegerParameters(sql: string, params: readonly unknown[]): string {
  let index = 0
  const inlined = sql.replace(/\?/gu, () => {
    const value = params[index]
    index += 1
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error('Remote snapshot queries accept only integer parameters.')
    }
    return String(value)
  })
  if (index !== params.length) throw new Error('Remote snapshot parameter count mismatch.')
  return inlined
}

function snapshotTransport(d1: D1Target): SnapshotTransport {
  return { query: statement => d1.query(inlineIntegerParameters(statement.sql, statement.params)) }
}

function requireReviewedChecksum(report: ParityReport): string {
  const checksum = report.artifact?.sqlChecksum
  if (!checksum || !/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new Error('The parity report has no artifact.sqlChecksum; refusing an unverified import.')
  }
  return checksum
}

/** Publication and catalog rows present, tolerating a database whose tables do not exist yet. */
export async function catalogOccupancy(
  d1: D1Target
): Promise<{ catalogRows: number; checksum: string | null; publicationRows: number }> {
  const tables = await tableNames(d1)
  const count = async (table: string) =>
    tables.has(table)
      ? (integer((await d1.query(`SELECT COUNT(*) AS row_count FROM ${table}`))[0]?.row_count) ?? 0)
      : 0
  const checksum = tables.has('publication_state')
    ? (await d1.query('SELECT checksum FROM publication_state WHERE id=1'))[0]?.checksum
    : null
  return {
    catalogRows:
      (await count('categories')) + (await count('listings')) + (await count('migration_runs')),
    checksum: typeof checksum === 'string' ? checksum : null,
    publicationRows: await count('publication_state')
  }
}

/**
 * Imports the reviewed initial catalog into an empty D1: refuses any existing publication or
 * catalog rows before changing anything, applies the apps/web/drizzle migrations, re-checks, then
 * executes the checksum-verified SQL. A database that already carries the reviewed publication
 * checksum is a no-op.
 */
export async function importReviewedCatalog(
  d1: D1Target,
  environment: RemoteEnvironment,
  options: { paths?: ImportArtifactPaths; report?: ParityReport } = {}
): Promise<{ sqlChecksum: string; status: 'already-imported' | 'imported' }> {
  const report = options.report ?? readParityReport(options.paths?.parityReportPath)
  const sqlChecksum = requireReviewedChecksum(report)
  const sql = readReviewedImportSql(report, options.paths ?? reviewedArtifactPaths)
  if (sha256(sql) !== sqlChecksum) {
    throw new Error('Import SQL does not reproduce the reviewed artifact checksum.')
  }
  const refuseOccupied = (occupancy: Awaited<ReturnType<typeof catalogOccupancy>>) => {
    if (occupancy.publicationRows !== 0 || occupancy.catalogRows !== 0) {
      throw new Error(
        `Refusing to import into ${environment} D1: it already holds a publication or catalog rows. The initial import runs only into an empty database.`
      )
    }
  }
  const before = await catalogOccupancy(d1)
  if (before.checksum === report.target.checksum) {
    return { sqlChecksum, status: 'already-imported' }
  }
  refuseOccupied(before)
  d1.applyMigrations()
  const readiness = await checkDatabase(d1)
  if (readiness.missingMigrations.length > 0 || readiness.unknownMigrations.length > 0) {
    throw new Error(
      `${environment} D1 must have exactly the apps/web/drizzle migrations applied before the import.`
    )
  }
  refuseOccupied(await catalogOccupancy(d1))
  const directory = mkdtempSync(join(tmpdir(), 'best-serp-co-d1-bootstrap-'))
  try {
    const importPath = join(directory, `${project.artifact.name}.sql`)
    writeFileSync(importPath, sql)
    d1.executeFile(importPath)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
  return { sqlChecksum, status: 'imported' }
}

const parityCountsQuery = `SELECT
  (SELECT COUNT(*) FROM publication_state) AS publication_rows,
  (SELECT version FROM publication_state WHERE id=1) AS version,
  (SELECT checksum FROM publication_state WHERE id=1) AS checksum,
  (SELECT COUNT(*) FROM listings WHERE status='approved' AND is_active=1) AS listing_count,
  (SELECT COUNT(*) FROM categories WHERE is_active=1) AS category_count,
  (SELECT COUNT(*) FROM listing_categories) AS membership_count,
  (SELECT COUNT(*) FROM listing_categories WHERE is_primary=1) AS primary_category_count,
  (SELECT COUNT(*) FROM listing_faqs) AS faq_count,
  (SELECT COUNT(*) FROM listing_media) AS media_count,
  (SELECT COUNT(*) FROM listing_resource_links) AS resource_link_count,
  (SELECT COUNT(*) FROM listings WHERE is_featured=1) AS featured_count`

/** Compares the observed counts with every count the parity report declares. */
export function parityCountMismatches(row: D1Row | undefined, report: ParityReport): string[] {
  const expectations: Array<[string, unknown]> = [
    ['publication_rows', 1],
    ['checksum', report.target.checksum],
    ['version', report.target.publicationVersion],
    ['listing_count', report.target.listingCount],
    ['category_count', report.target.categoryCount],
    ['membership_count', report.parity.categoryMembershipCount],
    ['primary_category_count', report.parity.primaryCategoryCount],
    ['faq_count', report.parity.faqCount],
    ['media_count', report.parity.mediaCount],
    ['resource_link_count', report.parity.resourceLinkCount],
    ['featured_count', report.parity.featuredCount]
  ]
  return expectations
    .filter(([, expected]) => expected !== undefined)
    .filter(([key, expected]) => row?.[key] !== expected)
    .map(([key, expected]) => `${key} is ${String(row?.[key])}, expected ${String(expected)}`)
}

/** One row with the row count of every runtime table (identifiers are constants). */
const runtimeRowsQuery = `SELECT ${runtimeTableNames
  .map(table => `(SELECT count(*) FROM "${table}") AS "${table}"`)
  .join(', ')}`

/**
 * Proves the database holds exactly the reviewed initial catalog: every application table
 * matches the in-memory bootstrap of the checksum-verified SQL, and the publication checksum
 * and counts match the parity report.
 */
export async function verifyImportedCatalog(
  d1: D1Target,
  environment: RemoteEnvironment,
  options: { pageSize?: number; paths?: ImportArtifactPaths; report?: ParityReport } = {}
): Promise<Record<string, unknown>> {
  const report = options.report ?? readParityReport(options.paths?.parityReportPath)
  const sql = readReviewedImportSql(report, options.paths ?? reviewedArtifactPaths)
  if (sha256(sql) !== requireReviewedChecksum(report)) {
    throw new Error('Import SQL does not reproduce the reviewed artifact checksum.')
  }
  const [counts] = await d1.query(parityCountsQuery)
  const countMismatches = parityCountMismatches(counts, report)
  // Bootstrap parity skips the rows of the runtime tables, but at bootstrap they must hold
  // none: an import that planted a user, session, code, or delivery would otherwise go unnoticed.
  const [runtimeRows] = await d1.query(runtimeRowsQuery)
  const nonEmptyRuntimeTables = runtimeTableNames.filter(
    table => Number(runtimeRows?.[table]) !== 0
  )
  const expected = await expectedBootstrapSnapshot(sql)
  const actual = await captureApplicationSnapshot(snapshotTransport(d1), {
    pageSize: options.pageSize ?? 250
  })
  const tableMismatches = parityTableNames.filter(
    table =>
      actual.tables[table].count !== expected.tables[table].count ||
      actual.tables[table].checksum !== expected.tables[table].checksum
  )
  if (
    countMismatches.length > 0 ||
    tableMismatches.length > 0 ||
    nonEmptyRuntimeTables.length > 0 ||
    actual.checksum !== expected.checksum
  ) {
    throw new Error(
      `${environment} D1 does not match the reviewed ${project.artifact.name} import.${
        countMismatches.length > 0 ? ` Parity report: ${countMismatches.join('; ')}.` : ''
      }${tableMismatches.length > 0 ? ` Tables: ${tableMismatches.join(', ')}.` : ''}${
        nonEmptyRuntimeTables.length > 0
          ? ` Runtime tables must be empty at bootstrap: ${nonEmptyRuntimeTables.join(', ')}.`
          : ''
      }`
    )
  }
  return {
    checksum: counts?.checksum,
    environment,
    listings: counts?.listing_count,
    categories: counts?.category_count,
    snapshot: actual.checksum,
    tables: parityTableNames.length,
    totalRows: actual.totalRows,
    version: counts?.version
  }
}
