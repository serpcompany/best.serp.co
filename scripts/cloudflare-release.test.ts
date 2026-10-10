import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertDatabaseReady,
  authorizeRelease,
  bookmarkSummary,
  checkDatabase,
  type D1Row,
  type D1Target,
  deployWorker,
  type ProcessRunner,
  parseReleaseArguments,
  parseTimeTravelBookmark,
  parseWranglerRows,
  type ReleaseCommand,
  readMigrationLedger,
  readOnlyCommands,
  recordTimeTravelBookmark,
  releaseAuthorizations,
  releaseCommands,
  requireVerifiedStaging,
  runRelease,
  timeTravelRestoreCommand,
  validateRemoteConfig,
  wranglerD1
} from './cloudflare-release'
import { freshMigrationNames } from './d1-drizzle-local'
import { project } from './project'
import { type FetchLike, stagingWorkflow } from './staging-verification'

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'best-serp-co-release-'))
afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }))

const at = '2026-01-01T00:00:00.000Z'
const publicationChecksum = 'b'.repeat(64)

/** The singleton catalog publication a deployed environment carries. */
function publish(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO publication_state (id, version, manifest_id, checksum, published_at) VALUES (1, 1, 'fixture-v1', '${publicationChecksum}', '${at}')`
  )
}

/** A D1 target backed by in-memory SQLite that records the operations Wrangler would run. */
function sqliteD1(database = new DatabaseSync(':memory:')) {
  const target: D1Target = {
    applyMigrations() {
      database.exec(
        'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
      )
      const applied = new Set(
        database
          .prepare('SELECT name FROM d1_migrations')
          .all()
          .map(row => String(row.name))
      )
      for (const name of freshMigrationNames()) {
        if (applied.has(name)) continue
        database.exec(readFileSync(resolve('apps/web/drizzle', name), 'utf8'))
        database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
      }
    },
    async query(sql) {
      return database.prepare(sql).all() as D1Row[]
    }
  }
  return { database, target }
}

const sha = '0123456789abcdef0123456789abcdef01234567'
const tree = 'a'.repeat(40)

/** The Actions environment of `workflow` on its own release branch, dispatched by default. */
function workflowEnv(
  workflow: string,
  confirmation?: string | null,
  event = 'workflow_dispatch'
): Partial<NodeJS.ProcessEnv> {
  const branch = releaseAuthorizations[workflow]?.branch ?? 'main'
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: event,
    GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/${workflow}@refs/heads/${branch}`,
    ...(confirmation ? { RELEASE_CONFIRM: confirmation } : {})
  }
}

const cleanGit = (args: string[]): string => (args[0] === 'status' ? '' : `${sha}\n`)
const mutatingCommands = releaseCommands.filter(command => !readOnlyCommands.has(command))

/** A newer commit with different source, for a `main` that has moved on. */
const newerSha = '2'.repeat(40)
const newerTree = 'b'.repeat(40)

/** A merged pull request into main, as the closed-pulls listing reports it. */
function mergedPull(headRef: string, mergeCommit = sha) {
  return {
    base: { ref: 'main' },
    head: { ref: headRef, repo: { full_name: project.repository } },
    html_url: 'https://github.com/pull/9',
    merge_commit_sha: mergeCommit,
    merged_at: '2026-10-05T00:00:00Z',
    number: 9
  }
}

/**
 * A fake GitHub API for the release checks, recording every request path. When `verified`, a
 * push run of Deploy Staging on `staging` verified `stagingSha` (the released commit itself by
 * default, or a staging commit with the same tree, as a promotion merge commit would carry).
 * `main` points at `mainHead` (the released commit by default), and `pulls` are the closed
 * pull requests into main.
 */
function stagingApi(
  verified: boolean,
  options: { mainHead?: string; pulls?: unknown[]; stagingSha?: string } = {}
) {
  const { mainHead = sha, pulls = [], stagingSha = sha } = options
  const requests: string[] = []
  const fetch: FetchLike = async url => {
    const { pathname, searchParams } = new URL(url)
    requests.push(pathname)
    const headSha = searchParams.get('head_sha')
    const runs = verified
      ? [
          {
            conclusion: 'success',
            event: 'push',
            head_branch: 'staging',
            head_commit: { id: stagingSha, tree_id: tree },
            head_sha: stagingSha,
            html_url: 'https://github.com/run/1',
            id: 1,
            path: '.github/workflows/web.yml',
            run_attempt: 1,
            status: 'completed'
          }
        ]
      : []
    const body = pathname.includes('/git/commits/')
      ? { tree: { sha: pathname.endsWith(newerSha) ? newerTree : tree } }
      : pathname.endsWith('/git/ref/heads/main')
        ? { object: { sha: mainHead, type: 'commit' } }
        : pathname.endsWith('/pulls')
          ? pulls
          : pathname.includes('/workflows/')
            ? { workflow_runs: runs.filter(run => !headSha || run.head_sha === headSha) }
            : {
                jobs: [
                  {
                    conclusion: 'success',
                    steps: stagingWorkflow.requiredSteps.map(name => ({
                      conclusion: 'success',
                      name
                    }))
                  }
                ]
              }
    return { json: async () => body, ok: true, status: 200 }
  }
  return { fetch, requests }
}

describe('release authorization', () => {
  it('allows read-only checks without a workflow and refuses mutations outside Actions', () => {
    const git = () => {
      throw new Error('read-only commands never inspect the checkout')
    }
    expect([...readOnlyCommands].sort()).toEqual([
      'bookmark',
      'check-database',
      'list-migrations',
      'plan-release'
    ])
    for (const command of readOnlyCommands) {
      expect(() => authorizeRelease(command, 'production', {}, git)).not.toThrow()
    }
    for (const command of mutatingCommands) {
      expect(() => authorizeRelease(command, 'staging', {}, cleanGit)).toThrow(
        'protected GitHub Actions workflow'
      )
    }
  })

  it('binds every mutating command to its owning workflow, environment, and confirmation', () => {
    for (const [workflow, authorization] of Object.entries(releaseAuthorizations)) {
      const other = authorization.environment === 'staging' ? 'production' : 'staging'
      for (const command of mutatingCommands) {
        const env = workflowEnv(workflow, authorization.confirmation)
        if (authorization.commands.includes(command)) {
          expect(() =>
            authorizeRelease(command, authorization.environment, env, cleanGit)
          ).not.toThrow()
          expect(() => authorizeRelease(command, other, env, cleanGit)).toThrow(
            `may not change ${other}`
          )
          if (authorization.confirmation) {
            expect(() =>
              authorizeRelease(
                command,
                authorization.environment,
                { ...env, RELEASE_CONFIRM: 'yes' },
                cleanGit
              )
            ).toThrow(authorization.confirmation)
          }
        } else {
          expect(() => authorizeRelease(command, authorization.environment, env, cleanGit)).toThrow(
            `may not run ${command}`
          )
        }
      }
    }
  })

  it('keeps production behind typed confirmations, with no catalog import (#315)', () => {
    const production = Object.entries(releaseAuthorizations).filter(
      ([, authorization]) => authorization.environment === 'production'
    )
    // The one-time bootstrap (bootstrap-production-d1.yml, `import`) is archived with the v1
    // import: production recovers with D1 Time Travel, never a re-import.
    expect(production.map(([workflow]) => workflow).sort()).toEqual(['deploy-production.yml'])
    expect(releaseCommands).not.toContain('import')
    expect(releaseCommands).not.toContain('verify-import')
    for (const [, authorization] of production) {
      expect(authorization.confirmation).toMatch(/-production$/u)
      // main is production: every production mutation runs from main.
      expect(authorization.branch).toBe('main')
    }
    expect(releaseAuthorizations['web.yml']).toEqual({
      branch: 'staging',
      commands: ['migrate', 'deploy'],
      confirmation: null,
      environment: 'staging',
      events: ['push', 'workflow_dispatch'],
      requireVerifiedStaging: []
    })
    // Only the two deploy workflows run on push; every other remote mutation is a dispatch.
    expect(
      Object.entries(releaseAuthorizations)
        .filter(([, authorization]) => authorization.events.includes('push'))
        .map(([workflow]) => workflow)
    ).toEqual(['web.yml', 'deploy-production.yml'])
    expect(
      Object.entries(releaseAuthorizations)
        .filter(([, authorization]) => authorization.hotfixConfirmation)
        .map(([workflow, authorization]) => [workflow, authorization.hotfixConfirmation])
    ).toEqual([['deploy-production.yml', project.confirmation.hotfix]])
    expect(releaseAuthorizations['deploy-production.yml']?.commands).toEqual(['migrate', 'deploy'])
    // Publication mutates D1 through its own guarded script; it needs no release command,
    // because the bookmark it records first is read-only.
    expect(releaseAuthorizations['publish-d1.yml']).toBeUndefined()
  })

  it('refuses other repositories, branches, workflows, refs, and unreviewed checkouts', () => {
    const env = workflowEnv('deploy-production.yml', project.confirmation.deploy)
    const refuse = (overrides: Partial<NodeJS.ProcessEnv>, git = cleanGit) =>
      expect(() => authorizeRelease('deploy', 'production', { ...env, ...overrides }, git))
    refuse({
      GITHUB_WORKFLOW_REF: 'someone/fork/.github/workflows/deploy-production.yml@refs/heads/main'
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/deploy-production.yml@refs/heads/feature`
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/main-validation.yml@refs/heads/main`
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/deploy-production.yml`
    }).toThrow('not a protected')
    refuse({
      GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/toString@refs/heads/main`
    }).toThrow('not a protected')
    refuse({ GITHUB_REF: 'refs/heads/feature' }).toThrow('reviewed main')
    refuse({ GITHUB_SHA: '' }).toThrow('reviewed main')
    refuse({}, args => (args[0] === 'status' ? '?? stray.txt\n' : sha)).toThrow('clean checkout')
    refuse({}, args => (args[0] === 'status' ? '' : 'f'.repeat(40))).toThrow('GITHUB_SHA')
  })

  it('runs staging releases only from staging and production releases only from main', () => {
    const staging = workflowEnv('web.yml', null, 'push')
    expect(staging.GITHUB_REF).toBe('refs/heads/staging')
    expect(() => authorizeRelease('migrate', 'staging', staging, cleanGit)).not.toThrow()
    // The staging workflow loaded from main (the old flow) or a feature branch is not protected.
    for (const branch of ['main', 'feature']) {
      expect(() =>
        authorizeRelease(
          'deploy',
          'staging',
          {
            ...staging,
            GITHUB_REF: `refs/heads/${branch}`,
            GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/web.yml@refs/heads/${branch}`
          },
          cleanGit
        )
      ).toThrow('not a protected')
    }
    expect(() =>
      authorizeRelease('deploy', 'staging', { ...staging, GITHUB_REF: 'refs/heads/main' }, cleanGit)
    ).toThrow('reviewed staging')
    // A production workflow loaded from staging is not protected either.
    for (const workflow of Object.keys(releaseAuthorizations).filter(
      file => releaseAuthorizations[file]?.environment === 'production'
    )) {
      const authorization = releaseAuthorizations[workflow]
      const command = authorization?.commands[0] ?? 'deploy'
      expect(
        () =>
          authorizeRelease(
            command,
            'production',
            {
              ...workflowEnv(workflow, authorization?.confirmation),
              GITHUB_REF: 'refs/heads/staging',
              GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/${workflow}@refs/heads/staging`
            },
            cleanGit
          ),
        workflow
      ).toThrow('not a protected')
    }
  })

  it('needs no typed confirmation on a push, and runs only on each workflow’s own events', () => {
    for (const command of ['migrate', 'deploy'] as const) {
      expect(() =>
        authorizeRelease(
          command,
          'production',
          workflowEnv('deploy-production.yml', null, 'push'),
          cleanGit
        )
      ).not.toThrow()
    }
    // A dispatch of the same workflow still needs its confirmation.
    expect(() =>
      authorizeRelease('deploy', 'production', workflowEnv('deploy-production.yml'), cleanGit)
    ).toThrow(project.confirmation.deploy)
    for (const [workflow, authorization] of Object.entries(releaseAuthorizations)) {
      const command = authorization.commands[0] ?? 'deploy'
      for (const event of ['push', 'schedule', 'workflow_run', 'pull_request_target', '']) {
        const env = workflowEnv(workflow, authorization.confirmation, event)
        const run = () => authorizeRelease(command, authorization.environment, env, cleanGit)
        if (authorization.events.some(allowed => allowed === event)) expect(run).not.toThrow()
        else expect(run, `${workflow} ${event}`).toThrow('runs remote commands only on')
      }
    }
  })

  it('accepts the hotfix confirmation only on a deploy-production.yml dispatch', () => {
    const hotfix = workflowEnv('deploy-production.yml', project.confirmation.hotfix)
    for (const command of ['migrate', 'deploy'] as const) {
      expect(() => authorizeRelease(command, 'production', hotfix, cleanGit)).not.toThrow()
    }
    // No other workflow takes it: deploy-production.yml is the only production release workflow.
    expect(
      Object.entries(releaseAuthorizations)
        .filter(([, authorization]) => authorization.hotfixConfirmation !== undefined)
        .map(([workflow]) => workflow)
    ).toEqual(['deploy-production.yml'])
  })
})

describe('staging before production', () => {
  /** A promotion merge commit's second parent: a different commit with the released tree. */
  const stagingSha = '1'.repeat(40)
  const withToken = (env: Partial<NodeJS.ProcessEnv>) => ({ ...env, GITHUB_TOKEN: 'ghs_test' })

  it('requires a verified staging run for every production migration and deploy', async () => {
    expect(
      Object.entries(releaseAuthorizations).flatMap(([workflow, authorization]) =>
        authorization.requireVerifiedStaging.map(command => `${workflow} ${command}`)
      )
    ).toEqual(['deploy-production.yml migrate', 'deploy-production.yml deploy'])
    for (const [workflow, authorization] of Object.entries(releaseAuthorizations)) {
      expect(
        authorization.requireVerifiedStaging.every(command =>
          authorization.commands.includes(command)
        ),
        workflow
      ).toBe(true)
      // Any workflow that may apply migrations to production or deploy its Worker must prove
      // staging first.
      if (authorization.environment === 'production') {
        for (const command of ['migrate', 'deploy'] as const) {
          if (authorization.commands.includes(command)) {
            expect(authorization.requireVerifiedStaging, `${workflow} ${command}`).toContain(
              command
            )
          }
        }
      }
      for (const event of authorization.events) {
        for (const command of authorization.commands) {
          const api = stagingApi(false)
          const env = withToken(workflowEnv(workflow, authorization.confirmation, event))
          const result = requireVerifiedStaging(command, env, api.fetch)
          if (authorization.requireVerifiedStaging.includes(command)) {
            await expect(result, `${workflow} ${event} ${command}`).rejects.toThrow(
              `Deploy Staging has no run on staging for ${sha}`
            )
          } else {
            await expect(result, `${workflow} ${event} ${command}`).resolves.toBeNull()
            expect(api.requests).toEqual([])
          }
        }
      }
    }
  })

  it('lets a production release proceed once Deploy Staging verified the commit or its tree', async () => {
    for (const event of ['push', 'workflow_dispatch']) {
      const env = withToken(
        workflowEnv('deploy-production.yml', project.confirmation.deploy, event)
      )
      for (const command of ['migrate', 'deploy'] as const) {
        // A fast-forward promotion releases the staging commit itself.
        await expect(
          requireVerifiedStaging(command, env, stagingApi(true).fetch)
        ).resolves.toMatchObject({ match: 'commit', runId: 1, sha, stagingSha: sha, tree })
        // A merge-commit promotion releases a new commit with a verified staging commit's tree.
        await expect(
          requireVerifiedStaging(command, env, stagingApi(true, { stagingSha }).fetch)
        ).resolves.toMatchObject({ match: 'tree', runId: 1, sha, stagingSha, tree })
      }
    }
    await expect(
      requireVerifiedStaging(
        'deploy',
        workflowEnv('deploy-production.yml', null, 'push'),
        stagingApi(true).fetch
      )
    ).rejects.toThrow('GITHUB_TOKEN')
  })

  it('lets only a hotfix dispatch of a merged hotfix-* pull request skip staging, to deploy', async () => {
    const hotfix = withToken(workflowEnv('deploy-production.yml', project.confirmation.hotfix))
    const api = stagingApi(false, { pulls: [mergedPull('hotfix-12-search')] })
    await expect(requireVerifiedStaging('deploy', hotfix, api.fetch)).resolves.toBe('hotfix')
    // The hotfix proof replaces staging verification; no Actions run is consulted.
    expect(api.requests.some(path => path.includes('/actions/'))).toBe(false)
    expect(api.requests.some(path => path.endsWith('/pulls'))).toBe(true)
    await expect(requireVerifiedStaging('migrate', hotfix, api.fetch)).rejects.toThrow(
      'may only deploy the Worker, never migrate'
    )
    await expect(requireVerifiedStaging('bookmark', hotfix, api.fetch)).resolves.toBeNull()
    // The confirmation alone is not enough: main's head must be a hotfix-* merge.
    for (const pulls of [
      [],
      [mergedPull('issue-12-search')],
      [mergedPull('staging')],
      [mergedPull('hotfix-12-search', newerSha)]
    ]) {
      await expect(
        requireVerifiedStaging('deploy', hotfix, stagingApi(false, { pulls }).fetch),
        JSON.stringify(pulls)
      ).rejects.toThrow('not the merge commit of a merged hotfix-* pull request')
    }
    // A push never carries a confirmation, so a stray RELEASE_CONFIRM cannot make it a hotfix.
    await expect(
      requireVerifiedStaging(
        'deploy',
        withToken(workflowEnv('deploy-production.yml', project.confirmation.hotfix, 'push')),
        api.fetch
      )
    ).rejects.toThrow('has no run on staging')
  })

  it('refuses a stale release once main has moved on to different source', async () => {
    const releases: Array<[string, Partial<NodeJS.ProcessEnv>, ReleaseCommand]> = [
      ['deploy', withToken(workflowEnv('deploy-production.yml', null, 'push')), 'deploy'],
      ['migrate', withToken(workflowEnv('deploy-production.yml', null, 'push')), 'migrate'],
      [
        'hotfix deploy',
        withToken(workflowEnv('deploy-production.yml', project.confirmation.hotfix)),
        'deploy'
      ]
    ]
    const pulls = [mergedPull('hotfix-12-search')]
    for (const [label, env, command] of releases) {
      // main moved to a commit with other source: an older release must not overwrite it.
      await expect(
        requireVerifiedStaging(command, env, stagingApi(true, { mainHead: newerSha, pulls }).fetch),
        label
      ).rejects.toThrow(`main now points at ${newerSha}, not ${sha}, so this release is stale`)
      // main moved to a commit with the same tree (an empty promotion): the source is current.
      await expect(
        requireVerifiedStaging(
          command,
          env,
          stagingApi(true, { mainHead: '3'.repeat(40), pulls }).fetch
        ),
        label
      ).resolves.toBeTruthy()
    }
  })

  it('never consults GitHub for read-only checks and refuses unknown workflows', async () => {
    const api = stagingApi(false)
    for (const command of readOnlyCommands) {
      await expect(requireVerifiedStaging(command, {}, api.fetch)).resolves.toBeNull()
    }
    expect(api.requests).toEqual([])
    await expect(
      requireVerifiedStaging('deploy', workflowEnv('main-validation.yml'), api.fetch)
    ).rejects.toThrow('protected release workflow')
  })
})

describe('release entry point', () => {
  const builtWorker = join(fixtureDirectory, 'built-worker.js')
  writeFileSync(builtWorker, '')
  const rehearsal = join(fixtureDirectory, 'rehearsal-state')

  /**
   * Records, in order, every GitHub API request, git call, and Wrangler/OpenNext invocation,
   * and answers D1 queries as a bootstrapped database missing `pending` migrations would.
   */
  function harness(
    verified: boolean,
    options: {
      mainHead?: string
      pending?: string[]
      pulls?: unknown[]
      stagingSha?: string
      unknown?: string[]
    } = {}
  ) {
    const events: string[] = []
    const api = stagingApi(verified, options)
    const fetch: FetchLike = async (url, init) => {
      events.push(`fetch ${new URL(url).pathname}`)
      return api.fetch(url, init)
    }
    const git = (args: string[]) => {
      events.push(`git ${args.join(' ')}`)
      return cleanGit(args)
    }
    const runs: string[][] = []
    const runner: ProcessRunner = {
      run(command, args, { capture }) {
        runs.push([command, ...args])
        events.push(`run ${args.slice(0, 6).join(' ')}`)
        if (!capture) return ''
        const sql = args[args.indexOf('--command') + 1] ?? ''
        const rows = sql.includes('sqlite_master')
          ? [{ name: 'd1_migrations' }, { name: 'publication_state' }]
          : sql.includes('FROM d1_migrations')
            ? [
                ...freshMigrationNames().filter(name => !options.pending?.includes(name)),
                ...(options.unknown ?? [])
              ].map(name => ({ name }))
            : [{ checksum: 'c', rows: 1, version: 1 }]
        return JSON.stringify([{ results: rows, success: true }])
      }
    }
    return { events, fetch, git, runner, runs }
  }
  const dependencies = (run: ReturnType<typeof harness>) => ({
    fetch: run.fetch,
    git: run.git,
    runner: run.runner,
    workerEntrypoint: builtWorker
  })

  const productionEnv = (workflow: string, confirmation: string | null, event?: string) => ({
    ...workflowEnv(workflow, confirmation, event),
    GITHUB_TOKEN: 'ghs_test'
  })
  const productionReleases: Array<[string, string, string]> = [
    ['migrate', 'deploy-production.yml', project.confirmation.deploy],
    ['deploy', 'deploy-production.yml', project.confirmation.deploy]
  ]

  it('refuses every remote mutation outside its protected workflow before any runner call', async () => {
    for (const command of mutatingCommands) {
      for (const environment of ['staging', 'production']) {
        const run = harness(true)
        await expect(
          runRelease([command, environment], {}, dependencies(run)),
          `${command} ${environment}`
        ).rejects.toThrow('runs only inside a protected GitHub Actions workflow')
        expect(run.events, `${command} ${environment}`).toEqual([])
      }
    }
    // The production workflow itself, dispatched without its typed confirmation.
    const unconfirmed = harness(true)
    await expect(
      runRelease(
        ['deploy', 'production'],
        productionEnv('deploy-production.yml', null),
        dependencies(unconfirmed)
      )
    ).rejects.toThrow(project.confirmation.deploy)
    expect(unconfirmed.events).toEqual([])
    // An unprotected workflow on main, and a production workflow dispatched from staging.
    for (const env of [
      productionEnv('main-validation.yml', project.confirmation.deploy),
      {
        ...productionEnv('deploy-production.yml', project.confirmation.deploy),
        GITHUB_REF: 'refs/heads/staging',
        GITHUB_WORKFLOW_REF: `${project.repository}/.github/workflows/deploy-production.yml@refs/heads/staging`
      }
    ]) {
      const run = harness(true)
      await expect(runRelease(['deploy', 'production'], env, dependencies(run))).rejects.toThrow(
        'not a protected'
      )
      expect(run.events).toEqual([])
    }
  })

  it('rehearses locally without contacting GitHub or Cloudflare', async () => {
    for (const command of ['migrate', 'list-migrations', 'plan-release', 'check-database']) {
      const run = harness(false)
      await runRelease([command, 'production', '--rehearse', rehearsal], {}, dependencies(run))
      expect(run.runs.length, command).toBeGreaterThan(0)
      expect(
        run.events.filter(event => !event.startsWith('run ')),
        command
      ).toEqual([])
      for (const call of run.runs) {
        expect(call, command).not.toContain('--remote')
        expect(call.slice(call.indexOf('--local'), call.indexOf('--local') + 3), command).toEqual([
          '--local',
          '--persist-to',
          rehearsal
        ])
      }
    }
    // Deploying and Time Travel always reach Cloudflare, so neither can be rehearsed.
    for (const argv of [
      ['deploy', 'production', '--rehearse', rehearsal],
      ['bookmark', 'production', '--rehearse', rehearsal]
    ]) {
      const run = harness(true)
      await expect(runRelease(argv, {}, dependencies(run))).rejects.toThrow('cannot be rehearsed')
      expect(run.events).toEqual([])
    }
  })

  it('refuses an unverified production release before any Wrangler or D1 call', async () => {
    for (const [command, workflow, confirmation] of productionReleases) {
      for (const event of releaseAuthorizations[workflow]?.events ?? []) {
        const run = harness(false)
        await expect(
          runRelease(
            [command, 'production'],
            productionEnv(workflow, confirmation, event),
            dependencies(run)
          ),
          `${command} ${event}`
        ).rejects.toThrow(`Deploy Staging has no run on staging for ${sha}`)
        expect(run.runs, `${command} ${event}`).toEqual([])
        expect(
          run.events.some(entry => entry.startsWith('fetch ')),
          command
        ).toBe(true)
      }
    }
  })

  it('checks staging first, then migrates or deploys a verified or promoted commit', async () => {
    for (const [command] of productionReleases) {
      for (const stagingSha of [sha, '1'.repeat(40)]) {
        for (const event of ['push', 'workflow_dispatch']) {
          const label = `${command} ${event} ${stagingSha.slice(0, 4)}`
          const run = harness(true, { stagingSha })
          await runRelease(
            [command, 'production'],
            productionEnv('deploy-production.yml', project.confirmation.deploy, event),
            dependencies(run)
          )
          const firstRun = run.events.findIndex(entry => entry.startsWith('run '))
          expect(firstRun, label).toBeGreaterThan(0)
          expect(
            run.events.slice(0, firstRun).every(entry => !entry.startsWith('run ')),
            label
          ).toBe(true)
          expect(
            run.events.slice(firstRun).some(entry => !entry.startsWith('run ')),
            label
          ).toBe(false)
          const expected =
            command === 'migrate'
              ? ['pnpm', 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'best-serp-co-production']
              : ['pnpm', '--filter', 'web', 'exec', 'opennextjs-cloudflare', 'deploy']
          const mutation = run.runs.find(call => call.includes(expected[4] ?? ''))
          expect(mutation?.slice(0, expected.length), label).toEqual(expected)
        }
      }
    }
  })

  it('refuses a stale production release before any Wrangler or D1 call', async () => {
    for (const command of ['migrate', 'deploy']) {
      const run = harness(true, { mainHead: newerSha })
      await expect(
        runRelease(
          [command, 'production'],
          productionEnv('deploy-production.yml', null, 'push'),
          dependencies(run)
        ),
        command
      ).rejects.toThrow('this release is stale')
      expect(run.runs, command).toEqual([])
    }
  })

  it('deploys a hotfix-* merge without the staging check but never migrates one', async () => {
    const hotfix = productionEnv('deploy-production.yml', project.confirmation.hotfix)
    const pulls = [mergedPull('hotfix-12-search')]
    const deploy = harness(false, { pulls })
    await expect(
      runRelease(['deploy', 'production'], hotfix, dependencies(deploy))
    ).resolves.toMatchObject({ deployed: 'best-serp-co-production' })
    expect(deploy.events.filter(entry => entry.includes('/actions/'))).toEqual([])
    const notHotfix = harness(false, { pulls: [mergedPull('issue-12-search')] })
    await expect(
      runRelease(['deploy', 'production'], hotfix, dependencies(notHotfix))
    ).rejects.toThrow('not the merge commit of a merged hotfix-* pull request')
    expect(notHotfix.runs).toEqual([])
    expect(deploy.runs.at(-1)?.slice(0, 6)).toEqual([
      'pnpm',
      '--filter',
      'web',
      'exec',
      'opennextjs-cloudflare',
      'deploy'
    ])
    const migrate = harness(false)
    await expect(
      runRelease(['migrate', 'production'], hotfix, dependencies(migrate))
    ).rejects.toThrow('hotfix release skips staging')
    expect(migrate.runs).toEqual([])
  })

  it('plans a Worker-only release unless migrations are pending, read-only', async () => {
    const pending = freshMigrationNames().slice(-1)
    const cases: Array<[ReturnType<typeof harness>, unknown]> = [
      [harness(false), { mode: 'worker-only', pendingMigrations: [] }],
      [harness(false, { pending }), { mode: 'database-and-worker', pendingMigrations: pending }]
    ]
    for (const [run, plan] of cases) {
      await expect(
        runRelease(['plan-release', 'production'], {}, dependencies(run))
      ).resolves.toEqual({ environment: 'production', ...(plan as object) })
      expect(run.events.filter(entry => !entry.startsWith('run '))).toEqual([])
      for (const call of run.runs) expect(call[call.indexOf('--command') + 1]).toMatch(/^SELECT\b/u)
    }
    await expect(
      runRelease(
        ['plan-release', 'production'],
        {},
        dependencies(harness(false, { unknown: ['9999_future.sql'] }))
      )
    ).rejects.toThrow('does not contain (9999_future.sql)')
  })

  it('refuses a stale release at the plan, before the bookmark or any D1 call', async () => {
    const pending = freshMigrationNames().slice(-1)
    for (const event of ['push', 'workflow_dispatch']) {
      const stale = harness(false, { mainHead: newerSha, pending })
      await expect(
        runRelease(
          ['plan-release', 'production'],
          productionEnv('deploy-production.yml', project.confirmation.deploy, event),
          dependencies(stale)
        ),
        event
      ).rejects.toThrow(`main now points at ${newerSha}, not ${sha}, so this release is stale`)
      // Refused from the GitHub API alone: no Wrangler call, so nothing is exported.
      expect(stale.runs, event).toEqual([])
      expect(stale.events, event).toContain(`fetch /repos/${project.repository}/git/ref/heads/main`)
    }
    // A current release still plans its migrations, and a maintainer's read-only plan outside
    // the workflow never consults GitHub.
    await expect(
      runRelease(
        ['plan-release', 'production'],
        productionEnv('deploy-production.yml', null, 'push'),
        dependencies(harness(false, { pending }))
      )
    ).resolves.toMatchObject({ mode: 'database-and-worker', pendingMigrations: pending })
    const maintainer = harness(false, { mainHead: newerSha, pending })
    await expect(
      runRelease(['plan-release', 'production'], {}, dependencies(maintainer))
    ).resolves.toMatchObject({ mode: 'database-and-worker' })
    expect(maintainer.events.filter(entry => entry.startsWith('fetch '))).toEqual([])
  })

  it('refuses a hotfix with pending migrations at the plan, before the bookmark', async () => {
    const pending = freshMigrationNames().slice(-1)
    const hotfix = productionEnv('deploy-production.yml', project.confirmation.hotfix)
    const run = harness(false, { pending })
    await expect(
      runRelease(['plan-release', 'production'], hotfix, dependencies(run))
    ).rejects.toThrow(
      `A hotfix release may not migrate, and production D1 is missing ${pending[0]}`
    )
    for (const call of run.runs) expect(call[call.indexOf('--command') + 1]).toMatch(/^SELECT\b/u)
    // Without pending migrations a hotfix plans worker-only; a promotion still migrates.
    await expect(
      runRelease(['plan-release', 'production'], hotfix, dependencies(harness(false)))
    ).resolves.toMatchObject({ mode: 'worker-only' })
    await expect(
      runRelease(
        ['plan-release', 'production'],
        productionEnv('deploy-production.yml', null, 'push'),
        dependencies(harness(false, { pending }))
      )
    ).resolves.toMatchObject({ mode: 'database-and-worker' })
  })

  it('never consults GitHub for staging releases or read-only listings', async () => {
    const staging = harness(false)
    await runRelease(
      ['deploy', 'staging'],
      workflowEnv('web.yml', null, 'push'),
      dependencies(staging)
    )
    expect(staging.events.filter(event => event.startsWith('fetch '))).toEqual([])
    expect(staging.runs.at(-1)).toEqual([
      'pnpm',
      '--filter',
      'web',
      'exec',
      'opennextjs-cloudflare',
      'deploy',
      '--env',
      'staging'
    ])

    const listing = harness(false)
    await expect(
      runRelease(['list-migrations', 'production'], {}, dependencies(listing))
    ).resolves.toEqual({
      appliedMigrations: freshMigrationNames(),
      environment: 'production',
      ledger: 'd1_migrations',
      missingMigrations: [],
      unknownMigrations: []
    })
    // Read-only listings never inspect the checkout or consult GitHub.
    expect(listing.events.filter(event => !event.startsWith('run '))).toEqual([])
    expect(listing.runs.length).toBeGreaterThan(0)
    for (const call of listing.runs) {
      expect(call.slice(0, 5)).toEqual(['pnpm', 'exec', 'wrangler', 'd1', 'execute'])
      expect(call.slice(5, 11)).toEqual([
        'best-serp-co-production',
        '--remote',
        '--env',
        'production',
        '--config',
        'apps/web/wrangler.jsonc'
      ])
      expect(call[call.indexOf('--command') + 1]).toMatch(/^SELECT\b/u)
    }
  })
})

describe('remote Wrangler identity', () => {
  it('accepts the reviewed staging and production blocks of wrangler.jsonc', () => {
    expect(() => validateRemoteConfig('staging')).not.toThrow()
    expect(() => validateRemoteConfig('production')).not.toThrow()
    // The ledger is declared explicitly, and is the one Wrangler and the release checks read.
    expect(project.migrationsTable).toBe('d1_migrations')
    const config = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8'))
    for (const bindings of [
      config.d1_databases,
      config.env.staging.d1_databases,
      config.env.production.d1_databases
    ]) {
      expect(bindings).toHaveLength(1)
      expect(bindings[0].migrations_table).toBe(project.migrationsTable)
    }
    expect(project.remote.production.origin).toBe(project.publicUrl)
    // Staging's branded canonical host (#323) is its Custom Domain; CI goes through workers.dev.
    expect(project.remote.staging.origin).toBe('https://staging.best.serp.co')
    expect(config.env.staging.routes).toEqual([
      { custom_domain: true, pattern: 'staging.best.serp.co' }
    ])
    expect(project.remote.staging.reviewOrigin).toBe(
      `https://${project.remote.staging.workerName}.serpcompany.workers.dev`
    )
    expect(project.remote.production.reviewOrigin).toBe(
      `https://${project.remote.production.workerName}.serpcompany.workers.dev`
    )
    // Staging and production media live in different buckets on different hosts (#95).
    expect(project.remote.staging.media.bucket).not.toBe(project.remote.production.media.bucket)
    expect(project.remote.staging.media.baseUrl).not.toBe(project.remote.production.media.baseUrl)
    // Pre-cutover review URL; *.workers.dev responses carry X-Robots-Tag noindex.
    expect(project.remote.production.workersDev).toBe(true)
  })

  it('refuses a drifted environment identity', () => {
    const base = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8'))
    for (const environment of ['staging', 'production'] as const) {
      base.env[environment].d1_databases[0].migrations_dir = resolve('apps/web/drizzle')
    }
    const mutations: Array<[string, (config: typeof base) => void]> = [
      [
        'workers_dev',
        config => {
          config.env.production.workers_dev = false
        }
      ],
      [
        'DB binding',
        config => {
          config.env.production.d1_databases[0].database_id = 'x'
        }
      ],
      [
        'D1_RUNTIME_ENV',
        config => {
          config.env.production.vars.D1_RUNTIME_ENV = 'staging'
        }
      ],
      [
        'name must be',
        config => {
          config.env.production.name = 'best-serp-co-staging'
        }
      ],
      [
        'migrations',
        config => {
          config.env.production.d1_databases[0].migrations_dir = '/tmp/other'
        }
      ],
      [
        'migrations_table d1_migrations',
        config => {
          config.env.production.d1_databases[0].migrations_table = 'migrations'
        }
      ],
      [
        'migrations_table d1_migrations',
        config => {
          delete config.env.production.d1_databases[0].migrations_table
        }
      ],
      [
        'MEDIA binding must be the cdn bucket',
        config => {
          config.env.production.r2_buckets[0].bucket_name = 'cdn-staging'
        }
      ],
      [
        'MEDIA binding must be the cdn bucket',
        config => {
          delete config.env.production.r2_buckets
        }
      ],
      [
        'MEDIA_BASE_URL must be https://cdn.serp.co',
        config => {
          config.env.production.vars.MEDIA_BASE_URL = 'https://cdn-staging.serp.co'
        }
      ]
    ]
    const baselinePath = join(fixtureDirectory, 'wrangler.baseline.jsonc')
    writeFileSync(baselinePath, JSON.stringify(base))
    expect(() => validateRemoteConfig('production', baselinePath)).not.toThrow()
    for (const [message, mutate] of mutations) {
      const config = JSON.parse(JSON.stringify(base))
      mutate(config)
      const path = join(fixtureDirectory, 'wrangler.mutated.jsonc')
      writeFileSync(path, JSON.stringify(config))
      expect(() => validateRemoteConfig('production', path)).toThrow(message)
    }
  })

  it("refuses a route to anything but the environment's own canonical host (#323)", () => {
    const base = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8'))
    for (const environment of ['staging', 'production'] as const) {
      base.env[environment].d1_databases[0].migrations_dir = resolve('apps/web/drizzle')
    }
    const check = (
      environment: 'production' | 'staging',
      routes: Array<string | { custom_domain?: boolean; pattern?: string }>
    ) => {
      const config = JSON.parse(JSON.stringify(base))
      config.env[environment].routes = routes
      const path = join(fixtureDirectory, 'wrangler.routes.jsonc')
      writeFileSync(path, JSON.stringify(config))
      return () => validateRemoteConfig(environment, path)
    }
    // The reviewed shapes: staging's Custom Domain, and production's once #192 declares it.
    expect(
      check('staging', [{ custom_domain: true, pattern: 'staging.best.serp.co' }])
    ).not.toThrow()
    expect(check('production', [{ custom_domain: true, pattern: 'best.serp.co' }])).not.toThrow()
    expect(check('production', [])).not.toThrow()
    for (const [environment, routes, host] of [
      ['staging', [{ custom_domain: true, pattern: 'best.serp.co' }], 'staging.best.serp.co'],
      ['production', [{ custom_domain: true, pattern: 'staging.best.serp.co' }], 'best.serp.co'],
      ['staging', [{ pattern: 'staging.best.serp.co/*' }], 'staging.best.serp.co'],
      ['staging', ['staging.best.serp.co/*'], 'staging.best.serp.co']
    ] as const)
      expect(check(environment, [...routes]), JSON.stringify(routes)).toThrow(
        `routes may only attach ${host} as a Custom Domain`
      )
  })
})

describe('Wrangler invocation', () => {
  function recordingRunner(output = '[{"results":[{"name":"x"}],"success":true}]') {
    const calls: Array<{ args: string[]; capture: boolean; command: string }> = []
    const runner: ProcessRunner = {
      run(command, args, { capture }) {
        calls.push({ args, capture, command })
        return capture ? output : ''
      }
    }
    return { calls, runner }
  }

  it('pins remote D1 commands to the environment database, config, and --remote', async () => {
    const { calls, runner } = recordingRunner()
    const d1 = wranglerD1('production', { kind: 'remote' }, runner)
    await expect(d1.query('SELECT 1')).resolves.toEqual([{ name: 'x' }])
    d1.applyMigrations()
    const pinned = [
      'best-serp-co-production',
      '--remote',
      '--env',
      'production',
      '--config',
      'apps/web/wrangler.jsonc'
    ]
    expect(calls.map(call => [call.command, ...call.args])).toEqual([
      ['pnpm', 'exec', 'wrangler', 'd1', 'execute', ...pinned, '--command', 'SELECT 1', '--json'],
      ['pnpm', 'exec', 'wrangler', 'd1', 'migrations', 'apply', ...pinned]
    ])
  })

  it('rehearses against an isolated local state without --remote', () => {
    const { calls, runner } = recordingRunner()
    wranglerD1(
      'staging',
      { kind: 'rehearsal', persistTo: '/tmp/rehearsal' },
      runner
    ).applyMigrations()
    expect(calls[0]?.args).toEqual([
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'best-serp-co-staging',
      '--local',
      '--persist-to',
      '/tmp/rehearsal',
      '--env',
      'staging',
      '--config',
      'apps/web/wrangler.jsonc'
    ])
  })

  it('parses only successful D1 results', () => {
    expect(parseWranglerRows('[{"results":[{"a":1}],"success":true}]')).toEqual([{ a: 1 }])
    expect(() => parseWranglerRows('[{"results":[],"success":false}]')).toThrow('unsuccessful')
    expect(() => parseWranglerRows('{}')).toThrow('malformed')
  })
})

describe('database readiness', () => {
  it('serves only a fully migrated database with a catalog publication', async () => {
    const { database, target } = sqliteD1()

    const empty = await checkDatabase(target)
    expect(empty.missingMigrations).toEqual(freshMigrationNames())
    expect(() => assertDatabaseReady(empty, 'production')).toThrow('database-and-worker')

    target.applyMigrations()
    // No re-import exists (#315): a database without a publication is restored from Time Travel.
    await expect(
      checkDatabase(target).then(readiness => assertDatabaseReady(readiness, 'production'))
    ).rejects.toThrow('Restore it with D1 Time Travel (docs/d1-recovery.md)')

    publish(database)
    const ready = await checkDatabase(target)
    expect(() => assertDatabaseReady(ready, 'production')).not.toThrow()
    expect(ready.publication).toEqual({ checksum: publicationChecksum, rows: 1, version: 1 })
  })

  it('lists applied, pending, and unknown migrations with SELECTs only', async () => {
    const { database, target } = sqliteD1()
    const statements: string[] = []
    const recording: D1Target = {
      ...target,
      query: sql => {
        statements.push(sql)
        return target.query(sql)
      }
    }
    await expect(readMigrationLedger(recording)).resolves.toEqual({
      appliedMigrations: [],
      missingMigrations: freshMigrationNames(),
      unknownMigrations: []
    })
    target.applyMigrations()
    database.exec("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')")
    await expect(readMigrationLedger(recording)).resolves.toEqual({
      appliedMigrations: [...freshMigrationNames(), '9999_future.sql'],
      missingMigrations: [],
      unknownMigrations: ['9999_future.sql']
    })
    expect(statements.every(sql => /^SELECT\b/u.test(sql))).toBe(true)
  })

  it('refuses to deploy older code over a database with unknown migrations', async () => {
    const { database, target } = sqliteD1()
    target.applyMigrations()
    publish(database)
    database.exec("INSERT INTO d1_migrations (name) VALUES ('9999_future.sql')")
    await expect(
      checkDatabase(target).then(readiness => assertDatabaseReady(readiness, 'staging'))
    ).rejects.toThrow('does not contain (9999_future.sql)')
  })
})

describe('Time Travel bookmark', () => {
  const bookmark = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683'
  const recordedAt = new Date('2026-10-06T12:00:00.000Z')

  function bookmarkRunner(output: string | Error) {
    const calls: Array<{ args: string[]; capture: boolean; command: string }> = []
    const runner: ProcessRunner = {
      run(command, args, { capture }) {
        calls.push({ args, capture, command })
        if (output instanceof Error) throw output
        return output
      }
    }
    return { calls, runner }
  }

  it('reads only one well-formed bookmark from wrangler d1 time-travel info --json', () => {
    expect(parseTimeTravelBookmark(JSON.stringify({ bookmark }))).toBe(bookmark)
    expect(parseTimeTravelBookmark(`${JSON.stringify({ bookmark }, null, 2)}\n`)).toBe(bookmark)
    for (const output of [
      '',
      'not json',
      '{}',
      '[]',
      JSON.stringify({ bookmark: '' }),
      JSON.stringify({ bookmark: 42 }),
      JSON.stringify({ result: { bookmark } }),
      // The bookmark lands in a shell command and Markdown, so nothing but hex segments passes.
      JSON.stringify({ bookmark: `${bookmark}; rm -rf /` }),
      JSON.stringify({ bookmark: `${bookmark}\n\`\`\`` }),
      JSON.stringify({ bookmark: '$(id)' }),
      JSON.stringify({ bookmark: 'deadbeef' })
    ]) {
      expect(() => parseTimeTravelBookmark(output), output).toThrow('no valid bookmark')
    }
  })

  it('asks Wrangler for the environment database by its reviewed config, without --remote', () => {
    for (const environment of ['staging', 'production'] as const) {
      const { calls, runner } = bookmarkRunner(JSON.stringify({ bookmark }))
      const record = recordTimeTravelBookmark(environment, runner, {}, recordedAt)
      const database = project.remote[environment].databaseName
      expect(calls).toEqual([
        {
          args: [
            'exec',
            'wrangler',
            'd1',
            'time-travel',
            'info',
            database,
            '--env',
            environment,
            '--config',
            'apps/web/wrangler.jsonc',
            '--json'
          ],
          capture: true,
          command: 'pnpm'
        }
      ])
      expect(record).toEqual({
        bookmark,
        database,
        environment,
        recordedAt: '2026-10-06T12:00:00.000Z',
        restore: `pnpm exec wrangler d1 time-travel restore ${database} --env ${environment} --config apps/web/wrangler.jsonc --bookmark ${bookmark}`
      })
      expect(timeTravelRestoreCommand(environment, bookmark)).toBe(record.restore)
    }
  })

  it('writes the bookmark and its restore command to the step summary inside Actions', () => {
    const summary = join(fixtureDirectory, 'step-summary.md')
    writeFileSync(summary, '# Earlier step\n')
    const env = { ...workflowEnv('publish-d1.yml'), GITHUB_STEP_SUMMARY: summary }
    const { runner } = bookmarkRunner(JSON.stringify({ bookmark }))
    const record = recordTimeTravelBookmark('production', runner, env, recordedAt)
    const written = readFileSync(summary, 'utf8')
    expect(written).toBe(`# Earlier step\n${bookmarkSummary(record)}`)
    expect(written).toContain(`Bookmark \`${bookmark}\`, recorded at 2026-10-06T12:00:00.000Z`)
    expect(written).toContain(`\`\`\`bash\n${record.restore}\n\`\`\``)
    expect(written).toContain('docs/d1-recovery.md#restore-a-workflow-bookmark')
    // Inside Actions a missing summary file is a failure, never a silent skip.
    expect(() =>
      recordTimeTravelBookmark(
        'production',
        bookmarkRunner(JSON.stringify({ bookmark })).runner,
        { ...env, GITHUB_STEP_SUMMARY: '' },
        recordedAt
      )
    ).toThrow('GITHUB_STEP_SUMMARY')
  })

  it('fails closed, writing nothing, when Cloudflare returns no bookmark', () => {
    const summary = join(fixtureDirectory, 'failed-summary.md')
    writeFileSync(summary, '')
    const env = { ...workflowEnv('deploy-production.yml'), GITHUB_STEP_SUMMARY: summary }
    for (const output of [
      new Error('Authentication error [code: 10000]'),
      JSON.stringify({ bookmark: null })
    ]) {
      expect(() =>
        recordTimeTravelBookmark('production', bookmarkRunner(output).runner, env, recordedAt)
      ).toThrow(
        'Could not record a D1 Time Travel bookmark of best-serp-co-production; refusing to change it without a restore point. The Cloudflare token needs Account → D1 → Edit'
      )
    }
    expect(
      () =>
        recordTimeTravelBookmark(
          'production',
          bookmarkRunner(new Error('Authentication error [code: 10000]')).runner,
          env
        ),
      'keeps Wrangler’s reason'
    ).toThrow('Authentication error [code: 10000]')
    expect(readFileSync(summary, 'utf8')).toBe('')
  })

  it('runs as a read-only command: no checkout or GitHub check, one Wrangler call', async () => {
    for (const env of [{}, workflowEnv('publish-d1.yml'), workflowEnv('web.yml')]) {
      const events: string[] = []
      const { calls, runner } = bookmarkRunner(JSON.stringify({ bookmark }))
      const result = await runRelease(['bookmark', 'production'], env, {
        fetch: async url => {
          events.push(`fetch ${url}`)
          throw new Error('bookmark never calls GitHub')
        },
        git: args => {
          events.push(`git ${args.join(' ')}`)
          return ''
        },
        runner
      }).catch(error => error)
      // Inside Actions the summary path is required; outside, the record is only printed.
      if (env.GITHUB_ACTIONS === 'true') {
        expect(result).toBeInstanceOf(Error)
        expect(String(result)).toContain('GITHUB_STEP_SUMMARY')
      } else {
        expect(result).toMatchObject({ bookmark, environment: 'production' })
      }
      expect(events).toEqual([])
      expect(calls).toHaveLength(1)
    }
  })

  it('documents the same restore command the run summary prints', () => {
    const recovery = readFileSync(resolve('docs/d1-recovery.md'), 'utf8').replace(
      /\s*\\\n\s*/gu,
      ' '
    )
    expect(recovery).toContain(timeTravelRestoreCommand('production', '<bookmark>'))
  })
})

describe('deploy', () => {
  it('deploys the built Worker only onto a ready database', async () => {
    const entrypoint = join(fixtureDirectory, 'worker.js')
    const calls: string[][] = []
    const runner: ProcessRunner = {
      run(command, args) {
        calls.push([command, ...args])
        return ''
      }
    }
    const { database, target } = sqliteD1()
    await expect(
      deployWorker(target, 'production', runner, join(fixtureDirectory, 'missing.js'))
    ).rejects.toThrow('pnpm worker:build')
    writeFileSync(entrypoint, '')
    target.applyMigrations()
    await expect(deployWorker(target, 'production', runner, entrypoint)).rejects.toThrow(
      'no catalog publication'
    )
    expect(calls).toEqual([])
    publish(database)
    await deployWorker(target, 'production', runner, entrypoint)
    expect(calls).toEqual([
      ['pnpm', '--filter', 'web', 'exec', 'opennextjs-cloudflare', 'deploy', '--env', 'production']
    ])
  })
})

describe('release arguments', () => {
  it('parses explicit commands, environments, and options', () => {
    expect(parseReleaseArguments(['--', 'migrate', 'staging'])).toEqual({
      command: 'migrate',
      environment: 'staging'
    })
    expect(parseReleaseArguments(['bookmark', 'production'])).toEqual({
      command: 'bookmark',
      environment: 'production'
    })
    expect(parseReleaseArguments(['migrate', 'production', '--rehearse', '/tmp/r'])).toMatchObject({
      rehearse: '/tmp/r'
    })
    // The one-time bootstrap commands are archived with the v1 import (#315).
    for (const command of ['import', 'verify-import']) {
      expect(() => parseReleaseArguments([command, 'production'])).toThrow('command must be')
    }
    expect(parseReleaseArguments(['list-migrations', 'production'])).toEqual({
      command: 'list-migrations',
      environment: 'production'
    })
    expect(() => parseReleaseArguments(['publish', 'production'])).toThrow('command must be')
    expect(() => parseReleaseArguments(['migrate', 'preview'])).toThrow('staging or production')
    // The export command is gone: no release command writes a database to a file (#99).
    expect(() => parseReleaseArguments(['backup', 'production'])).toThrow('command must be')
    expect(() =>
      parseReleaseArguments(['migrate', 'production', '--output', '/tmp/b.sql'])
    ).toThrow('Usage')
    expect(() => parseReleaseArguments(['migrate', 'staging', '--site', 'x'])).toThrow('Usage')
    expect(() => parseReleaseArguments(['migrate', 'production', '--rehearse', 'rel'])).toThrow(
      'absolute'
    )
    for (const command of ['deploy', 'bookmark']) {
      expect(() => parseReleaseArguments([command, 'staging', '--rehearse', '/tmp/r'])).toThrow(
        'cannot be rehearsed'
      )
    }
  })
})
