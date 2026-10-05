import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const emailDirectory = import.meta.dirname
const appDirectory = resolve(emailDirectory, '../..')

function source(file: string): string {
  return readFileSync(resolve(emailDirectory, file), 'utf8')
}

function appFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: appDirectory,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(file => /\.(?:ts|tsx|js|jsx|mjs)$/u.test(file))
}

/** Every module specifier a file imports or re-exports, statically or dynamically. */
function importSpecifiers(code: string): string[] {
  return [
    ...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/gu),
    ...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1] ?? '')
}

/** True when a specifier in `file` (relative to apps/web) points into `lib/email`. */
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
      'registry.ts',
      'runtime.ts',
      'senders.ts',
      'service.ts',
      'templates.ts',
      'test-fixture.ts'
    ])
    for (const file of modules) {
      expect(source(file), file).not.toMatch(
        /import 'server-only'|from '(?:@opennextjs\/[^']+|next(?:\/[^']+)?)'|process\.env/u
      )
    }
  })

  it('reads D1 only after resolving the environment policy, and holds no SQL', () => {
    const runtime = source('runtime.ts')
    const policy = runtime.indexOf('resolveEmailPolicy(env)')
    const binding = runtime.indexOf('if (!env.DB)')
    const database = runtime.indexOf('createDatabase(env.DB)')
    expect(policy).toBeGreaterThan(-1)
    expect(binding).toBeGreaterThan(policy)
    expect(database).toBeGreaterThan(binding)
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
          /(?:^|\/)test-fixture$/u.test(specifier)
        )
    )
    expect(fixtureImports).toEqual([])
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
