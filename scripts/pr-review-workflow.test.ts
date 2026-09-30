import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  id?: string
  uses?: string
  name?: string
  run?: string
  with?: Record<string, string | number>
}

interface WorkflowJob {
  needs?: string | string[]
  'runs-on'?: string
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  jobs: Record<string, WorkflowJob>
  permissions?: Record<string, string>
}

function loadWorkflow(): WorkflowDefinition {
  const workflowPath = resolve(process.cwd(), '.github/workflows/pr-review.yml')
  const raw = readFileSync(workflowPath, 'utf8')

  return yaml.load(raw) as WorkflowDefinition
}

function loadE2eRelevantFilters(): string[] {
  const workflow = loadWorkflow()
  const changesJob = workflow.jobs.changes
  const filterStep = changesJob.steps?.find(step => step.id === 'filter')
  const filters = yaml.load(String(filterStep?.with?.filters ?? '')) as {
    e2e_relevant?: string[]
  }

  return filters.e2e_relevant ?? []
}

function pathMatchesFilter(path: string, filter: string): boolean {
  if (!filter.endsWith('/**')) {
    return path === filter
  }

  return path.startsWith(filter.slice(0, -3))
}

function isE2eRelevant(path: string): boolean {
  return loadE2eRelevantFilters().some(filter => pathMatchesFilter(path, filter))
}

describe('pr-review workflow', () => {
  it('grants explicit permissions for PR change detection', () => {
    const workflow = loadWorkflow()

    expect(workflow.permissions).toMatchObject({
      contents: 'read',
      'pull-requests': 'read'
    })
  })

  it('validates the active Worker and D1 contracts without touching a database', () => {
    const workflow = loadWorkflow()
    const validateJob = workflow.jobs.validate
    const stepRuns = validateJob.steps?.map(step => step.run).filter(Boolean)
    const checkoutStep = validateJob.steps?.find(step => step.uses === 'actions/checkout@v7')

    expect(validateJob['runs-on']).toBe('ubuntu-latest')
    expect(checkoutStep?.with?.['fetch-depth']).toBe(0)
    expect(stepRuns).toContain('pnpm worker:config:validate')
    expect(stepRuns).toContain('pnpm test:repo')
    expect(stepRuns).toContain('pnpm lint:forbidden-links')
    const biomeStep = stepRuns.find(run => run.includes('pnpm exec biome check'))
    expect(biomeStep).toContain('git diff --name-only --diff-filter=ACMR -z origin/main...HEAD')
    expect(biomeStep).toContain(
      `pnpm exec biome check --no-errors-on-unmatched "\${changed_files[@]}"`
    )
    expect(biomeStep).toContain(`if ((\${#changed_files[@]} == 0)); then`)
    expect(biomeStep).toContain('No Biome-supported files changed; skipping.')
    expect(stepRuns).not.toContain('pnpm d1:local:migrate')
    expect(stepRuns).not.toContain('pnpm worker:deploy:production')
    expect(stepRuns).not.toContain('pnpm typecheck')
    expect(stepRuns).not.toContain('pnpm test')
  })

  it('runs PR typecheck and unit tests as separate GitHub-hosted jobs', () => {
    const workflow = loadWorkflow()
    const typecheckJob = workflow.jobs.typecheck
    const testJob = workflow.jobs.test

    expect(typecheckJob['runs-on']).toBe('ubuntu-latest')
    expect(testJob['runs-on']).toBe('ubuntu-latest')
    expect(typecheckJob.steps?.map(step => step.run)).toContain('pnpm typecheck')
    expect(testJob.steps?.map(step => step.run)).toContain('pnpm test')
    expect(typecheckJob.needs).toBeUndefined()
    expect(testJob.needs).toBeUndefined()
  })

  it('uses GitHub-hosted runners for PR review jobs so checks can run concurrently', () => {
    const workflow = loadWorkflow()

    expect(workflow.jobs.validate['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.typecheck['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.test['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.changes['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.e2e['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs.e2e.needs).toEqual(['changes'])
  })

  it('installs Playwright browsers without sudo-only system dependency escalation', () => {
    const workflow = loadWorkflow()
    const e2eJob = workflow.jobs.e2e
    const stepRuns = e2eJob.steps?.map(step => step.run).filter(Boolean)

    expect(stepRuns).toContain('pnpm --filter e2e test:install')
    expect(stepRuns).not.toContain('npx playwright install --with-deps')
  })

  it('uses the Node 24-compatible paths-filter action for E2E gating', () => {
    const workflow = loadWorkflow()
    const changesJob = workflow.jobs.changes
    const filterStep = changesJob.steps?.find(step => step.id === 'filter')

    expect(filterStep?.uses).toBe('dorny/paths-filter@v4')
  })

  it('keeps E2E path filtering behavior scoped to relevant app and test paths', () => {
    const filters = loadE2eRelevantFilters()

    expect(filters).toEqual([
      'apps/serp.software/**',
      'apps/pornvideodownloaders.com/**',
      'apps/e2e/**',
      'd1/**',
      'packages/data-ops/**',
      'packages/web-core/**',
      'packages/design-system/**',
      'sites/**'
    ])
    expect(isE2eRelevant('apps/e2e/tests/home.spec.ts')).toBe(true)
    expect(isE2eRelevant('apps/serp.software/app/page.tsx')).toBe(true)
    expect(isE2eRelevant('apps/pornvideodownloaders.com/app/page.tsx')).toBe(true)
    expect(isE2eRelevant('d1/publications/release.yaml')).toBe(true)
    expect(isE2eRelevant('packages/data-ops/src/catalog.ts')).toBe(true)
    expect(isE2eRelevant('packages/web-core/src/root-shell.tsx')).toBe(true)
    expect(isE2eRelevant('packages/design-system/components/button.tsx')).toBe(true)
    expect(isE2eRelevant('sites/serp.software/site-config.ts')).toBe(true)
    expect(isE2eRelevant('docs/BUILD_PIPELINE.md')).toBe(false)
    expect(isE2eRelevant('.github/workflows/pr-review.yml')).toBe(false)
  })
})
