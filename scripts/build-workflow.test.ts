import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('build-and-deploy workflow defaults', () => {
  it('does not hardcode a fallback site id for push deploys', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/build-and-deploy.yml'),
      'utf8'
    )
    const legacyPushFallbackEnv = ['PUSH', 'FALLBACK_SITE_ID'].join('_')
    const legacyRepoSiteVariable = ['vars', 'SITE_ID'].join('.')

    expect(workflow).not.toContain('SITE_ID: serpdownloaders.com')
    expect(workflow).not.toContain(legacyPushFallbackEnv)
    expect(workflow).not.toContain(legacyRepoSiteVariable)
  })
})
