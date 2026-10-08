import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { githubHostedRunner, routedRunsOn } from './ci-runners'
import { stepsForProfile } from './harness/runner'
import { project } from './project'
import { hotfixBranch } from './staging-verification'

const repository = project.repository

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
  it('reviews pull requests into staging (the base branch) and main (hotfixes)', () => {
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

  it('accepts pull requests into main only from a hotfix branch of this repository', () => {
    const workflow = loadWorkflow()
    const steps = workflow.jobs.validate.steps ?? []
    const guard = steps.find(step => step.run?.includes('it accepts only hotfix-* pull requests'))

    expect(steps.indexOf(guard as WorkflowStep)).toBe(1)
    expect(guard?.if).toBe("github.base_ref == 'main'")
    // The head ref is attacker-controlled, so it reaches the shell only through env.
    const expression = (value: string) => `\${{ ${value} }}`
    expect(guard?.env).toEqual({
      HEAD_REF: expression('github.head_ref'),
      HEAD_REPOSITORY: expression('github.event.pull_request.head.repo.full_name')
    })
    // The same hotfix branch names the release script's hotfix check accepts.
    expect(guard?.run).toContain(`[[ "$HEAD_REF" =~ ${hotfixBranch.source} ]]`)
    expect(guard?.run).toContain('git ls-remote --exit-code origin refs/heads/staging')
  })

  it('runs the head-branch guard exactly, failing closed when the branch list is unavailable', () => {
    const steps = loadWorkflow().jobs.validate.steps ?? []
    const guard = String(steps.find(step => step.name?.startsWith('Require a hotfix'))?.run)
    const exact = 'abc123\trefs/heads/staging\n'
    // [ls-remote exit status, ls-remote output, head ref, head repository, expected exit]
    const cases: Array<[number, string, string, string, number]> = [
      // Inactive only until the staging branch exists (the switch to the promotion flow).
      [2, '', 'issue-46-x', repository, 0],
      // A network or auth failure never reads as "no staging branch".
      [128, '', 'staging', repository, 1],
      // ls-remote tail-matches patterns; only refs/heads/staging itself counts.
      [0, 'abc123\trefs/heads/x/staging\n', 'issue-46-x', repository, 0],
      // Promotions fast-forward main without a pull request (#171).
      [0, exact, 'staging', repository, 1],
      [0, exact, 'hotfix-12-search', repository, 0],
      [0, exact, 'issue-46-x', repository, 1],
      [0, exact, 'x/staging', repository, 1],
      [0, exact, 'staging-2', repository, 1],
      [0, exact, 'hotfix-a/b', repository, 1],
      [0, exact, 'hotfix-12-search', 'someone/best.serp.co', 1]
    ]
    for (const [status, output, headRef, headRepository, expected] of cases) {
      // A shell function stands in for the git binary, so nothing reaches the network.
      const stub = `git() { printf '%s' "$LS_OUTPUT"; return "$LS_STATUS"; }\n`
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', stub + guard], {
        encoding: 'utf8',
        env: {
          GITHUB_REPOSITORY: repository,
          HEAD_REF: headRef,
          HEAD_REPOSITORY: headRepository,
          LS_OUTPUT: output,
          LS_STATUS: String(status),
          NODE_ENV: 'test',
          PATH: process.env.PATH
        }
      })
      expect(result.status, `${status} ${headRef} ${headRepository}: ${result.stdout}`).toBe(
        expected
      )
    }
  })

  it('grants only read access to repository contents', () => {
    expect(loadWorkflow().permissions).toEqual({ contents: 'read' })
  })

  it('validates the active Worker and D1 contracts without touching a database', () => {
    const workflow = loadWorkflow()
    const validateJob = workflow.jobs.validate
    const stepRuns = validateJob.steps?.map(step => step.run).filter(Boolean)
    const checkoutStep = validateJob.steps?.find(step => step.uses === 'actions/checkout@v7')

    expect(validateJob['runs-on']).toBe(routedRunsOn)
    expect(checkoutStep?.with?.['fetch-depth']).toBe(0)
    // The finish gate (#179): the harness's full profile, so CI and a local run agree.
    expect(stepRuns).toContain('pnpm check')
    const scripts = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts
    expect(scripts.check).toBe('pnpm tsx scripts/harness/runner.ts full')
    expect(scripts.lint).toBe('biome check . && pnpm lint:forbidden-links')
    expect(stepsForProfile('full').map(step => step.name)).toEqual(
      expect.arrayContaining([
        'documentation health',
        'D1 contracts',
        'lint',
        'repository tests',
        'Cloudflare configuration'
      ])
    )
    expect(stepRuns).not.toContain('pnpm db:migrate:local')
    expect(stepRuns).not.toContain('pnpm worker:deploy:production')
    expect(stepRuns).not.toContain('pnpm typecheck')
    expect(stepRuns).not.toContain('pnpm test')
  })

  it('runs PR typecheck and unit tests as separate jobs', () => {
    const workflow = loadWorkflow()
    const typecheckJob = workflow.jobs.typecheck
    const testJob = workflow.jobs.test

    expect(typecheckJob.steps?.map(step => step.run)).toContain('pnpm typecheck')
    expect(testJob.steps?.map(step => step.run)).toContain('pnpm test')
    expect(typecheckJob.needs).toBeUndefined()
    expect(testJob.needs).toBeUndefined()
  })

  it('routes every check but E2E through CI_RUNNER_LABELS, behind the fork guard', () => {
    const workflow = loadWorkflow()
    const source = readFileSync(resolve(process.cwd(), '.github/workflows/pr-review.yml'), 'utf8')

    for (const job of ['validate', 'typecheck', 'test', 'worker-build']) {
      expect(workflow.jobs[job]?.['runs-on'], job).toBe(routedRunsOn)
    }
    // E2E installs Playwright browsers: GitHub-hosted, whatever the variable says.
    expect(workflow.jobs.e2e['runs-on']).toBe(githubHostedRunner)
    expect(source).not.toMatch(/self-hosted/u)
  })

  it('installs Playwright browsers without sudo-only system dependency escalation', () => {
    const workflow = loadWorkflow()
    const e2eJob = workflow.jobs.e2e
    const stepRuns = e2eJob.steps?.map(step => step.run).filter(Boolean)

    expect(stepRuns).toContain('pnpm --filter web test:install')
    expect(stepRuns).toContain('pnpm test:e2e')
    expect(stepRuns).not.toContain('npx playwright install --with-deps')
  })
})
