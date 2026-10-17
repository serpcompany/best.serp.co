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
        cache?: string
        dest?: string
      }
    }>
  }
}

function loadYamlFile<T>(path: string): T {
  return yaml.load(readFileSync(resolve(process.cwd(), path), 'utf8')) as T
}

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

  it('caches the pnpm store through setup-node', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const nodeStep = action.runs.steps.find(step => step.uses?.startsWith('actions/setup-node@'))

    expect(nodeStep?.with?.cache).toBe('pnpm')
  })

  it('restores no build cache from an earlier run', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')

    // `.next/cache` holds Turbopack's build cache; builds restored from it served a stale
    // globals.css, so every build compiles the checked-out tree.
    expect(action.runs.steps.filter(step => step.uses?.startsWith('actions/cache'))).toEqual([])
    expect(JSON.stringify(action)).not.toContain('.next')
  })
})
