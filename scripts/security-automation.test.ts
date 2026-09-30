import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowJob {
  permissions?: Record<string, string>
}

interface WorkflowDefinition {
  jobs: Record<string, WorkflowJob>
  permissions?: Record<string, string>
}

interface DependabotUpdate {
  'package-ecosystem': string
  directory: string
  groups?: Record<string, unknown>
  'open-pull-requests-limit'?: number
  schedule?: { interval?: string }
}

describe('security automation', () => {
  it('gives every workflow an explicit least-privilege token boundary', () => {
    const workflowDirectory = resolve('.github/workflows')
    const violations: string[] = []

    for (const file of readdirSync(workflowDirectory).filter(file => file.endsWith('.yml'))) {
      const workflow = yaml.load(
        readFileSync(resolve(workflowDirectory, file), 'utf8')
      ) as WorkflowDefinition

      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const permissions = job.permissions ?? workflow.permissions
        if (!permissions || Object.keys(permissions).length === 0) {
          violations.push(`${file}:${jobName} has no explicit permissions`)
          continue
        }
        if ('write-all' in permissions) violations.push(`${file}:${jobName} grants write-all`)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps Search Console submission read-only at the GitHub token boundary', () => {
    const workflow = yaml.load(
      readFileSync(resolve('.github/workflows/submit-gsc-sitemaps.yml'), 'utf8')
    ) as WorkflowDefinition

    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('configures bounded weekly pnpm and GitHub Actions updates', () => {
    const dependabot = yaml.load(readFileSync(resolve('.github/dependabot.yml'), 'utf8')) as {
      version: number
      updates: DependabotUpdate[]
    }

    expect(dependabot.version).toBe(2)
    expect(dependabot.updates.map(update => update['package-ecosystem'])).toEqual([
      'npm',
      'github-actions'
    ])
    for (const update of dependabot.updates) {
      expect(update.directory).toBe('/')
      expect(update.schedule?.interval).toBe('weekly')
    }

    const npm = dependabot.updates[0]
    expect(npm?.['open-pull-requests-limit']).toBe(5)
    expect(npm?.groups).toBeUndefined()

    const actions = dependabot.updates[1]
    expect(Object.keys(actions?.groups ?? {})).not.toHaveLength(0)
  })

  it('keeps the production baseline reviewed, time-bounded, and explained', () => {
    const baseline = JSON.parse(
      readFileSync(resolve('security/production-audit-baseline.json'), 'utf8')
    ) as {
      advisories: Array<{ batch?: string; module?: string }>
      reviewBy?: string
      reviewGroups?: Record<
        string,
        { batch?: string; modules?: string[]; rationale?: string; target?: string }
      >
      scope?: string
    }

    expect(baseline.scope).toBe('production')
    expect(baseline.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(baseline.advisories.length).toBeGreaterThan(0)
    expect(Object.keys(baseline.reviewGroups ?? {})).not.toHaveLength(0)
    for (const advisory of baseline.advisories) {
      expect(advisory.batch).toBeTruthy()
      expect(
        Object.values(baseline.reviewGroups ?? {}).some(
          group => group.batch === advisory.batch && group.modules?.includes(advisory.module ?? '')
        )
      ).toBe(true)
    }
    for (const group of Object.values(baseline.reviewGroups ?? {})) {
      expect(group.rationale).toBeTruthy()
      expect(group.target).toBeTruthy()
    }
  })

  it('runs the production audit on pull requests, a schedule, and demand', () => {
    const source = readFileSync(resolve('.github/workflows/dependency-security.yml'), 'utf8')

    expect(source).toContain('pull_request:')
    expect(source).toContain('schedule:')
    expect(source).toContain('workflow_dispatch:')
    expect(source).toContain('run: pnpm security:audit:production')
    expect(source).toContain('permissions:\n  contents: read')
  })
})
