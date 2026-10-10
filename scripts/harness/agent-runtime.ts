import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { localSqlitePath } from '../d1-local-guard'
import { type SeedQuery, seedIncomplete } from '../d1-local-seed'
import { hasLocalD1Database, resolveFreshD1StateRoot } from '../d1-local-state'
import { project } from '../project'
import {
  buildRuntimeManifest,
  initializeRuntime,
  type RuntimeManifest,
  readRuntimeManifest,
  repositoryRoot,
  runtimeViolations
} from './worktree.ts'

function currentManifest(root: string, create = false): RuntimeManifest {
  const existing = readRuntimeManifest(root)
  if (existing) return existing
  const branch =
    execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() ||
    'detached'
  const fallbackName = `${basename(root)
    .replace(/[^a-z0-9-]/gu, '-')
    .slice(0, 30)}-${branch.replace(/[^a-z0-9-]/gu, '-').slice(0, 15)}`.replace(/-+/gu, '-')
  return create
    ? initializeRuntime(root, fallbackName)
    : buildRuntimeManifest(root, fallbackName, branch)
}

function manifestWithBindings(root: string, manifest: RuntimeManifest): Record<string, unknown> {
  const config = JSON.parse(readFileSync(resolve(root, project.wranglerConfigPath), 'utf8')) as {
    d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>
    name?: string
    vars?: Record<string, string>
  }
  return {
    ...manifest,
    domain: project.domain,
    processId: null,
    worker: config.name,
    bindings: {
      d1: config.d1_databases || [],
      variables: config.vars || {}
    },
    traceEndpoint: null,
    metricsEndpoint: null
  }
}

function doctor(root: string): void {
  const violations: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) violations.push(`Node 24+ is required; found ${process.versions.node}.`)
  const manifest = readRuntimeManifest(root)
  if (manifest) violations.push(...runtimeViolations(root, manifest))
  if (!existsSync(resolve(root, project.wranglerConfigPath)))
    violations.push(`${project.wranglerConfigPath} is missing.`)
  if (!existsSync(resolve(root, 'apps/web/drizzle')))
    violations.push('apps/web/drizzle is missing.')
  if (violations.length > 0) {
    throw new Error(`${violations.join('\n')}\nSee docs/harness.md#runtime-legibility.`)
  }
  console.log(
    manifest
      ? 'Agent doctor passed with isolated runtime state.'
      : 'Agent doctor passed. Main worktree uses default local state; initialize isolation with pnpm worktree:init.'
  )
}

/** Runs a local D1 guard command for this runtime, mirroring its output into the log. */
async function runLogged(
  root: string,
  manifest: RuntimeManifest,
  logPath: string,
  command: 'preview' | 'seed'
): Promise<number> {
  const child = spawn('pnpm', ['tsx', 'scripts/d1-local-guard.ts', command], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(manifest.webPort),
      HARNESS_D1_STATE_DIRECTORY: manifest.d1StateDirectory
    },
    stdio: ['inherit', 'pipe', 'pipe']
  })
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    appendFileSync(logPath, chunk)
  })
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk)
    appendFileSync(logPath, chunk)
  })
  // A command a signal killed has no exit code, and never succeeded (#313).
  return new Promise<number>(resolveStatus => {
    child.on('close', code => resolveStatus(code ?? 1))
  })
}

/**
 * Whether the runtime's local D1 needs the fixture seed before it is served: none exists yet, or
 * a seed that failed part-way left it migrated but empty, or seeded but unfinished (#313).
 */
export function needsFixtureSeed(stateRoot: string): boolean {
  if (!hasLocalD1Database(stateRoot)) return true
  const database = new DatabaseSync(localSqlitePath(stateRoot), { readOnly: true })
  try {
    const query: SeedQuery = (sql, params = []) =>
      database.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return seedIncomplete(query)
  } finally {
    database.close()
  }
}

/**
 * The runtime `agent:dev` serves, refused unless it belongs to this worktree and keeps its state
 * inside it (`runtimeViolations`, as `agent:doctor` checks): the seed resets the manifest's D1
 * directory, so a stale or foreign manifest must never reach it (#316 review).
 */
export function devRuntimeManifest(root: string): RuntimeManifest {
  const manifest = currentManifest(root, true)
  const violations = runtimeViolations(root, manifest)
  if (violations.length > 0) {
    throw new Error(`${violations.join('\n')}\nSee docs/harness.md#runtime-legibility.`)
  }
  return manifest
}

async function dev(root: string): Promise<void> {
  const manifest = devRuntimeManifest(root)
  mkdirSync(manifest.logDirectory, { recursive: true })
  const logPath = resolve(manifest.logDirectory, 'runtime.log')
  writeFileSync(logPath, '')
  console.log(`Runtime: ${manifest.webUrl}`)
  console.log(`Log: ${logPath}`)
  // A fresh runtime has no local D1 yet: seed it with the fixtures (#312) before serving. So does
  // one a failed seed left half-written (#313).
  const stateRoot = resolveFreshD1StateRoot({
    harnessStateDirectory: manifest.d1StateDirectory,
    repositoryRoot: root
  })
  if (needsFixtureSeed(stateRoot)) {
    console.log('No seeded local D1 yet: seeding fixtures with pnpm db:seed:local.')
    const seeded = await runLogged(root, manifest, logPath, 'seed')
    if (seeded !== 0) {
      process.exitCode = seeded
      return
    }
  }
  process.exitCode = await runLogged(root, manifest, logPath, 'preview')
}

function logs(root: string): void {
  const manifest = currentManifest(root)
  const path = resolve(manifest.logDirectory, 'runtime.log')
  if (!existsSync(path)) throw new Error(`No runtime log at ${path}. Start with pnpm agent:dev.`)
  const lines = readFileSync(path, 'utf8').split('\n').slice(-200)
  console.log(lines.join('\n'))
}

function evidence(root: string): void {
  const manifest = currentManifest(root, true)
  mkdirSync(manifest.artifactDirectory, { recursive: true })
  const timestamp = new Date().toISOString()
  const path = resolve(
    manifest.artifactDirectory,
    `evidence-${timestamp.replace(/[:.]/gu, '-')}.json`
  )
  const payload = {
    capturedAt: timestamp,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    status: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean),
    runtime: manifestWithBindings(root, manifest),
    commands: {
      fast: 'pnpm harness:fast',
      full: 'pnpm harness:check',
      browserSmoke: 'pnpm test:e2e:smoke'
    }
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(path)
}

async function main(): Promise<void> {
  const root = repositoryRoot()
  const [command, ...rest] = process.argv.slice(2).filter(value => value !== '--')
  if (rest.length > 0) {
    throw new Error(
      `Unexpected arguments: ${rest.join(' ')}. Agent runtime commands target only ${project.domain} and take no --site.`
    )
  }
  if (command === 'manifest') {
    console.log(JSON.stringify(manifestWithBindings(root, currentManifest(root)), null, 2))
    return
  }
  if (command === 'doctor') return doctor(root)
  if (command === 'dev') return dev(root)
  if (command === 'logs') return logs(root)
  if (command === 'evidence') return evidence(root)
  throw new Error('Usage: agent-runtime.ts <manifest|doctor|dev|logs|evidence>')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
