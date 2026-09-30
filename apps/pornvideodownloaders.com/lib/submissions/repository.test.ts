import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('submission adapter boundary', () => {
  it('only validates the Worker binding/environment and delegates explicit Site operations', () => {
    const repository = readFileSync(resolve(import.meta.dirname, 'repository.ts'), 'utf8')

    expect(repository).toContain("import 'server-only'")
    expect(repository).toContain('getCloudflareContext')
    expect(repository).toContain('workerEnv.DB')
    expect(repository).toContain('workerEnv.D1_RUNTIME_ENV')
    expect(repository).toContain('resolveRuntimeSiteId({')
    expect(repository).toContain('createSiteDatabase(workerEnv.DB, siteId)')
    expect(repository).toContain('createSubmissionOperations')
    expect(repository).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/u)
    expect(repository).not.toContain('.prepare(')
    expect(repository).not.toContain('.batch(')
    expect(repository).not.toMatch(/node:fs|readFile|writeFile/u)
  })
})
