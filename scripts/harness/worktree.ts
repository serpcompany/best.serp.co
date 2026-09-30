import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimeManifest {
  artifactDirectory: string
  branch: string
  browserProfileDirectory: string
  buildCacheDirectory: string
  createdAt: string
  d1StateDirectory: string
  instanceId: string
  logDirectory: string
  repositoryPath: string
  runtimeManifestPath: string
  webPort: number
  webUrl: string
  wranglerStateDirectory: string
}

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

export function repositoryRoot(cwd = resolve('.')): string {
  return git(cwd, ['rev-parse', '--show-toplevel'])
}

function instancePort(instanceId: string, repositoryPath: string): number {
  const digest = createHash('sha256').update(`${repositoryPath}\0${instanceId}`).digest()
  return 8787 + (digest.readUInt16BE(0) % 1000)
}

export function buildRuntimeManifest(
  root: string,
  instanceId: string,
  branch = 'unknown',
  createdAt = new Date().toISOString(),
  reservedPorts = new Set<number>()
): RuntimeManifest {
  if (!INSTANCE_PATTERN.test(instanceId)) {
    throw new Error('Instance name must use 2-48 lowercase letters, numbers, or hyphens.')
  }
  const runtimeRoot = resolve(root, '.runtime', instanceId)
  let webPort = instancePort(instanceId, resolve(root))
  let attempts = 0
  while (reservedPorts.has(webPort) && attempts < 1000) {
    webPort = webPort >= 9786 ? 8787 : webPort + 1
    attempts += 1
  }
  if (reservedPorts.has(webPort)) throw new Error('No harness port is available in 8787-9786.')
  return {
    artifactDirectory: resolve(runtimeRoot, 'artifacts'),
    branch,
    browserProfileDirectory: resolve(runtimeRoot, 'browser'),
    buildCacheDirectory: resolve(runtimeRoot, 'cache'),
    createdAt,
    d1StateDirectory: resolve(runtimeRoot, 'd1'),
    instanceId,
    logDirectory: resolve(runtimeRoot, 'logs'),
    repositoryPath: resolve(root),
    runtimeManifestPath: resolve(root, '.runtime', 'manifest.json'),
    webPort,
    webUrl: `http://127.0.0.1:${webPort}`,
    wranglerStateDirectory: resolve(runtimeRoot, 'wrangler')
  }
}

export function initializeRuntime(root: string, instanceId: string): RuntimeManifest {
  const branch = git(root, ['branch', '--show-current']) || 'detached'
  const worktreePaths = git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
  const reservedPorts = new Set<number>()
  for (const worktreePath of worktreePaths) {
    if (resolve(worktreePath) === resolve(root)) continue
    const other = readRuntimeManifest(worktreePath)
    if (other) reservedPorts.add(other.webPort)
  }
  const manifest = buildRuntimeManifest(
    root,
    instanceId,
    branch,
    new Date().toISOString(),
    reservedPorts
  )
  for (const directory of [
    manifest.artifactDirectory,
    manifest.browserProfileDirectory,
    manifest.buildCacheDirectory,
    manifest.d1StateDirectory,
    manifest.logDirectory,
    manifest.wranglerStateDirectory
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  mkdirSync(dirname(manifest.runtimeManifestPath), { recursive: true })
  writeFileSync(manifest.runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function readRuntimeManifest(root: string): RuntimeManifest | null {
  const path = resolve(root, '.runtime', 'manifest.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest
}

export function runtimeViolations(root: string, manifest: RuntimeManifest | null): string[] {
  if (!manifest) return ['No .runtime/manifest.json. Run pnpm worktree:init -- <name>.']
  const violations: string[] = []
  if (resolve(manifest.repositoryPath) !== resolve(root)) {
    violations.push('Runtime manifest belongs to another worktree.')
  }
  if (!INSTANCE_PATTERN.test(manifest.instanceId))
    violations.push('Runtime instance ID is invalid.')
  if (manifest.webPort < 1024 || manifest.webPort > 65535)
    violations.push('Runtime web port is invalid.')
  for (const [label, path] of Object.entries({
    artifacts: manifest.artifactDirectory,
    browser: manifest.browserProfileDirectory,
    cache: manifest.buildCacheDirectory,
    d1: manifest.d1StateDirectory,
    logs: manifest.logDirectory,
    wrangler: manifest.wranglerStateDirectory
  })) {
    if (!existsSync(path)) violations.push(`${label} directory is missing: ${path}`)
    if (relative(root, path).startsWith('..'))
      violations.push(`${label} directory escapes this worktree.`)
  }
  return violations
}

function managedWorktreePath(root: string, name: string): string {
  if (!INSTANCE_PATTERN.test(name)) {
    throw new Error('Worktree name must use 2-48 lowercase letters, numbers, or hyphens.')
  }
  return resolve(root, '..', `${basename(root)}-worktrees`, name)
}

function newWorktree(root: string, name: string): void {
  const target = managedWorktreePath(root, name)
  const branch = `codex/${name}`
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing path: ${target}`)
  const branchExists =
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: root
    }).status === 0
  if (branchExists) throw new Error(`Branch already exists: ${branch}`)
  if (git(root, ['status', '--porcelain'])) {
    throw new Error('Controlling checkout must be clean before creating a worktree.')
  }

  mkdirSync(dirname(target), { recursive: true })
  execFileSync('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], {
    cwd: root,
    stdio: 'inherit'
  })
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: target,
    stdio: 'inherit'
  })
  if (install.status !== 0) {
    throw new Error(
      `Worktree exists but dependency installation failed. Repair it at ${target}; do not recreate it.`
    )
  }
  execFileSync('pnpm', ['tsx', 'scripts/harness/worktree.ts', 'init', name], {
    cwd: target,
    stdio: 'inherit'
  })
  console.log(`Worktree ready: ${target}`)
  console.log(`Open Codex with: cd ${JSON.stringify(target)} && codex`)
}

function destroyWorktree(root: string, name: string): void {
  const target = managedWorktreePath(root, name)
  const registered = git(root, ['worktree', 'list', '--porcelain']).includes(`worktree ${target}`)
  if (!registered) throw new Error(`Refusing to remove an unregistered worktree: ${target}`)
  execFileSync('git', ['worktree', 'remove', target], { cwd: root, stdio: 'inherit' })
  console.log(`Removed worktree ${target}. Branch codex/${name} was preserved for recovery.`)
}

function main(): void {
  const root = repositoryRoot()
  const [command, rawName] = process.argv.slice(2).filter(value => value !== '--')
  if (command === 'new') {
    if (!rawName) throw new Error('Usage: pnpm worktree:new -- <task-name>')
    newWorktree(root, rawName)
    return
  }
  if (command === 'init') {
    if (!rawName) throw new Error('Usage: pnpm worktree:init -- <instance-name>')
    console.log(JSON.stringify(initializeRuntime(root, rawName), null, 2))
    return
  }
  if (command === 'doctor') {
    const violations = runtimeViolations(root, readRuntimeManifest(root))
    if (violations.length > 0) throw new Error(violations.join('\n'))
    console.log('Worktree runtime isolation passed.')
    return
  }
  if (command === 'destroy') {
    if (!rawName) throw new Error('Usage: pnpm worktree:destroy -- <task-name>')
    destroyWorktree(root, rawName)
    return
  }
  throw new Error('Usage: worktree.ts <new|init|doctor|destroy> [name]')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
