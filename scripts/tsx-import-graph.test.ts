import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Repository scripts run under plain `tsx` from the root, which has no tsconfig `paths`, so a
 * module they load cannot use the app's `@/` alias. Vitest defines the alias, so only a
 * deployed workflow would otherwise find the break (`d1-preview-http-gates.ts`, #173).
 */
const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS = join(ROOT, 'scripts')
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const SPECIFIER =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu

function scriptEntries(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'fixtures' ? [] : scriptEntries(path)
    return /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name) ? [path] : []
  })
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  return RESOLVE_SUFFIXES.map(suffix => base + suffix).find(
    path => existsSync(path) && statSync(path).isFile()
  )
}

describe('modules loaded by tsx scripts', () => {
  it('import nothing through the app-only @/ alias', () => {
    const violations = new Set<string>()
    const visited = new Set<string>()
    const pending = scriptEntries(SCRIPTS)

    while (pending.length > 0) {
      const file = pending.pop() as string
      if (visited.has(file)) continue
      visited.add(file)

      for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2]
        if (specifier.startsWith('@/')) {
          violations.add(`${relative(ROOT, file)} imports ${specifier}`)
        } else if (specifier.startsWith('.')) {
          const target = resolveRelative(file, specifier)
          if (target && /\.tsx?$/u.test(target)) pending.push(target)
        }
      }
    }

    expect(visited.size).toBeGreaterThan(50)
    expect([...violations].sort()).toEqual([])
  })
})
