import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const emailDirectory = import.meta.dirname
const appDirectory = resolve(emailDirectory, '../..')

function source(file: string): string {
  return readFileSync(resolve(emailDirectory, file), 'utf8')
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

  it('keeps SQL in packages/data-ops and the test fixture out of the registry', () => {
    for (const file of readdirSync(emailDirectory).filter(name => name.endsWith('.ts'))) {
      const code = source(file)
      if (file.endsWith('.test.ts')) continue
      expect(code, file).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\b|\.prepare\(|\.batch\(/u)
    }
    expect(source('registry.ts')).not.toContain('test-fixture')
  })

  it('is never imported by a Client Component', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: appDirectory,
      encoding: 'utf8'
    })
      .split('\n')
      .filter(file => /\.(?:ts|tsx)$/u.test(file))
    const violations = files.filter(file => {
      const code = readFileSync(resolve(appDirectory, file), 'utf8')
      return /^['"]use client['"]/mu.test(code) && /lib\/email\b/u.test(code)
    })
    expect(violations).toEqual([])
  })
})
