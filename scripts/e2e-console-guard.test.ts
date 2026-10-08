import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const testsDirectory = resolve('apps/e2e/tests')
// Agent capture records console output as evidence for a run; it must not fail on it.
const exempt = new Set(['agent-capture.spec.ts'])

describe('E2E console-error guard (#160)', () => {
  it('makes every journey use the test that fails on browser console errors', () => {
    const specs = readdirSync(testsDirectory).filter(
      file => file.endsWith('.spec.ts') && !exempt.has(file)
    )
    expect(specs.length).toBeGreaterThan(0)

    const violations = specs.filter(file => {
      const source = readFileSync(resolve(testsDirectory, file), 'utf8')
      const importsGuardedTest = /import \{[^}]*\btest\b[^}]*\} from '\.\/test'/u.test(source)
      const importsBaseTest = /import \{[^}]*\btest\b[^}]*\} from '@playwright\/test'/su.test(
        source
      )
      // A default or namespace import would reach the unchecked test too (`pw.test`).
      const importsWholeModule =
        /import\s+(?:\*\s+as\s+)?\w+\s*(?:,|from)[^;]*'@playwright\/test'/u.test(source)
      return !importsGuardedTest || importsBaseTest || importsWholeModule
    })
    expect(violations, "import { test } from './test', not from '@playwright/test'").toEqual([])
  })
})
