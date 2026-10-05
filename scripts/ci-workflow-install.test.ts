import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface InstallAction {
  runs: {
    steps: Array<{
      id?: string
      if?: string
      run?: string
      uses?: string
      with?: {
        dest?: string
        key?: string
        path?: string
      }
    }>
  }
}

function loadYamlFile<T>(path: string): T {
  return yaml.load(readFileSync(resolve(process.cwd(), path), 'utf8')) as T
}

const githubExpression = (expression: string) => `$${expression}`
const pnpmAction = 'pnpm/action-setup@v6'

describe('ci workflow install isolation', () => {
  it('installs pnpm into a job-scoped temp directory on self-hosted runners', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const pnpmStep = action.runs.steps.find(step => step.uses === pnpmAction)

    expect(pnpmStep?.with?.dest).toContain('runner.temp')
    expect(pnpmStep?.with?.dest).toContain('github.run_id')
    expect(pnpmStep?.with?.dest).toContain('github.job')
  })

  it('scopes temporary files to the job on a self-hosted runner, first', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const [first] = action.runs.steps

    // Tests and tools leave files in os.tmpdir(); RUNNER_TEMP is emptied per job.
    expect(first?.if).toBe("runner.environment == 'self-hosted'")
    expect(first?.run).toBe('echo "TMPDIR=$RUNNER_TEMP" >> "$GITHUB_ENV"')
  })

  it('uses the Node 24-compatible pnpm setup action', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const actionUses = action.runs.steps.map(step => step.uses).filter(Boolean)

    expect(actionUses).toContain(pnpmAction)
    expect(actionUses).not.toContain('pnpm/action-setup@v4')
  })

  it('persists app-level Next caches without caching generated artifacts', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const cacheStep = action.runs.steps.find(step => step.uses === 'actions/cache@v5')
    const cachePath = cacheStep?.with?.path ?? ''

    expect(cachePath).toContain('~/.pnpm')
    expect(cachePath).toContain(`${githubExpression('{{ github.workspace }}')}/apps/*/.next/cache`)
    expect(cachePath).toContain(`${githubExpression('{{ github.workspace }}')}/.next/cache`)
    expect(cachePath).not.toContain('apps/*/out')
    expect(cachePath).not.toContain('dist/sites')
    expect(cachePath).not.toContain('.next/**')
    expect(cachePath).not.toContain('.next/server')
    expect(cachePath).not.toContain('.next/static')
    expect(cachePath).not.toContain('.next/build')
    expect(cacheStep?.with?.key).toContain("hashFiles('**/pnpm-lock.yaml')")
    expect(cacheStep?.with?.key).toContain(
      "hashFiles('**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx')"
    )
  })
})
