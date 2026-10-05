/**
 * Protected Cloudflare release operations for best.serp.co: remote D1 backup, migrations,
 * the one-time catalog bootstrap and its verification, database readiness, and Worker deploy.
 *
 *   pnpm tsx scripts/cloudflare-release.ts <command> <staging|production> [options]
 *
 * Commands:
 *   list-migrations read-only: applied, pending, and unknown migrations in the D1 ledger
 *                   (`pnpm db:migrations:list:<env>`)
 *   plan-release    read-only: `database-and-worker` when migrations are pending, otherwise
 *                   `worker-only`; refuses a database with migrations this commit lacks
 *   check-database  read-only: every d1/drizzle migration is applied and a publication exists
 *   verify-import   read-only: exact 16-table parity with the reviewed import and parity report
 *   backup          `wrangler d1 export` to --output <file>
 *   migrate         `wrangler d1 migrations apply` (`pnpm db:migrate:<env>`)
 *   import          one-time bootstrap of an empty D1: refuse existing data, migrate, then
 *                   import the checksum-verified reviewed SQL
 *   deploy          check-database, then `opennextjs-cloudflare deploy` of the built Worker
 *
 * Mutating commands run only inside the protected workflow that owns them
 * (`releaseAuthorizations`): from that workflow file on its own branch (`staging` for staging,
 * `main` for production), for one of its events, from a clean checkout at GITHUB_SHA, and, on
 * a manual dispatch, with its typed confirmation in RELEASE_CONFIRM. A push carries no
 * confirmation; the production environment's required reviewers approve it. Production
 * migrations, the bootstrap import, and Worker deploys also require Deploy Staging to have
 * verified the same source tree on `staging` (`staging-verification.ts`, GITHUB_TOKEN with
 * actions: read and contents: read), except for an owner-approved hotfix dispatch of a merged
 * `hotfix-*` pull request, which may deploy the Worker but never migrate. They, and
 * `plan-release` inside the release workflow (before any backup), also refuse a stale
 * release: `main` must still point at GITHUB_SHA or a commit with its tree.
 * Wrangler authenticates with CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID. `--rehearse <directory>` runs the D1 commands except backup with
 * `--local --persist-to <directory>` instead of `--remote`; it never contacts Cloudflare.
 *
 * `list-migrations` reads the ledger with a SELECT instead of `wrangler d1 migrations list`,
 * because Wrangler's list first runs `CREATE TABLE IF NOT EXISTS` on the ledger table.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureApplicationSnapshot, type SnapshotTransport } from './d1-application-snapshot'
import { freshMigrationNames } from './d1-drizzle-local'
import {
  expectedBootstrapSnapshot,
  type ImportArtifactPaths,
  type ParityReport,
  readParityReport,
  readReviewedImportSql,
  reviewedArtifactPaths,
  sha256
} from './d1-import-artifact'
import { applicationTableNames } from './d1-table-inventory'
import { project, type RemoteEnvironment } from './project'
import {
  assertCurrentRelease,
  assertHotfixMerge,
  assertStagingVerified,
  type FetchLike,
  type StagingVerification
} from './staging-verification'

export const releaseCommands = [
  'backup',
  'check-database',
  'deploy',
  'import',
  'list-migrations',
  'migrate',
  'plan-release',
  'verify-import'
] as const
export type ReleaseCommand = (typeof releaseCommands)[number]

export const readOnlyCommands: ReadonlySet<ReleaseCommand> = new Set([
  'check-database',
  'list-migrations',
  'plan-release',
  'verify-import'
])

/** Workflow events that may run remote release commands. */
export type ReleaseEvent = 'push' | 'workflow_dispatch'

export interface ReleaseAuthorization {
  /** The branch the workflow file and GITHUB_REF must both come from. */
  branch: 'main' | 'staging'
  commands: readonly ReleaseCommand[]
  /** Typed confirmation a manual dispatch must carry in RELEASE_CONFIRM; null for none. */
  confirmation: string | null
  environment: RemoteEnvironment
  /**
   * Events that may run the commands. A push carries no typed confirmation: it is a reviewed
   * merge or promotion, and production's environment reviewers approve the job.
   */
  events: readonly ReleaseEvent[]
  /**
   * A second dispatch confirmation for an owner-approved hotfix already on `main`: it skips the
   * staging check for `deploy`, and refuses every other staging-gated command.
   */
  hotfixConfirmation?: string
  /**
   * Commands that ship schema or code and therefore also require Deploy Staging to have verified
   * the same source tree (staging before production).
   */
  requireVerifiedStaging: readonly ReleaseCommand[]
}

/** The only workflows that may mutate a remote environment, and what each may do. */
export const releaseAuthorizations: Readonly<Record<string, ReleaseAuthorization>> = {
  'deploy-staging.yml': {
    branch: 'staging',
    commands: ['migrate', 'deploy'],
    confirmation: null,
    environment: 'staging',
    events: ['push', 'workflow_dispatch'],
    requireVerifiedStaging: []
  },
  'deploy-production.yml': {
    branch: 'main',
    commands: ['backup', 'migrate', 'deploy'],
    confirmation: project.confirmation.deploy,
    environment: 'production',
    events: ['push', 'workflow_dispatch'],
    hotfixConfirmation: project.confirmation.hotfix,
    requireVerifiedStaging: ['migrate', 'deploy']
  },
  'bootstrap-production-d1.yml': {
    // `import` applies migrations itself, and only after proving the database is empty. It
    // applies every migration at this commit, so it needs the same staging proof as `migrate`.
    branch: 'main',
    commands: ['import'],
    confirmation: project.confirmation.bootstrap,
    environment: 'production',
    events: ['workflow_dispatch'],
    requireVerifiedStaging: ['import']
  },
  'publish-d1.yml': {
    // A reviewed data change to production, not a schema or code release.
    branch: 'main',
    commands: ['backup'],
    confirmation: project.confirmation.publish,
    environment: 'production',
    events: ['workflow_dispatch'],
    requireVerifiedStaging: []
  },
  'approve-d1-submission.yml': {
    branch: 'main',
    commands: ['backup'],
    confirmation: project.confirmation.submission,
    environment: 'production',
    events: ['workflow_dispatch'],
    requireVerifiedStaging: []
  }
}

export type D1Location = { kind: 'remote' } | { kind: 'rehearsal'; persistTo: string }

export interface ProcessRunner {
  /** Runs a command from the repository root; returns captured stdout or throws on failure. */
  run(command: string, args: string[], options: { capture: boolean }): string
}

export type D1Row = Record<string, unknown>

/** The D1 operations release commands need; Wrangler-backed in production, SQLite in tests. */
export interface D1Target {
  applyMigrations(): void
  executeFile(path: string): void
  exportTo(path: string): void
  query(sql: string): Promise<D1Row[]>
}

export interface DatabaseReadiness {
  appliedMigrations: string[]
  missingMigrations: string[]
  publication: { checksum: string | null; rows: number; version: number | null }
  unknownMigrations: string[]
}

interface WranglerEnvironmentConfig {
  d1_databases?: Array<{
    binding?: string
    database_id?: string
    database_name?: string
    migrations_dir?: string
    migrations_table?: string
  }>
  name?: string
  vars?: Record<string, string | undefined>
  workers_dev?: boolean
}

function parseEnvironment(value: string | undefined): RemoteEnvironment {
  if (value === 'staging' || value === 'production') return value
  throw new Error('Release environment must be exactly staging or production.')
}

function parseCommand(value: string | undefined): ReleaseCommand {
  const command = releaseCommands.find(candidate => candidate === value)
  if (command) return command
  throw new Error(`Release command must be one of: ${releaseCommands.join(', ')}.`)
}

/**
 * Refuses a Wrangler config whose `env.<environment>` block no longer matches the reviewed
 * remote identity in `project.ts` (Worker name, workers.dev exposure, D1 binding, migration
 * history and ledger table, runtime env).
 */
export function validateRemoteConfig(
  environment: RemoteEnvironment,
  configPath: string = project.wranglerConfigPath
): void {
  const expected = project.remote[environment]
  const config: { env?: Record<string, WranglerEnvironmentConfig> } = JSON.parse(
    readFileSync(resolve(configPath), 'utf8')
  )
  const block = config.env?.[environment]
  const binding = block?.d1_databases?.find(candidate => candidate.binding === 'DB')
  const problems: string[] = []
  if (!block) problems.push(`env.${environment} is missing`)
  if (block?.name !== expected.workerName) problems.push(`name must be ${expected.workerName}`)
  if (block?.workers_dev !== expected.workersDev)
    problems.push(`workers_dev must be ${expected.workersDev}`)
  if (block?.vars?.D1_RUNTIME_ENV !== environment)
    problems.push(`vars.D1_RUNTIME_ENV must be ${environment}`)
  if (
    binding?.database_name !== expected.databaseName ||
    binding.database_id !== expected.databaseId
  )
    problems.push(`the DB binding must be ${expected.databaseName} (${expected.databaseId})`)
  if (
    !binding?.migrations_dir ||
    resolve(dirname(resolve(configPath)), binding.migrations_dir) !== resolve('d1/drizzle')
  )
    problems.push('the DB binding must apply d1/drizzle migrations')
  if (binding?.migrations_table !== project.migrationsTable)
    problems.push(`the DB binding must declare migrations_table ${project.migrationsTable}`)
  if (problems.length > 0) {
    throw new Error(
      `${configPath} env.${environment} does not match the reviewed ${environment} identity in scripts/project.ts: ${problems.join('; ')}.`
    )
  }
}

/**
 * The protected workflow running this process: its file must be one of
 * `releaseAuthorizations`, loaded from that authorization's own branch of this repository.
 */
function protectedWorkflow(
  workflowRef: string | undefined
): { authorization: ReleaseAuthorization; file: string } | undefined {
  const prefix = `${project.repository}/.github/workflows/`
  if (!workflowRef?.startsWith(prefix)) return undefined
  const separator = workflowRef.indexOf('@', prefix.length)
  if (separator < 0) return undefined
  const file = workflowRef.slice(prefix.length, separator)
  const authorization = Object.hasOwn(releaseAuthorizations, file)
    ? releaseAuthorizations[file]
    : undefined
  if (!authorization || workflowRef.slice(separator + 1) !== `refs/heads/${authorization.branch}`)
    return undefined
  return { authorization, file }
}

/** An owner-approved hotfix: a dispatch carrying the workflow's hotfix confirmation. */
export function isHotfixRelease(
  authorization: ReleaseAuthorization,
  env: NodeJS.ProcessEnv
): boolean {
  return (
    authorization.hotfixConfirmation !== undefined &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.RELEASE_CONFIRM === authorization.hotfixConfirmation
  )
}

/**
 * Staging before production: when the owning workflow requires it for this command, resolves
 * only if Deploy Staging verified the tree of GITHUB_SHA on `staging`, or, for an owner-approved
 * hotfix `deploy`, only if GITHUB_SHA is the merge commit of a `hotfix-*` pull request into
 * main (`'hotfix'`; anything else under the hotfix confirmation is refused). Either way the
 * release must still be current: the workflow's branch points at GITHUB_SHA or its tree. Call
 * after `authorizeRelease`.
 */
export async function requireVerifiedStaging(
  command: ReleaseCommand,
  env: NodeJS.ProcessEnv,
  fetch?: FetchLike
): Promise<StagingVerification | 'hotfix' | null> {
  if (readOnlyCommands.has(command)) return null
  const authorization = protectedWorkflow(env.GITHUB_WORKFLOW_REF)?.authorization
  if (!authorization) {
    throw new Error(`Remote ${command} runs only inside a protected release workflow.`)
  }
  if (!authorization.requireVerifiedStaging.includes(command)) return null
  const github = {
    apiUrl: env.GITHUB_API_URL,
    fetch,
    sha: env.GITHUB_SHA,
    token: env.GITHUB_TOKEN
  }
  let proof: StagingVerification | 'hotfix'
  if (isHotfixRelease(authorization, env)) {
    if (command !== 'deploy') {
      throw new Error(
        `A hotfix release skips staging, so it may only deploy the Worker, never ${command}. Land the change through staging and promote it (docs/RELEASE_GUARDS.md#hotfixes).`
      )
    }
    await assertHotfixMerge(github)
    proof = 'hotfix'
  } else {
    proof = await assertStagingVerified(github)
  }
  await assertCurrentRelease({ ...github, branch: authorization.branch })
  return proof
}

/**
 * Throws unless a mutating command runs from its owning protected workflow, on that workflow's
 * branch and events, with its confirmation on a dispatch, at a clean GITHUB_SHA.
 */
export function authorizeRelease(
  command: ReleaseCommand,
  environment: RemoteEnvironment,
  env: NodeJS.ProcessEnv,
  git: (args: string[]) => string
): void {
  if (readOnlyCommands.has(command)) return
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      `Remote ${command} runs only inside a protected GitHub Actions workflow. Use --rehearse <directory> to exercise it against an isolated local D1.`
    )
  }
  const running = protectedWorkflow(env.GITHUB_WORKFLOW_REF)
  if (!running) {
    throw new Error(
      `${env.GITHUB_WORKFLOW_REF || 'This workflow'} is not a protected ${project.repository} release workflow on its release branch.`
    )
  }
  const { authorization, file: workflow } = running
  if (authorization.environment !== environment) {
    throw new Error(`${workflow} may not change ${environment}.`)
  }
  if (!authorization.commands.includes(command)) {
    throw new Error(`${workflow} may not run ${command}.`)
  }
  if (env.GITHUB_REF !== `refs/heads/${authorization.branch}` || !env.GITHUB_SHA) {
    throw new Error(
      `Remote release commands from ${workflow} require reviewed ${authorization.branch}.`
    )
  }
  const event = authorization.events.find(candidate => candidate === env.GITHUB_EVENT_NAME)
  if (!event) {
    throw new Error(
      `${workflow} runs remote commands only on ${authorization.events.join(' or ')}, not ${env.GITHUB_EVENT_NAME || 'an unknown event'}.`
    )
  }
  if (
    event === 'workflow_dispatch' &&
    authorization.confirmation &&
    env.RELEASE_CONFIRM !== authorization.confirmation &&
    !isHotfixRelease(authorization, env)
  ) {
    throw new Error(
      `Explicit ${environment} confirmation ${authorization.confirmation}${
        authorization.hotfixConfirmation
          ? ` (or ${authorization.hotfixConfirmation} for an owner-approved hotfix)`
          : ''
      } is required in RELEASE_CONFIRM.`
    )
  }
  if (git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('Remote release commands require a clean checkout of the reviewed commit.')
  }
  if (git(['rev-parse', 'HEAD']).trim() !== env.GITHUB_SHA) {
    throw new Error('The checked-out HEAD must equal GITHUB_SHA.')
  }
}

function isSuccessfulResult(value: unknown): value is { results: D1Row[]; success: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'results' in value &&
    Array.isArray(value.results)
  )
}

/** Parses `wrangler d1 execute --json` output, refusing any unsuccessful statement. */
export function parseWranglerRows(output: string): D1Row[] {
  const payload: unknown = JSON.parse(output)
  if (!Array.isArray(payload) || payload.length === 0 || !payload.every(isSuccessfulResult)) {
    throw new Error('D1 returned an unsuccessful or malformed result.')
  }
  return payload.flatMap(result => result.results)
}

export function wranglerD1(
  environment: RemoteEnvironment,
  location: D1Location,
  runner: ProcessRunner
): D1Target {
  const databaseName = project.remote[environment].databaseName
  const target =
    location.kind === 'remote' ? ['--remote'] : ['--local', '--persist-to', location.persistTo]
  const d1 = (subcommand: string[], trailing: string[], capture: boolean) =>
    runner.run(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        ...subcommand,
        databaseName,
        ...target,
        '--env',
        environment,
        '--config',
        project.wranglerConfigPath,
        ...trailing
      ],
      { capture }
    )
  return {
    applyMigrations: () => void d1(['migrations', 'apply'], [], false),
    executeFile: path => void d1(['execute'], ['--file', path, '--yes'], false),
    exportTo: path => void d1(['export'], ['--output', path, '--skip-confirmation'], false),
    query: async sql => parseWranglerRows(d1(['execute'], ['--command', sql, '--json'], true))
  }
}

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

async function tableNames(d1: D1Target): Promise<Set<string>> {
  const rows = await d1.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  )
  return new Set(rows.map(row => String(row.name)))
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export interface MigrationLedger {
  appliedMigrations: string[]
  missingMigrations: string[]
  unknownMigrations: string[]
}

/** Compares the D1 migration ledger with d1/drizzle using SELECTs only. */
export async function readMigrationLedger(
  d1: D1Target,
  tables?: Set<string>
): Promise<MigrationLedger> {
  const present = tables ?? (await tableNames(d1))
  const appliedMigrations = present.has(project.migrationsTable)
    ? (await d1.query(`SELECT name FROM ${project.migrationsTable} ORDER BY name`)).map(row =>
        String(row.name)
      )
    : []
  const required = freshMigrationNames()
  return {
    appliedMigrations,
    missingMigrations: required.filter(name => !appliedMigrations.includes(name)),
    unknownMigrations: appliedMigrations.filter(name => !required.includes(name))
  }
}

export async function checkDatabase(d1: D1Target): Promise<DatabaseReadiness> {
  const tables = await tableNames(d1)
  const ledger = await readMigrationLedger(d1, tables)
  const publication = tables.has('publication_state')
    ? (
        await d1.query(
          'SELECT COUNT(*) AS rows, MAX(version) AS version, MAX(checksum) AS checksum FROM publication_state'
        )
      )[0]
    : undefined
  return {
    ...ledger,
    publication: {
      checksum: typeof publication?.checksum === 'string' ? publication.checksum : null,
      rows: integer(publication?.rows) ?? 0,
      version: integer(publication?.version)
    }
  }
}

/** The Worker at this commit may serve only a fully migrated, bootstrapped database. */
export function assertDatabaseReady(
  readiness: DatabaseReadiness,
  environment: RemoteEnvironment
): void {
  if (readiness.unknownMigrations.length > 0) {
    throw new Error(
      `${environment} D1 has migrations this commit does not contain (${readiness.unknownMigrations.join(', ')}); refusing to deploy older code over a newer schema.`
    )
  }
  if (readiness.missingMigrations.length > 0) {
    throw new Error(
      `${environment} D1 is missing migrations ${readiness.missingMigrations.join(', ')}. ${
        environment === 'production'
          ? 'Re-run Deploy Production: plan-release then chooses database-and-worker and applies them first.'
          : 'Apply migrations before deploying.'
      }`
    )
  }
  if (readiness.publication.rows !== 1) {
    throw new Error(
      `${environment} D1 has no catalog publication. ${
        environment === 'production'
          ? 'Run the bootstrap-production-d1.yml workflow first.'
          : 'Import the reviewed catalog first.'
      }`
    )
  }
}

export interface ReleasePlan {
  mode: 'database-and-worker' | 'worker-only'
  pendingMigrations: string[]
}

/**
 * How a release ships: back up and migrate first when migrations are pending, otherwise deploy
 * the Worker only. Refuses, before any backup or migration starts, a database that carries
 * migrations this commit lacks (which `deploy` would refuse anyway) and a hotfix with pending
 * migrations (which `migrate` would refuse after the backup).
 */
export function planRelease(
  ledger: MigrationLedger,
  environment: RemoteEnvironment,
  options: { hotfix?: boolean } = {}
): ReleasePlan {
  if (ledger.unknownMigrations.length > 0) {
    throw new Error(
      `${environment} D1 has migrations this commit does not contain (${ledger.unknownMigrations.join(', ')}); refusing to release older code over a newer schema.`
    )
  }
  if (options.hotfix && ledger.missingMigrations.length > 0) {
    throw new Error(
      `A hotfix release may not migrate, and ${environment} D1 is missing ${ledger.missingMigrations.join(', ')}. Land the migration through staging and promote it (docs/RELEASE_GUARDS.md#hotfixes).`
    )
  }
  return {
    mode: ledger.missingMigrations.length > 0 ? 'database-and-worker' : 'worker-only',
    pendingMigrations: ledger.missingMigrations
  }
}

export async function backupDatabase(
  d1: D1Target,
  environment: RemoteEnvironment,
  outputPath: string
): Promise<{ bytes: number; empty: boolean; output: string; sha256: string }> {
  const output = resolve(outputPath)
  mkdirSync(dirname(output), { recursive: true })
  const empty = (await tableNames(d1)).size === 0
  if (empty) {
    // An export of a database with no tables has nothing to restore; record that explicitly.
    writeFileSync(
      output,
      `-- ${project.remote[environment].databaseName} had no tables at backup time.\n`
    )
  } else {
    d1.exportTo(output)
  }
  const contents = readFileSync(output)
  return {
    bytes: contents.byteLength,
    empty,
    output,
    sha256: sha256(contents.toString('utf8'))
  }
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
 * catalog rows before changing anything, applies the d1/drizzle migrations, re-checks, then
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
      `${environment} D1 must have exactly the d1/drizzle migrations applied before the import.`
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
  const expected = await expectedBootstrapSnapshot(sql)
  const actual = await captureApplicationSnapshot(snapshotTransport(d1), {
    pageSize: options.pageSize ?? 250
  })
  const tableMismatches = applicationTableNames.filter(
    table =>
      actual.tables[table].count !== expected.tables[table].count ||
      actual.tables[table].checksum !== expected.tables[table].checksum
  )
  if (
    countMismatches.length > 0 ||
    tableMismatches.length > 0 ||
    actual.checksum !== expected.checksum
  ) {
    throw new Error(
      `${environment} D1 does not match the reviewed ${project.artifact.name} import.${
        countMismatches.length > 0 ? ` Parity report: ${countMismatches.join('; ')}.` : ''
      }${tableMismatches.length > 0 ? ` Tables: ${tableMismatches.join(', ')}.` : ''}`
    )
  }
  return {
    checksum: counts?.checksum,
    environment,
    listings: counts?.listing_count,
    categories: counts?.category_count,
    snapshot: actual.checksum,
    tables: applicationTableNames.length,
    totalRows: actual.totalRows,
    version: counts?.version
  }
}

export async function deployWorker(
  d1: D1Target,
  environment: RemoteEnvironment,
  runner: ProcessRunner,
  workerEntrypoint: string = resolve(project.appDirectory, '.open-next', 'worker.js')
): Promise<void> {
  if (!existsSync(workerEntrypoint)) {
    throw new Error(`Missing ${workerEntrypoint}. Run pnpm worker:build before deploying.`)
  }
  assertDatabaseReady(await checkDatabase(d1), environment)
  runner.run(
    'pnpm',
    [
      '--filter',
      project.appPackageName,
      'exec',
      'opennextjs-cloudflare',
      'deploy',
      '--env',
      environment
    ],
    { capture: false }
  )
}

export interface ReleaseArguments {
  command: ReleaseCommand
  environment: RemoteEnvironment
  output?: string
  rehearse?: string
}

export function parseReleaseArguments(argv: string[]): ReleaseArguments {
  const [commandValue, environmentValue, ...rest] = argv.filter(value => value !== '--')
  const parsed: ReleaseArguments = {
    command: parseCommand(commandValue),
    environment: parseEnvironment(environmentValue)
  }
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if ((flag !== '--output' && flag !== '--rehearse') || !value || value.startsWith('--')) {
      throw new Error(
        'Usage: cloudflare-release.ts <command> <staging|production> [--output <file>] [--rehearse <directory>]'
      )
    }
    if (flag === '--output') parsed.output = value
    else parsed.rehearse = value
  }
  if (parsed.command === 'backup' && !parsed.output) {
    throw new Error('backup requires --output <file>.')
  }
  if (parsed.rehearse !== undefined) {
    if (!isAbsolute(parsed.rehearse)) throw new Error('--rehearse requires an absolute directory.')
    // `wrangler d1 export` cannot read a --persist-to state, and deploy always reaches Cloudflare.
    if (parsed.command === 'deploy' || parsed.command === 'backup')
      throw new Error(`${parsed.command} cannot be rehearsed locally.`)
  }
  return parsed
}

const processRunner: ProcessRunner = {
  run(command, args, { capture }) {
    try {
      return (
        execFileSync(command, args, {
          encoding: 'utf8',
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
          maxBuffer: 256 * 1024 * 1024,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        }) || ''
      )
    } catch (error) {
      const detail =
        typeof error === 'object' && error !== null
          ? [Reflect.get(error, 'stdout'), Reflect.get(error, 'stderr')]
              .map(value => String(value ?? '').trim())
              .filter(Boolean)
          : []
      if (capture && detail.length > 0) throw new Error(detail.join('\n'))
      throw error
    }
  }
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' })
}

/** External effects `runRelease` uses; tests replace them to observe the guard order. */
export interface ReleaseDependencies {
  /** GitHub Actions API client for the staging-before-production check. */
  fetch?: FetchLike
  /** Git in the repository root; proves a clean checkout of GITHUB_SHA. */
  git?: (args: string[]) => string
  /** Runs Wrangler and OpenNext; every D1 and Cloudflare call goes through it. */
  runner?: ProcessRunner
  /** The built Worker `deploy` ships; defaults to the OpenNext output. */
  workerEntrypoint?: string
}

/**
 * Parses, validates the reviewed Wrangler identity, authorizes, proves staging verification
 * where required, and only then touches D1 or Cloudflare.
 */
export async function runRelease(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ReleaseDependencies = {}
): Promise<unknown> {
  const runner = dependencies.runner ?? processRunner
  const args = parseReleaseArguments(argv)
  validateRemoteConfig(args.environment)
  if (args.rehearse === undefined) {
    authorizeRelease(args.command, args.environment, env, dependencies.git ?? git)
    const staging = await requireVerifiedStaging(args.command, env, dependencies.fetch)
    if (staging === 'hotfix') {
      console.error(
        `::warning title=Hotfix release::${args.command} ${args.environment} skips the staging check for ${env.GITHUB_SHA} (owner-approved hotfix). Merge main into staging next (docs/RELEASE_GUARDS.md#hotfixes).`
      )
    } else if (staging) {
      console.error(
        `Deploy Staging verified ${
          staging.match === 'commit'
            ? staging.sha
            : `tree ${staging.tree} of ${staging.sha} at staging commit ${staging.stagingSha}`
        }: ${staging.runUrl} (attempt ${staging.runAttempt})`
      )
    }
  }
  const d1 = wranglerD1(
    args.environment,
    args.rehearse === undefined
      ? { kind: 'remote' }
      : { kind: 'rehearsal', persistTo: resolve(args.rehearse) },
    runner
  )
  switch (args.command) {
    case 'list-migrations':
      return {
        environment: args.environment,
        ledger: project.migrationsTable,
        ...(await readMigrationLedger(d1))
      }
    case 'plan-release': {
      // Read-only and unauthorized, so the hotfix flag can only make the plan stricter.
      const running = protectedWorkflow(env.GITHUB_WORKFLOW_REF)
      // Inside a staging-gated release workflow, refuse a stale release here, before the
      // backup step exports (and blocks) the database for a release that cannot ship.
      if (running && running.authorization.requireVerifiedStaging.length > 0) {
        await assertCurrentRelease({
          apiUrl: env.GITHUB_API_URL,
          branch: running.authorization.branch,
          fetch: dependencies.fetch,
          sha: env.GITHUB_SHA,
          token: env.GITHUB_TOKEN
        })
      }
      return {
        environment: args.environment,
        ...planRelease(await readMigrationLedger(d1), args.environment, {
          hotfix: running ? isHotfixRelease(running.authorization, env) : false
        })
      }
    }
    case 'check-database': {
      const readiness = await checkDatabase(d1)
      assertDatabaseReady(readiness, args.environment)
      return { environment: args.environment, ...readiness }
    }
    case 'verify-import':
      return verifyImportedCatalog(d1, args.environment)
    case 'backup':
      if (!args.output) throw new Error('backup requires --output <file>.')
      return {
        environment: args.environment,
        ...(await backupDatabase(d1, args.environment, args.output))
      }
    case 'migrate':
      d1.applyMigrations()
      return { environment: args.environment, ...(await checkDatabase(d1)) }
    case 'import':
      return {
        environment: args.environment,
        ...(await importReviewedCatalog(d1, args.environment))
      }
    case 'deploy':
      await deployWorker(d1, args.environment, runner, dependencies.workerEntrypoint)
      return {
        deployed: project.remote[args.environment].workerName,
        environment: args.environment
      }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runRelease(process.argv.slice(2))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
