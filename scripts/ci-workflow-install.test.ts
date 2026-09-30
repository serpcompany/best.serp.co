import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface InstallAction {
  runs: {
    steps: Array<{
      id?: string
      uses?: string
      with?: {
        dest?: string
        key?: string
        path?: string
      }
    }>
  }
}

interface WorkflowDefinition {
  concurrency?: {
    'cancel-in-progress'?: boolean
    group?: string
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

  it('uses the Node 24-compatible pnpm setup action', () => {
    const action = loadYamlFile<InstallAction>('.github/actions/install/action.yml')
    const actionUses = action.runs.steps.map(step => step.uses).filter(Boolean)

    expect(actionUses).toContain(pnpmAction)
    expect(actionUses).not.toContain('pnpm/action-setup@v4')
  })

  it('serializes every Production D1 workflow for a Site in the same non-canceling group', () => {
    const buildWorkflow = loadYamlFile<WorkflowDefinition>('.github/workflows/build-and-deploy.yml')
    const publishWorkflow = loadYamlFile<WorkflowDefinition>('.github/workflows/publish-d1.yml')
    const approvalWorkflow = loadYamlFile<WorkflowDefinition>(
      '.github/workflows/approve-d1-submission.yml'
    )
    const pvdWorkflow = loadYamlFile<WorkflowDefinition>(
      '.github/workflows/deploy-pornvideodownloaders.yml'
    )

    const productionD1Group = `${githubExpression('{{ inputs.site_id }}')}-production-d1`
    expect(buildWorkflow.concurrency?.group).toContain("'serp.software-production-d1'")
    expect(buildWorkflow.concurrency?.group).not.toContain('inputs.site_id')
    expect(publishWorkflow.concurrency?.group).toBe(productionD1Group)
    expect(approvalWorkflow.concurrency?.group).toBe(productionD1Group)
    expect(pvdWorkflow.concurrency?.group).toContain("'pornvideodownloaders.com-production-d1'")
    expect(pvdWorkflow.concurrency?.group).not.toContain('inputs.site_id')
    expect(buildWorkflow.concurrency?.['cancel-in-progress']).toBe(false)
    expect(pvdWorkflow.concurrency?.['cancel-in-progress']).toBe(false)
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
