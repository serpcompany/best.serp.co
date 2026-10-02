import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { releaseAuthorizations } from './cloudflare-release'
import { buildReviewIssue } from './d1-submission-notifier'
import { project } from './project'
import { stagingWorkflow } from './staging-verification'

interface WorkflowStep {
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string | number>
}

interface WorkflowJob {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  env?: Record<string, string>
  environment?: string | { name: string; url?: string }
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
}

interface WorkflowInput {
  default?: string
  options?: string[]
  required?: boolean
  type?: string
}

interface WorkflowDefinition {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, WorkflowJob>
  name?: string
  on: {
    push?: { branches?: string[]; paths?: string[] }
    schedule?: Array<{ cron: string }>
    workflow_dispatch?: { inputs?: Record<string, WorkflowInput> } | null
  } & Record<string, unknown>
  permissions?: Record<string, string>
}

const workflowDirectory = resolve('.github/workflows')
const packageScripts = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
).scripts

function loadWorkflow(file: string): WorkflowDefinition {
  return yaml.load(readFileSync(resolve(workflowDirectory, file), 'utf8')) as WorkflowDefinition
}

function allWorkflows(): Array<[string, WorkflowDefinition]> {
  return readdirSync(workflowDirectory)
    .filter(file => file.endsWith('.yml'))
    .map(file => [file, loadWorkflow(file)])
}

function environmentName(job: WorkflowJob): string | undefined {
  return typeof job.environment === 'string' ? job.environment : job.environment?.name
}

function runs(job: WorkflowJob): string[] {
  return (job.steps ?? []).map(step => step.run).filter((run): run is string => Boolean(run))
}

function stepRunning(job: WorkflowJob, command: string): WorkflowStep {
  const step = job.steps?.find(candidate => candidate.run?.includes(command))
  if (!step) throw new Error(`No step runs ${command}.`)
  return step
}

function stepIndex(job: WorkflowJob, command: string): number {
  return (job.steps ?? []).findIndex(step => step.run?.includes(command))
}

/** Environment names a script reads through its required(...) guards. */
function requiredScriptEnvironment(script: string): string[] {
  const source = readFileSync(resolve(script), 'utf8')
  return [...source.matchAll(/require(?:d|Environment)\(env, '([A-Z_]+)'\)/gu)]
    .map(match => match[1] as string)
    .sort()
}

const expression = (value: string) => `\${{ ${value} }}`
const secret = (name: string) => expression(`secrets.${name}`)
const credentialsGate = "steps.credentials.outputs.configured == 'true'"
const productionDispatchWorkflows = [
  'approve-d1-submission.yml',
  'bootstrap-production-d1.yml',
  'deploy-production.yml',
  'publish-d1.yml'
]
const newWorkflows = [
  ...productionDispatchWorkflows,
  'deploy-staging.yml',
  'notify-d1-submissions.yml'
]

describe('staging deploy workflow', () => {
  const workflow = loadWorkflow('deploy-staging.yml')
  const job = workflow.jobs.deploy as WorkflowJob

  it('deploys every reviewed main push (and on demand) to staging only, one run at a time', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'best-serp-co-staging',
      'cancel-in-progress': false
    })
    expect(Object.keys(workflow.jobs)).toEqual(['deploy'])
    expect(job.if).toBe("github.ref == 'refs/heads/main'")
    expect(job.environment).toEqual({ name: 'staging', url: project.remote.staging.origin })
    expect(job.env).toEqual({ STAGING_ORIGIN: project.remote.staging.origin })
    expect(JSON.stringify(workflow)).not.toMatch(/production/u)
  })

  it('validates, migrates, deploys, then gates and smoke-tests the deployed Worker', () => {
    const commands = [
      'pnpm harness:fast',
      'pnpm worker:build',
      'pnpm tsx scripts/cloudflare-release.ts migrate staging',
      'pnpm tsx scripts/cloudflare-release.ts deploy staging',
      'pnpm tsx scripts/d1-preview-http-gates.ts staging "$STAGING_ORIGIN"',
      'pnpm --filter e2e test:install',
      'pnpm --filter e2e test:e2e:smoke'
    ]
    expect(runs(job).slice(1)).toEqual(commands)
    expect(stepRunning(job, 'test:e2e:smoke').env).toEqual({
      PLAYWRIGHT_BASE_URL: expression('env.STAGING_ORIGIN'),
      PLAYWRIGHT_EXTERNAL_SERVER: '1'
    })
    const evidence = job.steps?.find(step => step.uses === 'actions/upload-artifact@v7')
    expect(evidence?.if).toBe(`always() && ${credentialsGate}`)
    expect(String(evidence?.with?.path)).toContain('apps/e2e/playwright-report/')
  })

  it('names the steps production requires as proof that staging verified a commit', () => {
    expect(workflow.name).toBe(stagingWorkflow.name)
    expect(stagingWorkflow.file).toBe('deploy-staging.yml')
    const proof: Record<(typeof stagingWorkflow.requiredSteps)[number], string> = {
      'Apply staging D1 migrations': 'pnpm tsx scripts/cloudflare-release.ts migrate staging',
      'Deploy staging Worker': 'pnpm tsx scripts/cloudflare-release.ts deploy staging',
      'Run staging HTTP gates': 'pnpm tsx scripts/d1-preview-http-gates.ts staging',
      'Run Playwright smoke against staging': 'pnpm --filter e2e test:e2e:smoke'
    }
    expect(Object.keys(proof)).toEqual([...stagingWorkflow.requiredSteps])
    for (const [name, command] of Object.entries(proof)) {
      const steps = (job.steps ?? []).filter(step => step.name === name)
      expect(steps, name).toHaveLength(1)
      expect(steps[0]?.run, name).toContain(command)
    }
  })

  it('runs the same staging migration as pnpm db:migrate:staging', () => {
    expect(packageScripts['db:migrate:staging']).toBe(
      stepRunning(job, 'cloudflare-release.ts migrate staging').run
    )
  })

  it('skips cleanly, without failing main, until Cloudflare credentials exist', () => {
    const [check, ...rest] = job.steps ?? []
    expect(check?.id).toBe('credentials')
    expect(check?.if).toBeUndefined()
    expect(check?.run).toContain('echo "configured=false" >> "$GITHUB_OUTPUT"')
    expect(check?.run).toContain('::notice title=Staging deploy skipped::')
    expect(check?.run).not.toMatch(/exit 1/u)
    for (const step of rest) {
      expect(step.if, step.name).toContain(credentialsGate)
    }
  })
})

describe('production deploy workflow', () => {
  const workflow = loadWorkflow('deploy-production.yml')
  const release = workflow.jobs.release as WorkflowJob
  const databaseStep = "inputs.release_mode == 'database-and-worker'"

  it('is a typed-confirmation dispatch from main with an explicit release mode', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {}
    expect(Object.keys(inputs).sort()).toEqual(['confirmation', 'release_mode'])
    expect(inputs.release_mode).toMatchObject({
      default: 'worker-only',
      options: ['worker-only', 'database-and-worker'],
      type: 'choice'
    })
    const authorize = runs(workflow.jobs.authorize as WorkflowJob).join('\n')
    expect(authorize).toContain('"$GITHUB_REF" != "refs/heads/main"')
    expect(authorize).toContain(`"$CONFIRMATION" != "${project.confirmation.deploy}"`)
    expect(release.needs).toEqual(['authorize'])
    expect(release.environment).toEqual({ name: 'production', url: project.publicUrl })
  })

  it('releases only a commit Deploy Staging verified, before asking for reviewer approval', () => {
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    const authorize = workflow.jobs.authorize as WorkflowJob
    expect(authorize.environment).toBeUndefined()
    const verify = stepRunning(authorize, 'pnpm tsx scripts/staging-verification.ts')
    expect(verify.run).toBe('pnpm tsx scripts/staging-verification.ts')
    expect(verify.env).toEqual({ GITHUB_TOKEN: expression('github.token') })
    expect(stepIndex(authorize, 'staging-verification.ts')).toBeGreaterThan(
      stepIndex(authorize, '"$CONFIRMATION"')
    )
    // The release script repeats the check before each production migration and Worker deploy.
    for (const command of ['migrate production', 'deploy production']) {
      expect(stepRunning(release, `cloudflare-release.ts ${command}`).env?.GITHUB_TOKEN).toBe(
        expression('github.token')
      )
    }
  })

  it('runs the same production migration as pnpm db:migrate:production', () => {
    expect(packageScripts['db:migrate:production']).toBe(
      stepRunning(release, 'cloudflare-release.ts migrate production').run
    )
  })

  it('backs up and migrates D1 only in database-and-worker mode, then deploys and gates', () => {
    const order = [
      'pnpm harness:fast',
      'pnpm worker:build',
      'cloudflare-release.ts backup production',
      'cloudflare-release.ts migrate production',
      'cloudflare-release.ts deploy production',
      'd1-preview-http-gates.ts production https://best.serp.co'
    ].map(command => stepIndex(release, command))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)

    expect(stepRunning(release, 'backup production').if).toBe(databaseStep)
    expect(stepRunning(release, 'migrate production').if).toBe(databaseStep)
    expect(stepRunning(release, 'deploy production').if).toBeUndefined()
    const backup = release.steps?.find(step => step.uses === 'actions/upload-artifact@v7')
    expect(backup?.if).toBe(databaseStep)
    expect(backup?.with).toMatchObject({
      'if-no-files-found': 'error',
      path: `${expression('runner.temp')}/d1-backup/`,
      'retention-days': 30
    })
    expect(stepRunning(release, 'backup production').run).toContain(
      '--output "$RUNNER_TEMP/d1-backup/'
    )
  })

  it('gates best.serp.co once the Worker serves it, and the workers.dev review origin before', () => {
    const gates = stepRunning(release, 'd1-preview-http-gates.ts')
    expect(gates.run).toContain('if [ "$server" = "GitHub.com" ]; then')
    expect(gates.run).toContain('d1-preview-http-gates.ts staging "$PRODUCTION_REVIEW_ORIGIN"')
    expect(gates.env?.PRODUCTION_REVIEW_ORIGIN).toBe(
      'https://best-serp-co-production.serpcompany.workers.dev'
    )
  })
})

describe('production D1 bootstrap workflow', () => {
  const workflow = loadWorkflow('bootstrap-production-d1.yml')
  const bootstrap = workflow.jobs.bootstrap as WorkflowJob

  it('imports into empty production D1 and verifies it against the parity report', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {})).toEqual(['confirmation'])
    expect(runs(workflow.jobs.authorize as WorkflowJob).join('\n')).toContain(
      `"$CONFIRMATION" != "${project.confirmation.bootstrap}"`
    )
    expect(environmentName(bootstrap)).toBe('production')
    expect(runs(bootstrap).slice(1)).toEqual([
      'pnpm test:d1',
      'pnpm tsx scripts/cloudflare-release.ts import production',
      'pnpm tsx scripts/cloudflare-release.ts verify-import production'
    ])
    expect(JSON.stringify(workflow)).not.toMatch(/deploy production|opennextjs-cloudflare/u)
  })

  it('is the documented one-time exception to staging before production', () => {
    expect(releaseAuthorizations['bootstrap-production-d1.yml']?.requireVerifiedStaging).toEqual([])
    expect(readFileSync(resolve(workflowDirectory, 'bootstrap-production-d1.yml'), 'utf8')).toMatch(
      /one documented exception to staging before\n# production/u
    )
    expect(readFileSync(resolve('docs/DEPLOY_RUNBOOK.md'), 'utf8')).toContain(
      'The production bootstrap is the one exception'
    )
  })
})

describe('recreated D1 operation workflows', () => {
  it('names the exact workflow files the script guards require', () => {
    const guards: Array<[string, string]> = [
      ['scripts/d1-submission-approver.ts', 'approve-d1-submission.yml'],
      ['scripts/d1-submission-notifier.ts', 'notify-d1-submissions.yml'],
      ['scripts/d1-remote-publisher.ts', 'publish-d1.yml']
    ]
    for (const [script, workflow] of guards) {
      expect(readFileSync(resolve(script), 'utf8')).toContain(`/.github/workflows/${workflow}@`)
      expect(existsSync(resolve(workflowDirectory, workflow)), workflow).toBe(true)
    }
    for (const workflow of Object.keys(releaseAuthorizations)) {
      expect(existsSync(resolve(workflowDirectory, workflow)), workflow).toBe(true)
    }
  })

  it('satisfies each script environment contract against production D1 only', () => {
    const contracts: Array<[string, string, string, string]> = [
      [
        'approve-d1-submission.yml',
        'review',
        'pnpm db:approve:production',
        'scripts/d1-submission-approver.ts'
      ],
      [
        'notify-d1-submissions.yml',
        'notify',
        'pnpm db:notify:production',
        'scripts/d1-submission-notifier.ts'
      ],
      ['publish-d1.yml', 'publish', 'pnpm db:publish:production', 'scripts/d1-remote-publisher.ts']
    ]
    for (const [file, jobName, command, script] of contracts) {
      const step = stepRunning(loadWorkflow(file).jobs[jobName] as WorkflowJob, command)
      const provided = Object.keys(step.env ?? {})
      expect(requiredScriptEnvironment(script).length).toBeGreaterThan(0)
      for (const name of requiredScriptEnvironment(script)) {
        expect(provided, `${file} ${name}`).toContain(name)
      }
      expect(step.env?.CLOUDFLARE_D1_DATABASE_ID).toBe(project.remote.production.databaseId)
      expect(step.env?.CLOUDFLARE_API_TOKEN).toBe(secret('CLOUDFLARE_API_TOKEN'))
      expect(step.env?.CLOUDFLARE_ACCOUNT_ID).toBe(secret('CLOUDFLARE_ACCOUNT_ID'))
    }
    const publish = loadWorkflow('publish-d1.yml').jobs.publish as WorkflowJob
    expect(stepRunning(publish, 'db:publish:production').env?.D1_PUBLICATION_CONFIRM).toBe(
      expression('inputs.confirmation')
    )
    expect(stepRunning(publish, 'db:publish:production').run).toBe(
      'pnpm db:publish:production -- "$MANIFEST_PATH"'
    )
    const review = loadWorkflow('approve-d1-submission.yml').jobs.review as WorkflowJob
    expect(stepRunning(review, 'db:approve:production').env?.D1_SUBMISSION_APPROVAL_CONFIRM).toBe(
      expression('inputs.confirmation')
    )
    expect(stepRunning(review, 'db:approve:production').run).toBe(
      'pnpm db:approve:production -- "$SUBMISSION_ID" "$DECISION"'
    )
  })

  it('requires the script confirmations and backs up D1 before approval or publication', () => {
    const cases: Array<[string, string, string, string]> = [
      [
        'approve-d1-submission.yml',
        'review',
        project.confirmation.submission,
        'db:approve:production'
      ],
      ['publish-d1.yml', 'publish', project.confirmation.publish, 'db:publish:production']
    ]
    for (const [file, jobName, confirmation, command] of cases) {
      const workflow = loadWorkflow(file)
      const job = workflow.jobs[jobName] as WorkflowJob
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      expect(runs(workflow.jobs.authorize as WorkflowJob).join('\n')).toContain(
        `"$CONFIRMATION" != "${confirmation}"`
      )
      const backup = stepIndex(job, 'cloudflare-release.ts backup production --output')
      const upload = (job.steps ?? []).findIndex(step => step.uses === 'actions/upload-artifact@v7')
      expect(backup).toBeGreaterThan(stepIndex(job, 'pnpm test:d1'))
      expect(upload).toBe(backup + 1)
      expect(stepIndex(job, command)).toBeGreaterThan(upload)
      expect(job.steps?.[upload]?.with).toMatchObject({
        'if-no-files-found': 'error',
        'retention-days': 30
      })
    }
    const publishAuthorize = runs(loadWorkflow('publish-d1.yml').jobs.authorize as WorkflowJob)
    expect(publishAuthorize.join('\n')).toContain('^d1/publications/[A-Za-z0-9._-]+\\.ya?ml$')
    const approveAuthorize = runs(
      loadWorkflow('approve-d1-submission.yml').jobs.authorize as WorkflowJob
    )
    expect(approveAuthorize.join('\n')).toContain('^[0-9a-fA-F-]{36}$')
  })

  it('closes the exact review issue the notifier opened', () => {
    const submissionId = '123e4567-e89b-12d3-a456-426614174000'
    const { body } = buildReviewIssue({
      faqs: [],
      previewUrl: `${project.publicUrl}/admin/submissions/${submissionId}/preview/x/`,
      resources: [],
      submission: {
        badge_verified_at: '2026-01-01T00:00:00.000Z',
        category_slug: 'video-downloaders',
        content: 'Content',
        created_at: '2026-01-01T00:00:00.000Z',
        description: 'Description',
        id: submissionId,
        logo_url: 'https://example.com/logo.png',
        name: 'Example',
        slug: 'example',
        verification_attempts: 1,
        video_url: null,
        website: 'https://example.com/'
      }
    })
    const review = loadWorkflow('approve-d1-submission.yml').jobs.review as WorkflowJob
    expect(review.permissions).toEqual({ contents: 'read', issues: 'write' })
    const script = String(
      review.steps?.find(step => step.uses === 'actions/github-script@v9')?.with?.script
    )
    const marker = script.match(/const marker = `([^`]+)`/u)?.[1]
    expect(marker).toBeDefined()
    expect(body).toContain(marker?.replace(/\$\{process\.env\.SUBMISSION_ID\}/u, submissionId))
  })

  it('notifies on a 15-minute schedule and skips until configured', () => {
    const workflow = loadWorkflow('notify-d1-submissions.yml')
    const notify = workflow.jobs.notify as WorkflowJob
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(workflow.on.schedule).toEqual([{ cron: '*/15 * * * *' }])
    expect(notify.if).toBe(
      "github.ref == 'refs/heads/main' && vars.SUBMISSION_REVIEWER_GITHUB_LOGIN != ''"
    )
    // The production environment requires reviewer approval, which a schedule cannot give.
    expect(environmentName(notify)).toBe('production-notifier')
    expect(workflow.concurrency?.group).toBe('best-serp-co-production-notifier')
    expect(notify.permissions).toEqual({ contents: 'read', issues: 'write' })
    const [check, ...rest] = notify.steps ?? []
    expect(check?.id).toBe('credentials')
    expect(check?.run).not.toMatch(/exit 1/u)
    for (const step of rest) expect(step.if, step.name).toBe(credentialsGate)
    expect(stepRunning(notify, 'db:notify:production').env).toMatchObject({
      GITHUB_TOKEN: expression('github.token'),
      SUBMISSION_REVIEWER_GITHUB_LOGIN: expression('vars.SUBMISSION_REVIEWER_GITHUB_LOGIN')
    })
  })
})

describe('protected deployment boundaries', () => {
  it('gates every production job behind an unprivileged ref and confirmation check', () => {
    for (const file of productionDispatchWorkflows) {
      const workflow = loadWorkflow(file)
      expect(Object.keys(workflow.on), file).toEqual(['workflow_dispatch'])
      expect(workflow.concurrency, file).toEqual({
        group: 'best-serp-co-production',
        'cancel-in-progress': false
      })
      const authorize = workflow.jobs.authorize as WorkflowJob
      expect(authorize.environment, file).toBeUndefined()
      expect(JSON.stringify(authorize), file).not.toContain('secrets.')
      expect(runs(authorize).join('\n'), file).toContain('"$GITHUB_REF" != "refs/heads/main"')
      const privileged = Object.entries(workflow.jobs).filter(([name]) => name !== 'authorize')
      expect(privileged).toHaveLength(1)
      for (const [name, job] of privileged) {
        expect(job.needs, `${file}:${name}`).toEqual(['authorize'])
        expect(environmentName(job), `${file}:${name}`).toBe('production')
        const [check] = job.steps ?? []
        expect(check?.run, `${file}:${name}`).toContain('exit 1')
        expect(check?.run, `${file}:${name}`).toContain('CLOUDFLARE_API_TOKEN')
      }
    }
  })

  it('never mutates production outside a manual dispatch', () => {
    const productionMutation =
      /cloudflare-release\.ts (?:backup|migrate|import|deploy) production|db:(?:migrate|approve|publish):production|opennextjs-cloudflare deploy/u
    for (const [file, workflow] of allWorkflows()) {
      const triggers = Object.keys(workflow.on)
      const automatic = triggers.some(trigger => trigger !== 'workflow_dispatch')
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (!automatic) continue
        expect(environmentName(job), `${file}:${name}`).not.toBe('production')
        expect(runs(job).join('\n'), `${file}:${name}`).not.toMatch(productionMutation)
      }
    }
  })

  it('keeps Cloudflare credentials out of pull-request workflows and third-party actions', () => {
    for (const [file, workflow] of allWorkflows()) {
      const source = readFileSync(resolve(workflowDirectory, file), 'utf8')
      if (Object.keys(workflow.on).some(trigger => trigger.startsWith('pull_request'))) {
        expect(source, file).not.toContain('CLOUDFLARE')
      }
    }
    for (const file of newWorkflows) {
      const workflow = loadWorkflow(file)
      expect(workflow.permissions, file).toEqual(
        file === 'deploy-production.yml'
          ? { actions: 'read', contents: 'read' }
          : { contents: 'read' }
      )
      for (const job of Object.values(workflow.jobs)) {
        expect(JSON.stringify(job.env ?? {}), file).not.toContain('secrets.')
        for (const step of job.steps ?? []) {
          if (step.uses)
            expect(JSON.stringify(step), `${file}:${step.name}`).not.toContain('secrets.')
        }
      }
    }
  })

  it('passes dispatch inputs to shell steps only through environment variables', () => {
    for (const file of newWorkflows) {
      for (const job of Object.values(loadWorkflow(file).jobs)) {
        for (const run of runs(job)) {
          expect(run, file).not.toMatch(/\$\{\{\s*(?:inputs|github\.event\.inputs)\./u)
        }
      }
    }
  })

  it('runs these workflow and release contracts in the repository and D1 test suites', () => {
    expect(packageScripts['test:repo']).toContain('scripts/deploy-workflows.test.ts')
    expect(packageScripts['test:d1']).toContain('scripts/cloudflare-release.test.ts')
    expect(packageScripts['test:d1']).toContain('scripts/staging-verification.test.ts')
  })

  it('names every database command after its target, routing remote mutations through the guard', () => {
    expect(Object.keys(packageScripts).filter(name => name.startsWith('d1:'))).toEqual([])
    for (const environment of ['staging', 'production'] as const) {
      expect(packageScripts[`db:migrate:${environment}`]).toBe(
        `pnpm tsx scripts/cloudflare-release.ts migrate ${environment}`
      )
      expect(packageScripts[`db:migrations:list:${environment}`]).toBe(
        `pnpm tsx scripts/cloudflare-release.ts list-migrations ${environment}`
      )
    }
    expect(packageScripts['db:migrate']).toBeUndefined()
    expect(
      Object.entries(packageScripts)
        .filter(([name]) => name.startsWith('db:') && name.endsWith(':production'))
        .map(([, command]) => command.split(' ').slice(0, 3).join(' '))
    ).toEqual([
      'pnpm tsx scripts/cloudflare-release.ts',
      'pnpm tsx scripts/cloudflare-release.ts',
      'pnpm tsx scripts/d1-remote-publisher.ts',
      'pnpm tsx scripts/d1-submission-approver.ts',
      'pnpm tsx scripts/d1-submission-notifier.ts'
    ])
  })

  it('passes each production mutation the confirmation the release script requires', () => {
    for (const [file, authorization] of Object.entries(releaseAuthorizations)) {
      const workflow = loadWorkflow(file)
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          const match = step.run?.match(/cloudflare-release\.ts ([a-z-]+) (staging|production)/u)
          if (!match) continue
          const [, command, environment] = match
          expect(environment, `${file}: ${step.name}`).toBe(authorization.environment)
          if (command === 'check-database' || command === 'verify-import') continue
          expect(authorization.commands, `${file}: ${step.name}`).toContain(command)
          if (authorization.confirmation) {
            expect(step.env?.RELEASE_CONFIRM, `${file}: ${step.name}`).toBe(
              expression('inputs.confirmation')
            )
          }
        }
      }
    }
  })
})
