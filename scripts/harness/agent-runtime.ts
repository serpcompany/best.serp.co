import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSiteTarget, type SiteTarget } from '../site-targets'
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

function manifestWithBindings(
  root: string,
  manifest: RuntimeManifest,
  target: SiteTarget
): Record<string, unknown> {
  const config = JSON.parse(readFileSync(resolve(root, target.local.configPath), 'utf8')) as {
    d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>
    name?: string
    vars?: Record<string, string>
  }
  return {
    ...manifest,
    siteId: target.siteId,
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

function doctor(root: string, target: SiteTarget): void {
  const violations: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) violations.push(`Node 24+ is required; found ${process.versions.node}.`)
  const manifest = readRuntimeManifest(root)
  if (manifest) violations.push(...runtimeViolations(root, manifest))
  if (!existsSync(resolve(root, target.local.configPath)))
    violations.push(`${target.local.configPath} is missing.`)
  if (!existsSync(resolve(root, 'd1/drizzle'))) violations.push('d1/drizzle is missing.')
  if (violations.length > 0) {
    throw new Error(`${violations.join('\n')}\nSee docs/HARNESS.md#runtime-legibility.`)
  }
  console.log(
    manifest
      ? 'Agent doctor passed with isolated runtime state.'
      : 'Agent doctor passed. Main worktree uses default local state; initialize isolation with pnpm worktree:init.'
  )
}

async function dev(root: string, target: SiteTarget): Promise<void> {
  const manifest = currentManifest(root, true)
  mkdirSync(manifest.logDirectory, { recursive: true })
  const logPath = resolve(manifest.logDirectory, 'runtime.log')
  writeFileSync(logPath, '')
  console.log(`Runtime: ${manifest.webUrl}`)
  console.log(`Log: ${logPath}`)
  const child = spawn(
    'pnpm',
    ['tsx', 'scripts/d1-local-guard.ts', 'preview', '--site', target.siteId],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(manifest.webPort),
        HARNESS_D1_STATE_DIRECTORY: manifest.d1StateDirectory
      },
      stdio: ['inherit', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    appendFileSync(logPath, chunk)
  })
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk)
    appendFileSync(logPath, chunk)
  })
  const status = await new Promise<number>(resolveStatus => {
    child.on('close', code => resolveStatus(code || 0))
  })
  process.exitCode = status
}

function logs(root: string): void {
  const manifest = currentManifest(root)
  const path = resolve(manifest.logDirectory, 'runtime.log')
  if (!existsSync(path)) throw new Error(`No runtime log at ${path}. Start with pnpm agent:dev.`)
  const lines = readFileSync(path, 'utf8').split('\n').slice(-200)
  console.log(lines.join('\n'))
}

function evidence(root: string, target: SiteTarget): void {
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
    runtime: manifestWithBindings(root, manifest, target),
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
  const [command, siteFlag, siteValue] = process.argv.slice(2)
  if (siteFlag !== '--site')
    throw new Error('Agent runtime commands require an explicit --site argument.')
  const target = resolveSiteTarget(siteValue)
  if (command === 'manifest') {
    console.log(JSON.stringify(manifestWithBindings(root, currentManifest(root), target), null, 2))
    return
  }
  if (command === 'doctor') return doctor(root, target)
  if (command === 'dev') return dev(root, target)
  if (command === 'logs') return logs(root)
  if (command === 'evidence') return evidence(root, target)
  throw new Error('Usage: agent-runtime.ts <manifest|doctor|dev|logs|evidence> --site <site-id>')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
