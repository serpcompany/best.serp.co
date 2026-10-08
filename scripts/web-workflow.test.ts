import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

/** Runs a step's script with `git` and `gh` replaced by shell functions; returns its outputs. */
function runStep(
  script: string,
  stubs: string,
  env: Record<string, string>
): { outputs: Record<string, string>; status: number | null } {
  const directory = mkdtempSync(join(tmpdir(), 'web-workflow-'))
  try {
    const output = join(directory, 'output')
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `${stubs}\n${script}`], {
      encoding: 'utf8',
      env: {
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        NODE_ENV: 'test',
        PATH: process.env.PATH,
        ...env
      }
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
      // Without ready_for_review, a draft's skipped e2e would stand when the PR is marked ready.
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
    // (then they run everything), and only a draft skips e2e.
    expect(workflow.jobs.check?.if).toBe('!cancelled()')
    // Full history, so the media plan test can read deleted sources from Git (#124).
    expect(step('check', 'Checkout').with).toEqual({ 'fetch-depth': 0 })
    expect(workflow.jobs.changes?.if).toBeUndefined()
    expect(workflow.jobs.e2e?.if).toBe(
      "!cancelled() && (github.event_name != 'pull_request' || github.event.pull_request.draft == false)"
    )
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
  })

  it('treats a change as documentation only when every file is under docs/ or Markdown', () => {
    const find = step('changes', 'Find code changes')
    expect(find.env).toEqual({ BASE: expression('github.event.pull_request.base.sha') })
    const classify = (files: string[], env: Record<string, string> = {}) =>
      runStep(
        String(find.run),
        `git() { if [ "$1" = cat-file ]; then return "\${CAT_STATUS:-0}"; fi; printf '%s\\n' ${files
          .map(file => `'${file}'`)
          .join(' ')}; }`,
        { BASE: 'abc', GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: 'def', ...env }
      ).outputs.code
    expect(classify(['docs/HARNESS.md'])).toBe('false')
    expect(classify(['docs/HARNESS.md', 'AGENTS.md', 'apps/web/e2e/README.md'])).toBe('false')
    expect(classify(['docs/mockups/submissions/index.html'])).toBe('false')
    expect(classify(['docs/HARNESS.md', 'scripts/harness/runner.ts'])).toBe('true')
    // MDX is site content.
    expect(classify(['apps/web/content/legal/terms-conditions.mdx'])).toBe('true')
    expect(classify(['.github/workflows/web.yml'])).toBe('true')
    // A push deploys, so it checks the tree it deploys whatever changed; unknown bases run
    // everything.
    expect(classify(['docs/HARNESS.md'], { GITHUB_EVENT_NAME: 'push' })).toBe('true')
    expect(classify(['docs/HARNESS.md'], { GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe('true')
    expect(classify(['docs/HARNESS.md'], { BASE: '' })).toBe('true')
    expect(classify(['docs/HARNESS.md'], { CAT_STATUS: '128' })).toBe('true')
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

  it('deploys only the staging tip, and fails when the tip cannot be read', () => {
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
    for (const job of ['changes', 'e2e', 'deploy-staging']) {
      expect(workflow.jobs[job]?.['runs-on'], job).toBe(githubHostedRunner)
    }
    expect(source).not.toMatch(/self-hosted/u)
  })

  it('installs Playwright browsers without sudo-only system dependency escalation', () => {
    const runs = (workflow.jobs.e2e?.steps ?? []).map(candidate => candidate.run).filter(Boolean)
    expect(runs).toContain('pnpm --filter web test:install')
    expect(runs).toContain('pnpm test:e2e')
    expect(source).not.toContain('--with-deps')
  })
})
