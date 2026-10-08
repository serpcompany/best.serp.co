import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const emailDirectory = import.meta.dirname
/** `apps/web/src`, which `@/` names; paths below are relative to it. */
const appDirectory = resolve(emailDirectory, '../..')
/** `apps/web`, so the app-root files (`worker.ts`, configs) are scanned too (#172). */
const webDirectory = resolve(appDirectory, '..')

function source(file: string): string {
  return readFileSync(resolve(emailDirectory, file), 'utf8')
}

function appFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: webDirectory,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(file => /\.(?:ts|tsx|js|jsx|mjs)$/u.test(file))
    .map(file => relative(appDirectory, resolve(webDirectory, file)))
}

/** Every module specifier a file imports or re-exports, statically or dynamically. */
function importSpecifiers(code: string): string[] {
  return [
    ...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/gu),
    ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1] ?? '')
}

/** True when a specifier in `file` (relative to apps/web/src) points into `lib/email`. */
function importsEmailModule(file: string, specifier: string): boolean {
  let target: string | null = null
  if (specifier.startsWith('@/')) target = resolve(appDirectory, specifier.slice(2))
  else if (specifier.startsWith('.')) target = resolve(appDirectory, dirname(file), specifier)
  if (!target) return false
  const fromApp = relative(appDirectory, target)
  return fromApp === 'lib/email' || fromApp.startsWith('lib/email/')
}

describe('email module boundary', () => {
  it('enters Next.js only through the server-only adapter', () => {
    const server = source('server.ts')
    expect(server).toContain("import 'server-only'")
    expect(server).toContain('getCloudflareContext({ async: true })')
    expect(server).toContain('context: ctx')

    // The rest stays framework-free so a Worker handler outside Next.js can use it.
    const modules = readdirSync(emailDirectory).filter(
      file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'server.ts'
    )
    expect(modules.sort()).toEqual([
      'config.ts',
      'dev-outbox.ts',
      'registry.ts',
      'runtime.ts',
      'senders.ts',
      'service.ts',
      'sign-in-code.ts',
      'templates.ts',
      'test-fixture.ts'
    ])
    const emails = readdirSync(resolve(emailDirectory, 'emails'))
      .filter(file => file.endsWith('.ts'))
      .map(file => `emails/${file}`)
    for (const file of [...modules, ...emails]) {
      expect(source(file), file).not.toMatch(
        /import 'server-only'|from '(?:@opennextjs\/[^']+|next(?:\/[^']+)?)'|process\.env/u
      )
    }
  })

  it('never depends on the auth module, which depends on it', () => {
    const emailFiles = appFiles().filter(file => file.startsWith('lib/email/'))
    expect(emailFiles.length).toBeGreaterThan(10)
    const authImports = emailFiles.filter(file =>
      importSpecifiers(readFileSync(resolve(appDirectory, file), 'utf8')).some(specifier => {
        const target = specifier.startsWith('@/')
          ? resolve(appDirectory, specifier.slice(2))
          : specifier.startsWith('.')
            ? resolve(appDirectory, dirname(file), specifier)
            : null
        const fromApp = target ? relative(appDirectory, target) : ''
        return fromApp === 'lib/auth' || fromApp.startsWith('lib/auth/')
      })
    )
    expect(authImports).toEqual([])
    // The sign-in code contract imports nothing, so Better Auth's config can load it anywhere.
    expect(importSpecifiers(source('sign-in-code.ts'))).toEqual([])
  })

  it('reads D1 only after resolving the environment policy, and holds no SQL', () => {
    const runtime = source('runtime.ts')
    const policy = runtime.indexOf('resolveEmailPolicy(env)')
    const binding = runtime.indexOf('if (!env.DB)')
    const resolved = runtime.indexOf('= resolveWorkerDelivery(env)')
    const database = runtime.indexOf('createDatabase(database)')
    expect(policy).toBeGreaterThan(-1)
    expect(binding).toBeGreaterThan(policy)
    expect(resolved).toBeGreaterThan(binding)
    expect(database).toBeGreaterThan(resolved)
    expect(runtime.match(/createDatabase\(/gu)).toHaveLength(1)
    expect(runtime).toContain('@serpdirectory/data-ops/email-deliveries')

    for (const file of readdirSync(emailDirectory).filter(name => name.endsWith('.ts'))) {
      if (file.endsWith('.test.ts')) continue
      expect(source(file), file).not.toMatch(
        /\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(|drizzle[-]orm/u
      )
    }
  })

  it('keeps markup minting private and test fixtures out of app code', () => {
    const templates = source('templates.ts')
    expect(templates).not.toMatch(/export\s+(?:const|let|var)\s+MINT\b|fromTrustedMarkup/u)
    expect(source('registry.ts')).not.toContain('test-fixture')
    const fixtureImports = appFiles().filter(
      file =>
        !/\.test\.tsx?$/u.test(file) &&
        importSpecifiers(readFileSync(resolve(appDirectory, file), 'utf8')).some(specifier =>
          /(?:^|\/)(?:test-fixture|samples)$/u.test(specifier)
        )
    )
    expect(fixtureImports).toEqual([])
    // Templates take every address as input or from config; none holds one.
    for (const file of readdirSync(resolve(emailDirectory, 'emails'))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'samples.ts') continue
      expect(source(`emails/${file}`), file).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/u)
    }
  })

  it('is never imported by a Client Component, by any path', () => {
    expect(importsEmailModule('app/page.tsx', '@/lib/email/server')).toBe(true)
    expect(importsEmailModule('lib/auth/client.tsx', '../email/config')).toBe(true)
    expect(importsEmailModule('components/form.tsx', '../lib/email')).toBe(true)
    expect(importsEmailModule('lib/emailer.ts', './emailer-utils')).toBe(false)

    const violations = appFiles().filter(file => {
      const code = readFileSync(resolve(appDirectory, file), 'utf8')
      return (
        /^\s*['"]use client['"]/mu.test(code) &&
        importSpecifiers(code).some(specifier => importsEmailModule(file, specifier))
      )
    })
    expect(violations).toEqual([])
  })
})
