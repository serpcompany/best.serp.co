import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
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
import { project } from './project'

function wrangler(args: string[]): void {
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
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'inherit' }
  )
}

/** `pnpm db:migrations:list:local`: the apps/web/drizzle migrations local D1 has not applied yet. */
function listMigrations(): void {
  wrangler(['d1', 'migrations', 'list', project.local.databaseName])
}

function migrate(): void {
  wrangler(['d1', 'migrations', 'apply', project.local.databaseName])
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

function localDatabase(): DatabaseSync {
  return new DatabaseSync(localSqlitePath(configuredFreshD1StateRoot()), { readOnly: true })
}

function sqliteQuery(database: DatabaseSync): SeedQuery {
  return (sql, params = []) =>
    database.prepare(sql).all(...params) as Array<Record<string, unknown>>
}

/** `pnpm db:verify:local`: checks a seeded local D1 (`pnpm db:seed:local`) against the seed's facts. */
function verify(): void {
  const database = localDatabase()
  try {
    const query = sqliteQuery(database)
    if (!isSeeded(query)) {
      throw new Error('Local D1 holds no fixture seed; pnpm db:seed:local resets and seeds it.')
    }
    const violations = seedFactViolations(query, { marker: true, media: true })
    if (violations.length > 0) {
      throw new Error(
        `Local D1 no longer matches the fixture seed; pnpm db:seed:local resets it.\n${violations.join('\n')}`
      )
    }
    console.log('Verified local D1 against the fixture seed facts.')
  } finally {
    database.close()
  }
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
    throw new Error(
      'The v1 catalog import is retired (#315; history in .archive/). pnpm db:seed:local seeds local D1 with fixtures.'
    )
  }
  if (command === 'verify') {
    verify()
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
    `Unknown local D1 command: ${command || 'missing'}. Use list, migrate, seed, verify, publish, or preview.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runLocalD1Command(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
