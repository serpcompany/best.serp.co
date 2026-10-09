import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { githubHostedRunner, routedJobs, routedRunsOn } from './ci-runners'

interface WorkflowStep {
  run?: string
  uses?: string
}

interface WorkflowJob {
  environment?: unknown
  'runs-on'?: unknown
  steps?: WorkflowStep[]
}

interface WorkflowDefinition {
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

const workflowDirectory = resolve('.github/workflows')
const workflowFiles = readdirSync(workflowDirectory).filter(file => file.endsWith('.yml'))

function allJobs(): Array<[string, WorkflowJob, WorkflowDefinition]> {
  return workflowFiles.flatMap(file => {
    const workflow = yaml.load(
      readFileSync(resolve(workflowDirectory, file), 'utf8')
    ) as WorkflowDefinition
    return Object.entries(workflow.jobs).map(
      ([name, job]) =>
        [`${file}:${name}`, job, workflow] as [string, WorkflowJob, WorkflowDefinition]
    )
  })
}

/** Workflows that hold Cloudflare or Google credentials or deploy: ephemeral VMs only. */
const credentialedWorkflows = [
  'deploy-production.yml',
  'media-health.yml',
  'publish-d1-staging.yml',
  'publish-d1.yml',
  'submit-gsc-sitemaps.yml',
  'upload-media-staging.yml',
  'upload-media.yml'
]

type Context = Record<string, unknown>

/**
 * Evaluates the GitHub expression subset `runs-on` uses (string literals, context paths, `==`,
 * `!=`, `&&`, `||`, parentheses, `fromJSON`) with GitHub's precedence and value semantics: a
 * missing context property is null, and `&&`/`||` return an operand, not a boolean.
 */
function evaluateExpression(expression: string, context: Context): unknown {
  const body = /^\$\{\{(.*)\}\}$/su.exec(expression)?.[1]
  if (body === undefined) throw new Error(`Not an expression: ${expression}`)
  const tokens = body.match(/'(?:[^']|'')*'|[A-Za-z_][\w.-]*|!=|==|&&|\|\||\S/gu) ?? []
  let position = 0
  const take = (expected?: string): string => {
    const token = tokens[position++]
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`Expected ${expected ?? 'a token'} at token ${position} of ${expression}`)
    }
    return token
  }
  const primary = (): unknown => {
    const token = take()
    if (token === '(') {
      const value = or()
      take(')')
      return value
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token === 'fromJSON') {
      take('(')
      const value = or()
      take(')')
      return JSON.parse(String(value))
    }
    if (!/^[A-Za-z_][\w.-]*$/u.test(token)) throw new Error(`Unsupported token ${token}`)
    return token
      .split('.')
      .reduce<unknown>(
        (value, key) => (value == null ? null : ((value as Context)[key] ?? null)),
        context
      )
  }
  const comparison = (): unknown => {
    const left = primary()
    const operator = tokens[position]
    if (operator !== '==' && operator !== '!=') return left
    take()
    const right = primary()
    return operator === '==' ? left === right : left !== right
  }
  const and = (): unknown => {
    let value = comparison()
    while (tokens[position] === '&&') {
      take()
      const right = comparison()
      value = value ? right : value
    }
    return value
  }
  const or = (): unknown => {
    let value = and()
    while (tokens[position] === '||') {
      take()
      const right = and()
      value = value ? value : right
    }
    return value
  }
  const result = or()
  if (position !== tokens.length) throw new Error(`Unparsed input in ${expression}`)
  return result
}

const repository = 'serpcompany/best.serp.co'
const selfHosted = ['self-hosted', 'linux', 'x64']

function runnerFor(event: Context, variable?: string): unknown {
  return evaluateExpression(routedRunsOn, {
    github: { event, repository },
    vars: variable === undefined ? {} : { CI_RUNNER_LABELS: variable }
  })
}

const pullRequestFrom = (headRepository: string | null) => ({
  pull_request: { head: { repo: headRepository === null ? null : { full_name: headRepository } } }
})

describe('CI runner routing', () => {
  it('routes exactly the credential-free CI jobs and pins every other job to ubuntu-latest', () => {
    const routed: string[] = []
    for (const [id, job] of allJobs()) {
      if (job['runs-on'] === routedRunsOn) routed.push(id)
      else expect(job['runs-on'], id).toBe(githubHostedRunner)
    }
    expect(routed.sort()).toEqual([...routedJobs].sort())
    expect(routedJobs).not.toContain('web.yml:e2e')
  })

  it('never hardcodes a self-hosted runner in a workflow', () => {
    for (const file of workflowFiles) {
      const source = readFileSync(resolve(workflowDirectory, file), 'utf8')
      expect(source, file).not.toMatch(/self-hosted/u)
    }
  })

  it('keeps E2E and every credentialed or deploying job on an ephemeral GitHub-hosted runner', () => {
    for (const [id, job, workflow] of allJobs()) {
      const source = JSON.stringify({ job, env: workflow.env ?? {} })
      // The job's own GITHUB_TOKEN is not a deployment credential.
      const credentialed =
        /secrets\.(?!GITHUB_TOKEN\b)/u.test(source) ||
        job.environment !== undefined ||
        credentialedWorkflows.includes(id.split(':')[0] as string)
      const browsers = /playwright|test:install|test:e2e/u.test(source)
      const privileged = /\bsudo\b|apt-get|\bapt install\b/u.test(source)
      if (credentialed || browsers || privileged) {
        expect(job['runs-on'], id).toBe(githubHostedRunner)
        expect(routedJobs, id).not.toContain(id)
      }
    }
    expect(credentialedWorkflows.every(file => workflowFiles.includes(file))).toBe(true)
  })

  it('evaluates the routing expression with GitHub precedence and types', () => {
    const sameRepository = pullRequestFrom(repository)
    const labels = JSON.stringify(selfHosted)

    // Unset: today's behaviour, every event on ubuntu-latest.
    expect(runnerFor(sameRepository)).toBe('ubuntu-latest')
    expect(runnerFor({})).toBe('ubuntu-latest')
    // Set: same-repository pull requests, pushes, schedules, and dispatches follow it.
    expect(runnerFor(sameRepository, labels)).toEqual(selfHosted)
    expect(runnerFor({}, labels)).toEqual(selfHosted)
    expect(runnerFor({}, '"my-runner"')).toBe('my-runner')
    // A fork's pull request (pull_request or pull_request_target) never leaves GitHub.
    expect(runnerFor(pullRequestFrom('someone/best.serp.co'), labels)).toBe('ubuntu-latest')
    // A deleted head repository is not this repository either.
    expect(runnerFor(pullRequestFrom(null), labels)).toBe('ubuntu-latest')
    // The value is JSON: a bare label fails the job loudly instead of guessing.
    expect(() => runnerFor(sameRepository, 'self-hosted')).toThrow(SyntaxError)
  })
})
