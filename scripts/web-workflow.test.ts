import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { githubHostedRunner, routedRunsOn } from './ci-runners'
import { stepEnvironment, stepsForProfile } from './harness/runner'
import { project } from './project'
import { hotfixBranch } from './staging-verification'

const repository = project.repository

interface WorkflowStep {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string | number | boolean>
}

interface WorkflowJob {
  if?: string
  name?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'runs-on'?: string
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  jobs: Record<string, WorkflowJob>
  on: Record<string, { branches?: string[]; paths?: string[]; types?: string[] } | null>
  permissions?: Record<string, string>
}

const source = readFileSync(resolve('.github/workflows/web.yml'), 'utf8')
const workflow = yaml.load(source) as WorkflowDefinition
const expression = (value: string) => `\${{ ${value} }}`

function step(job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]?.steps?.find(candidate => candidate.name === name)
  if (!found) throw new Error(`${job} has no step "${name}"`)
  return found
}

/** Runs a step's script with commands (`git`, `gh`, ...) as shell functions; returns outputs. */
function runStep(
  script: string,
  stubs: string,
  env: Record<string, string>
): { outputs: Record<string, string>; status: number | null } {
  const directory = mkdtempSync(join(tmpdir(), 'web-workflow-'))
  try {
    const output = join(directory, 'output')
    // The generated `NodeJS.ProcessEnv` (apps/web/cloudflare-env.d.ts) lists the Worker's vars,
    // which this bash child never has, so the bare environment is typed as Node's own.
    const childEnv: NodeJS.Dict<string> = {
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      ...env
    }
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `${stubs}\n${script}`], {
      encoding: 'utf8',
      env: childEnv as NodeJS.ProcessEnv
    })
    let text = ''
    try {
      text = readFileSync(output, 'utf8')
    } catch {}
    const outputs = Object.fromEntries(
      text
        .split('\n')
        .filter(Boolean)
        .map(line => line.split('=', 2) as [string, string])
    )
    return { outputs, status: result.status }
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

describe('web workflow', () => {
  it('checks pull requests into staging and main, every push to them, and a dispatch', () => {
    expect(workflow.on.pull_request).toEqual({
      branches: ['staging', 'main'],
      // Without ready_for_review, a draft's failed e2e would stand when the PR is marked ready.
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review']
    })
    expect(workflow.on.push).toEqual({ branches: ['staging', 'main'] })
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    // A workflow-level paths filter leaves a required check pending; documentation is filtered
    // inside, by the changes job.
    expect(source).not.toMatch(/^\s+paths(?:-ignore)?:/mu)
  })

  it('reports check and e2e on every ready pull request: the required checks', () => {
    expect(workflow.jobs.check?.name).toBe('check')
    expect(workflow.jobs.e2e?.name).toBe('e2e')
    expect(workflow.jobs.check?.needs).toEqual(['changes'])
    expect(workflow.jobs.e2e?.needs).toEqual(['changes'])
    // Skipping a required job reports success: check and e2e run even when `changes` failed
    // (then they run everything), and a draft runs e2e too, where it fails.
    expect(workflow.jobs.check?.if).toBe('!cancelled()')
    // Full history, so the media plan test can read deleted sources from Git (#124).
    expect(step('check', 'Checkout').with).toEqual({ 'fetch-depth': 0 })
    expect(workflow.jobs.changes?.if).toBeUndefined()
    expect(workflow.jobs.e2e?.if).toBe('!cancelled()')
  })

  it('fails e2e on a draft pull request instead of skipping it (#246)', () => {
    const steps = workflow.jobs.e2e?.steps ?? []
    const draft = step('e2e', 'Require a pull request ready for review')
    // First, so nothing installs or runs, and nothing later in the job can turn it green.
    expect(steps.indexOf(draft)).toBe(0)
    expect(draft.if).toBe('github.event.pull_request.draft == true')
    expect(runStep(String(draft.run), '', {}).status).toBe(1)
    expect(draft.run).toContain('draft: mark ready to run e2e')
    // continue-on-error would let a failed step leave the job green: only the probes'
    // diagnostics carry it (#393, #417), never a job or any other step.
    const tolerant = Object.entries(workflow.jobs).flatMap(([job, definition]) => [
      ...('continue-on-error' in definition ? [job] : []),
      ...(definition.steps ?? [])
        .filter(candidate => 'continue-on-error' in candidate)
        .map(candidate => `${job}: ${candidate.name}`)
    ])
    expect(tolerant).toEqual([
      'e2e: Report runner resources',
      'e2e: Upload the resource probe',
      'deploy-staging: Report smoke latency'
    ])
    // Every later step either needs the earlier ones to succeed or checks the receipt step ran.
    for (const later of steps.slice(1)) {
      if (/always\(\)|failure\(\)|cancelled\(\)/u.test(later.if ?? '')) {
        expect(later.if, later.name).toContain("steps.receipt.outcome == 'success'")
      }
    }
  })

  it('runs pnpm check, without its build on a push, and only the documentation check for docs', () => {
    const gate = step('check', 'Run the finish gate')
    expect(gate.run).toBe('pnpm check')
    // Anything but an explicit `false` (a failed changes job included) runs the full check.
    expect(gate.if).toBe("needs.changes.outputs.code != 'false'")
    expect(gate.env).toEqual({
      HARNESS_SKIP_BUILD: expression("github.event_name != 'pull_request' && '1' || ''")
    })
    const docs = step('check', 'Check the documentation')
    // The tests read documentation too, so a docs-only change still runs them.
    expect(docs.run).toBe('pnpm docs:check && pnpm test')
    expect(docs.if).toBe("needs.changes.outputs.code == 'false'")
    const names = (env: Record<string, string>) =>
      stepsForProfile('full', env).map(harness => harness.name)
    expect(names({})).toContain('OpenNext Worker build')
    expect(names({ HARNESS_SKIP_BUILD: '1' })).not.toContain('OpenNext Worker build')
    expect(names({ HARNESS_SKIP_BUILD: '1' })).toEqual(
      names({}).filter(name => name !== 'OpenNext Worker build')
    )
    // The steps themselves never see it: their tests check the full step list.
    expect(stepEnvironment({ HARNESS_SKIP_BUILD: '1', PATH: '/bin' })).toEqual({
      CI: '1',
      FORCE_COLOR: '0',
      PATH: '/bin'
    })
    expect(stepEnvironment({ CI: 'true', FORCE_COLOR: '1' })).toEqual({
      CI: 'true',
      FORCE_COLOR: '1'
    })
  })

  it('treats a change as documentation only when every file is under docs/, .archive/ or Markdown', () => {
    const find = step('changes', 'Find code changes')
    expect(find.env).toEqual({ BASE: expression('github.event.pull_request.base.sha') })
    // Like git, the stub lists a renamed file only by its new path unless --no-renames is set.
    const classify = (
      files: string[],
      env: Record<string, string> = {},
      withRenames: string[] = files
    ) => {
      const list = (paths: string[]) => paths.map(file => `'${file}'`).join(' ')
      return runStep(
        String(find.run),
        `git() {
          if [ "$1" = cat-file ]; then return "\${CAT_STATUS:-0}"; fi
          case " $* " in
            *" --no-renames "*) printf '%s\\n' ${list(files)} ;;
            *) printf '%s\\n' ${list(withRenames)} ;;
          esac
        }`,
        { BASE: 'abc', GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: 'def', ...env }
      ).outputs.code
    }
    expect(classify(['docs/harness.md'])).toBe('false')
    expect(classify(['docs/harness.md', 'AGENTS.md', 'apps/web/e2e/README.md'])).toBe('false')
    expect(classify(['docs/diagram.svg'])).toBe('false')
    expect(classify(['.archive/mockups/submissions/index.html'])).toBe('false')
    expect(classify(['docs/harness.md', 'scripts/harness/runner.ts'])).toBe('true')
    // MDX is site content.
    expect(classify(['apps/web/content/legal/terms-conditions.mdx'])).toBe('true')
    expect(classify(['.github/workflows/web.yml'])).toBe('true')
    // Code moved into docs/ is still a code change.
    expect(classify(['apps/web/src/util.ts', 'docs/util.ts'], {}, ['docs/util.ts'])).toBe('true')
    expect(classify(['apps/web/src/util.ts', '.archive/util.ts'], {}, ['.archive/util.ts'])).toBe(
      'true'
    )
    // A push deploys, so it checks the tree it deploys whatever changed; unknown bases run
    // everything.
    expect(classify(['docs/harness.md'], { GITHUB_EVENT_NAME: 'push' })).toBe('true')
    expect(classify(['docs/harness.md'], { GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe('true')
    expect(classify(['docs/harness.md'], { BASE: '' })).toBe('true')
    expect(classify(['docs/harness.md'], { CAT_STATUS: '128' })).toBe('true')
  })

  it('skips E2E on a push whose tree passed before, and on documentation; fails toward running', () => {
    const receipt = step('e2e', 'Find a receipt for this tree')
    expect(receipt.env).toEqual({
      CODE: expression('needs.changes.outputs.code'),
      GH_TOKEN: expression('github.token'),
      REPO_ID: expression('github.repository_id')
    })
    const decide = (env: Record<string, string>, gh: string) =>
      runStep(String(receipt.run), `git() { echo tree123; }\ngh() { ${gh}; }`, {
        CODE: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: repository,
        REPO_ID: '42',
        ...env
      }).outputs
    expect(decide({}, 'echo 1')).toEqual({ skip: 'true', tree: 'tree123' })
    expect(decide({}, 'echo 0')).toEqual({ tree: 'tree123' })
    expect(decide({}, 'return 1')).toEqual({ tree: 'tree123' })
    // A pull request always runs the suite and records its receipt.
    expect(decide({ GITHUB_EVENT_NAME: 'pull_request' }, 'echo 1')).toEqual({ tree: 'tree123' })
    // With no answer from a failed changes job, the suite runs.
    expect(decide({ CODE: '', GITHUB_EVENT_NAME: 'pull_request' }, 'echo 0')).toEqual({
      tree: 'tree123'
    })
    expect(decide({ CODE: 'false', GITHUB_EVENT_NAME: 'pull_request' }, 'echo 0')).toEqual({
      skip: 'true',
      tree: 'tree123'
    })
    // Only an unexpired receipt from this repository's own runs counts.
    expect(receipt.run).toContain('select(.expired | not)')
    expect(receipt.run).toContain('select(.workflow_run.head_repository_id == $REPO_ID)')
    expect(receipt.run).toContain('passed-e2e-$tree')
    for (const name of [
      'Install',
      'Install Playwright Browsers',
      'Run Playwright tests',
      'Write the receipt',
      'Record the receipt'
    ]) {
      expect(step('e2e', name).if, name).toContain("steps.receipt.outputs.skip != 'true'")
    }
  })

  it('records a receipt only after a full E2E run of this repository', () => {
    const own =
      "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
    expect(step('e2e', 'Write the receipt').if).toBe(
      `steps.receipt.outputs.skip != 'true' && ${own}`
    )
    const record = step('e2e', 'Record the receipt')
    expect(record.if).toBe(`steps.receipt.outputs.skip != 'true' && ${own}`)
    expect(record.uses).toBe('actions/upload-artifact@v7')
    expect(record.with).toEqual({
      name: `passed-e2e-${expression('steps.receipt.outputs.tree')}`,
      overwrite: true,
      path: `${expression('runner.temp')}/receipt.txt`,
      'retention-days': 30
    })
    const names = (workflow.jobs.e2e?.steps ?? []).map(candidate => candidate.name)
    expect(names.indexOf('Record the receipt')).toBeGreaterThan(
      names.indexOf('Run Playwright tests')
    )
  })

  it('starts the deploy only for the staging tip, and fails when the tip cannot be read', () => {
    // Decided before deploy-staging starts, so a stale commit doesn't build or wait in the group.
    const job = workflow.jobs.tip
    expect(job?.needs).toEqual(['check', 'e2e'])
    expect(job?.if).toBe(
      "github.ref == 'refs/heads/staging' && github.event_name != 'pull_request'"
    )
    expect(job?.outputs).toEqual({ deploy: expression('steps.tip.outputs.deploy') })
    expect(workflow.jobs['deploy-staging']?.needs).toEqual(['check', 'e2e', 'tip'])
    expect(workflow.jobs['deploy-staging']?.if).toBe(
      "github.ref == 'refs/heads/staging' && github.event_name != 'pull_request' && needs.tip.outputs.deploy == 'true'"
    )
    const decide = step('tip', 'Is this commit the staging tip?')
    expect(decide.env).toEqual({ GH_TOKEN: expression('github.token') })
    const tipFor = (gh: string) =>
      runStep(String(decide.run), `gh() { ${gh}; }`, {
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: 'abc123'
      })
    expect(tipFor('echo abc123')).toEqual({ outputs: { deploy: 'true' }, status: 0 })
    expect(tipFor('echo def456')).toEqual({ outputs: {}, status: 0 })
    expect(tipFor('return 1').status).not.toBe(0)
  })

  it('checks the tip again inside the deploy, and fails when it cannot be read', () => {
    const tip = workflow.jobs['deploy-staging']?.steps?.find(candidate => candidate.id === 'tip')
    const guard = (status: number, output: string) =>
      runStep(String(tip?.run), `git() { printf '%s' "$LS_OUTPUT"; return "$LS_STATUS"; }`, {
        GITHUB_SHA: 'abc123',
        LS_OUTPUT: output,
        LS_STATUS: String(status)
      })
    expect(guard(0, 'abc123\trefs/heads/staging\n')).toEqual({
      outputs: { deploy: 'true' },
      status: 0
    })
    expect(guard(0, 'def456\trefs/heads/staging\n')).toEqual({ outputs: {}, status: 0 })
    expect(guard(128, '').status).not.toBe(0)
    expect(guard(2, '').status).not.toBe(0)
  })

  // #418 review, #430: the smoke step exits with the suite's status, and only after the latency
  // probe has recorded its request in flight.
  it('runs the staging smoke beside the latency probe and waits for the probe to stop', () => {
    const smoke = String(step('deploy-staging', 'Run Playwright smoke against staging').run)
    // Stand-ins for `bash scripts/smoke-latency-probe.sh` and `pnpm`, which log to $LOG. Like the
    // real probe, the stand-in handles TERM only after its request in flight (200 ms) returns,
    // then records it; it closes the step's output so the test doesn't wait on it. The suite
    // starts once the probe has, and exits with $SUITE.
    const stubs = [
      'bash() {',
      '  exec >/dev/null 2>&1',
      '  stop=0',
      "  trap 'stop=1' TERM",
      '  echo "probe $*" >> "$LOG"',
      '  for ((i = 0; i < 15; i++)); do',
      '    sleep 0.2',
      '    if [ "$stop" = 1 ]; then echo "probe recorded its request in flight" >> "$LOG"; return; fi',
      '  done',
      '  echo "probe was never stopped" >> "$LOG"',
      '}',
      'pnpm() {',
      '  for ((i = 0; i < 100; i++)); do grep -q "^probe " "$LOG" 2>/dev/null && break; sleep 0.02; done',
      '  echo "suite $*" >> "$LOG"',
      '  return "$SUITE"',
      '}'
    ].join('\n')
    const directory = mkdtempSync(join(tmpdir(), 'staging-smoke-'))
    try {
      const origin = project.remote.staging.reviewOrigin
      for (const suite of [0, 1, 3]) {
        const log = join(directory, `log-${suite}`)
        const result = runStep(smoke, stubs, {
          LOG: log,
          PLAYWRIGHT_BASE_URL: origin,
          RUNNER_TEMP: directory,
          SUITE: String(suite)
        })
        expect(result.status, `suite exit ${suite}`).toBe(suite)
        // Read as soon as the step exits: the probe's last line is there only if the step waited.
        expect(readFileSync(log, 'utf8').trim().split('\n'), `suite exit ${suite}`).toEqual([
          `probe scripts/smoke-latency-probe.sh ${directory}/smoke-latency-probe ${origin}`,
          'suite --filter web test:e2e:smoke',
          'probe recorded its request in flight'
        ])
      }
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('accepts pull requests into main only from a hotfix branch of this repository', () => {
    const steps = workflow.jobs.check?.steps ?? []
    const guard = steps.find(candidate =>
      candidate.run?.includes('it accepts only hotfix-* pull requests')
    )
    expect(steps.indexOf(guard as WorkflowStep)).toBe(1)
    expect(guard?.if).toBe("github.base_ref == 'main'")
    // The head ref is attacker-controlled, so it reaches the shell only through env.
    expect(guard?.env).toEqual({
      HEAD_REF: expression('github.head_ref'),
      HEAD_REPOSITORY: expression('github.event.pull_request.head.repo.full_name')
    })
    // The same hotfix branch names the release script's hotfix check accepts.
    expect(guard?.run).toContain(`[[ "$HEAD_REF" =~ ${hotfixBranch.source} ]]`)
    expect(guard?.run).toContain('git ls-remote --exit-code origin refs/heads/staging')
  })

  it('runs the head-branch guard exactly, failing closed when the branch list is unavailable', () => {
    const guard = String(step('check', 'Require a hotfix branch for pull requests into main').run)
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
      const stub = `git() { printf '%s' "$LS_OUTPUT"; return "$LS_STATUS"; }`
      const result = runStep(guard, stub, {
        GITHUB_REPOSITORY: repository,
        HEAD_REF: headRef,
        HEAD_REPOSITORY: headRepository,
        LS_OUTPUT: output,
        LS_STATUS: String(status)
      })
      expect(result.status, `${status} ${headRef} ${headRepository}`).toBe(expected)
    }
  })

  it('routes only check through CI_RUNNER_LABELS, behind the fork guard', () => {
    expect(workflow.jobs.check?.['runs-on']).toBe(routedRunsOn)
    // E2E installs Playwright browsers, and the deploy holds credentials: GitHub-hosted.
    for (const job of ['changes', 'e2e', 'tip', 'deploy-staging']) {
      expect(workflow.jobs[job]?.['runs-on'], job).toBe(githubHostedRunner)
    }
    expect(source).not.toMatch(/self-hosted/u)
  })

  it('installs Playwright browsers without sudo-only system dependency escalation', () => {
    const runs = (workflow.jobs.e2e?.steps ?? []).map(candidate => candidate.run).filter(Boolean)
    expect(runs).toContain('pnpm --filter web test:install')
    expect(step('e2e', 'Run Playwright tests').run?.trim().split('\n').at(-1)).toBe('pnpm test:e2e')
    expect(source).not.toContain('--with-deps')
  })

  it('probes the runner beside the suite and keeps the probe when the suite fails (#393)', () => {
    // In the suite's own step, so its lines reach the log a runner shutdown keeps; stopped when
    // the step ends, and the suite's exit status is the step's.
    const run = String(step('e2e', 'Run Playwright tests').run)
    expect(run).toContain('bash scripts/e2e-resource-probe.sh "$RUNNER_TEMP/resource-probe" &')
    expect(run).toContain(`trap 'kill "$probe" 2>/dev/null || true' EXIT`)
    expect(run.indexOf('e2e-resource-probe.sh')).toBeLessThan(run.indexOf('pnpm test:e2e'))
    const afterSuite =
      "always() && steps.receipt.outcome == 'success' && steps.receipt.outputs.skip != 'true'"
    expect(step('e2e', 'Upload test results').if).toBe(afterSuite)
    expect(step('e2e', 'Report runner resources')).toMatchObject({
      if: afterSuite,
      run: 'bash scripts/e2e-resource-probe.sh --report "$RUNNER_TEMP/resource-probe"'
    })
    // Diagnostics only: neither fails e2e nor withholds the receipt when every test passed.
    for (const name of ['Report runner resources', 'Upload the resource probe']) {
      expect(step('e2e', name)['continue-on-error'], name).toBe(true)
    }
    expect(step('e2e', 'Upload the resource probe')).toMatchObject({
      if: afterSuite,
      uses: 'actions/upload-artifact@v7',
      with: {
        name: `e2e-resource-probe-${expression('github.run_attempt')}`,
        path: `${expression('runner.temp')}/resource-probe/`
      }
    })
  })

  it('runs all three Playwright configs, each even when an earlier one fails (#393)', async () => {
    // e2e runs the root script; the web package's scripts pick the configs.
    const scripts = (path: string) =>
      (JSON.parse(readFileSync(resolve(path), 'utf8')) as { scripts: Record<string, string> })
        .scripts
    const web = scripts('apps/web/package.json')
    expect(web['test:e2e']).toBe('playwright test')
    expect(web['test:e2e:suites']).toBe('playwright test --config playwright.suites.config.ts')
    expect(web['test:e2e:staging-access']).toBe(
      'playwright test --config playwright.staging-access.config.ts'
    )
    // The root script with `pnpm` stubbed: every run starts, in order, and the status fails
    // when any run fails.
    const directory = mkdtempSync(join(tmpdir(), 'e2e-runs-'))
    try {
      const calls = join(directory, 'calls')
      const pnpm = join(directory, 'pnpm')
      writeFileSync(
        pnpm,
        `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$3" in "$FAIL") exit 7 ;; esac\nexit 0\n`
      )
      chmodSync(pnpm, 0o755)
      const run = (fail: string) => {
        rmSync(calls, { force: true })
        // A bare environment, typed as Node's own (see runStep).
        const env: NodeJS.Dict<string> = { FAIL: fail, PATH: `${directory}:${process.env.PATH}` }
        const result = spawnSync('sh', ['-c', scripts('package.json')['test:e2e'] as string], {
          encoding: 'utf8',
          env: env as NodeJS.ProcessEnv
        })
        return { calls: readFileSync(calls, 'utf8').trim().split('\n'), status: result.status }
      }
      const runs = [
        '--filter web test:e2e',
        '--filter web test:e2e:suites',
        '--filter web test:e2e:staging-access'
      ]
      expect(run('none')).toEqual({ calls: runs, status: 0 })
      expect(run('test:e2e')).toEqual({ calls: runs, status: 1 })
      expect(run('test:e2e:suites')).toEqual({ calls: runs, status: 1 })
      expect(run('test:e2e:staging-access')).toEqual({ calls: runs, status: 7 })
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
    // The three configs split the specs: each spec runs in exactly one of them.
    const main = (await import('../apps/web/playwright.config')).default
    const { suiteSpecs } = await import('../apps/web/playwright.config')
    const suites = (await import('../apps/web/playwright.suites.config')).default
    const staging = (await import('../apps/web/playwright.staging-access.config')).default
    expect(suites.testMatch).toEqual(suiteSpecs)
    expect(staging.testMatch).toBe('**/staging-access.spec.ts')
    expect(main.testIgnore).toEqual(expect.arrayContaining([...suiteSpecs, staging.testMatch]))
  })
})
