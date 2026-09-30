import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDocumentation,
  validateMultisiteDocumentation,
  validatePlanningDocumentation,
  validateReleaseDocumentation
} from './harness/docs-health.ts'
import { stepsForProfile } from './harness/runner.ts'

describe('repository harness contract', () => {
  it('keeps documentation, indexes, skills, links, and commands healthy', () => {
    expect(checkDocumentation(resolve('.'))).toEqual([])
  })

  it('rejects a registered site omitted from core multisite guidance', () => {
    expect(
      validateMultisiteDocumentation(
        {
          'docs/ONBOARDING.md': 'The active sites are serp.software.'
        },
        ['serp.software', 'example.com']
      )
    ).toContain('docs/ONBOARDING.md: active site "example.com" is missing from multisite guidance')
  })

  it('rejects retired single-site assertions', () => {
    expect(
      validateMultisiteDocumentation(
        {
          'docs/MIGRATION_SOP.md':
            'The current repository deploys one application and one tenant: serp.software.'
        },
        ['serp.software']
      )
    ).toContain(
      'docs/MIGRATION_SOP.md: retired single-site assertion "The current repository deploys one application and one tenant"'
    )
  })

  it('rejects stale or incomplete release handoff guidance', () => {
    expect(
      validateReleaseDocumentation({
        'docs/BUILD_PIPELINE.md': 'Deploy with worker-only.',
        'docs/DATA_OPS_BENCHMARK.md': 'Production untouched.',
        'docs/DEPLOY_RUNBOOK.md': 'Functional checks passed.'
      })
    ).toEqual(
      expect.arrayContaining([
        'docs/BUILD_PIPELINE.md: missing release guidance "`packages/data-ops/`"',
        'docs/DEPLOY_RUNBOOK.md: missing release guidance "`check-schema`"',
        'docs/DATA_OPS_BENCHMARK.md: missing release guidance "## Production follow-up recorded 2026-07-31"'
      ])
    )
  })

  it('rejects retired Markdown planning references', () => {
    expect(
      validatePlanningDocumentation({
        'AGENTS.md': 'Create an ExecPlan from PLANS.md.'
      })
    ).toEqual([
      'AGENTS.md: retired Markdown planning reference "PLANS.md"',
      'AGENTS.md: retired Markdown planning reference "ExecPlan"'
    ])
  })

  it('makes the full loop a strict superset of the fast loop', () => {
    const fast = stepsForProfile('fast').map(step => step.name)
    const full = stepsForProfile('full').map(step => step.name)
    expect(fast).toEqual([
      'documentation health',
      'D1 architecture guard',
      'catalog data operations',
      'D1 contracts',
      'TypeScript boundaries'
    ])
    expect(full.slice(0, fast.length)).toEqual(fast)
    expect(full).toEqual(
      expect.arrayContaining([
        'read-only lint',
        'repository tests',
        'Cloudflare configuration',
        'OpenNext Worker build'
      ])
    )
  })

  it('runs deterministic harness gardening without write or deployment authority', () => {
    const workflow = readFileSync(resolve('.github/workflows/harness-gardening.yml'), 'utf8')
    expect(workflow).toContain('schedule:')
    expect(workflow).toContain('run: pnpm docs:garden')
    expect(workflow).toContain('run: pnpm harness:fast')
    expect(workflow).not.toMatch(/deploy|CLOUDFLARE_API_TOKEN|contents: write/u)
  })

  it('keeps documentation and D1 contracts visible in pull-request validation', () => {
    const workflow = readFileSync(resolve('.github/workflows/pr-review.yml'), 'utf8')
    expect(workflow).toContain('run: pnpm docs:check')
    expect(workflow).toContain('run: pnpm test:repo')
    expect(workflow).toContain('run: pnpm test:d1')
  })
})
