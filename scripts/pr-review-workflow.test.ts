import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  env?: Record<string, string>
  id?: string
  if?: string
  uses?: string
  name?: string
  run?: string
  with?: Record<string, string | number>
}

interface WorkflowJob {
  if?: string
  name?: string
  needs?: string | string[]
  'runs-on'?: string
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  jobs: Record<string, WorkflowJob>
  on: { pull_request?: { branches?: string[]; paths?: string[]; 'paths-ignore'?: string[] } }
  permissions?: Record<string, string>
}

function loadWorkflow(): WorkflowDefinition {
  const workflowPath = resolve(process.cwd(), '.github/workflows/pr-review.yml')
  const raw = readFileSync(workflowPath, 'utf8')

  return yaml.load(raw) as WorkflowDefinition
}

/** The five checks ruleset `main` (and the `staging` ruleset) require. */
const requiredChecks = [
  'Validate Site & Policy',
  'Type Check',
  'Unit Tests',
  'OpenNext Worker Build',
  'E2E Tests'
]

describe('pr-review workflow', () => {
  it('reviews pull requests into staging (the base branch) and main (promotions, hotfixes)', () => {
    const workflow = loadWorkflow()

    expect(workflow.on.pull_request).toEqual({ branches: ['staging', 'main'] })
  })

  it('runs every required check on every pull request, unfiltered', () => {
    const workflow = loadWorkflow()
    const source = readFileSync(resolve(process.cwd(), '.github/workflows/pr-review.yml'), 'utf8')

    // A skipped job satisfies a required check, so no required job may be conditional.
    expect(Object.values(workflow.jobs).map(job => job.name)).toEqual(requiredChecks)
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if, job.name).toBeUndefined()
      expect(job.needs, job.name).toBeUndefined()
    }
    expect(source).not.toContain('paths-filter')
    expect(workflow.jobs.changes).toBeUndefined()
  })

  it('accepts pull requests into main only from staging or a hotfix branch of this repository', () => {
    const workflow = loadWorkflow()
    const steps = workflow.jobs.validate.steps ?? []
    const guard = steps.find(step => step.run?.includes('accepts only a promotion from staging'))

    expect(steps.indexOf(guard as WorkflowStep)).toBe(1)
    expect(guard?.if).toBe("github.base_ref == 'main'")
    // The head ref is attacker-controlled, so it reaches the shell only through env.
    const expression = (value: string) => `\${{ ${value} }}`
    expect(guard?.env).toEqual({
      HEAD_REF: expression('github.head_ref'),
      HEAD_REPOSITORY: expression('github.event.pull_request.head.repo.full_name')
    })
    expect(guard?.run).toContain(
      '[ "$HEAD_REPOSITORY" = "$GITHUB_REPOSITORY" ] && { [ "$HEAD_REF" = "staging" ] || [[ "$HEAD_REF" == hotfix-* ]]; }'
    )
    // Inactive only until the staging branch exists (the switch to the promotion flow).
    expect(guard?.run).toContain('git ls-remote --exit-code --heads origin staging')
    expect(guard?.run).toContain('exit 1')
  })

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
    expect(stepRuns).toContain('pnpm test:d1')
    expect(stepRuns).toContain('pnpm lint:forbidden-links')
    const biomeStep = stepRuns?.find(run => run?.includes('pnpm exec biome check'))
    // Against the pull request's own base: staging for changes, main for promotions.
    expect(biomeStep).toContain(
      'git diff --name-only --diff-filter=ACMR -z "origin/$GITHUB_BASE_REF...HEAD"'
    )
    expect(biomeStep).toContain(
      `pnpm exec biome check --no-errors-on-unmatched "\${changed_files[@]}"`
    )
    expect(biomeStep).toContain(`if ((\${#changed_files[@]} == 0)); then`)
    expect(biomeStep).toContain('No Biome-supported files changed; skipping.')
    expect(stepRuns).not.toContain('pnpm db:migrate:local')
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
    expect(workflow.jobs.e2e['runs-on']).toBe('ubuntu-latest')
  })

  it('installs Playwright browsers without sudo-only system dependency escalation', () => {
    const workflow = loadWorkflow()
    const e2eJob = workflow.jobs.e2e
    const stepRuns = e2eJob.steps?.map(step => step.run).filter(Boolean)

    expect(stepRuns).toContain('pnpm --filter e2e test:install')
    expect(stepRuns).toContain('pnpm test:e2e')
    expect(stepRuns).not.toContain('npx playwright install --with-deps')
  })
})
