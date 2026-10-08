import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { routedRunsOn } from './ci-runners'

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string | number>
}

interface WorkflowJob {
  environment?: unknown
  env?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  concurrency?: { 'cancel-in-progress'?: boolean }
  jobs: Record<string, WorkflowJob>
  on: {
    push?: {
      branches?: string[]
      paths?: string[]
    }
  }
  permissions?: Record<string, string>
}

function loadWorkflow(): WorkflowDefinition {
  const workflowPath = resolve(process.cwd(), '.github/workflows/main-validation.yml')
  return yaml.load(readFileSync(workflowPath, 'utf8')) as WorkflowDefinition
}

describe('main validation workflow', () => {
  it('validates every pushed staging and main revision without deployment authority', () => {
    const workflow = loadWorkflow()
    const job = workflow.jobs.validate
    const checkout = job.steps?.find(step => step.uses === 'actions/checkout@v7')
    const commands = job.steps?.map(step => step.run).filter(Boolean)

    expect(workflow.on.push?.branches).toEqual(['staging', 'main'])
    expect(workflow.on.push?.paths).toBeUndefined()
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency?.['cancel-in-progress']).not.toBe(true)

    // No browsers, sudo, apt, or credentials: it follows CI_RUNNER_LABELS.
    expect(job['runs-on']).toBe(routedRunsOn)
    expect(job.environment).toBeUndefined()
    // pnpm check lints the whole repository, so the job needs no diff range.
    expect(job.env).toBeUndefined()
    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(job.steps?.map(step => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@v7',
      './.github/actions/install'
    ])
    expect(commands).toEqual(['pnpm harness:check'])
    expect(commands?.join('\n')).not.toMatch(/deploy|wrangler|--remote|d1:/i)
  })
})
