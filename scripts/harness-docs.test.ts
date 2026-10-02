import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDocumentation,
  DOC_LINE_ALLOWANCES,
  unusedDocumentationAllowances,
  validateDocumentationBudgets,
  validatePlanningDocumentation,
  wrappedLineCount
} from './harness/docs-health.ts'
import { stepsForProfile } from './harness/runner.ts'

describe('repository harness contract', () => {
  it('keeps documentation, indexes, skills, links, and commands healthy', () => {
    expect(checkDocumentation(resolve('.'))).toEqual([])
  })

  it('holds maps and leaves to the docs-are-maps size budgets at 100 columns', () => {
    expect(wrappedLineCount(`short\n${'x'.repeat(250)}\n\n`)).toBe(4)
    const lines = (count: number) => Array.from({ length: count }, () => 'line').join('\n')
    expect(
      validateDocumentationBudgets(
        {
          'AGENTS.md': lines(120),
          'apps/web/AGENTS.md': `${lines(119)}\n${'x'.repeat(101)}`,
          'docs/README.md': lines(121),
          'docs/HARNESS.md': lines(300),
          'docs/DEPLOY_RUNBOOK.md': lines(301),
          'packages/content/data/legal/terms.mdx': lines(500),
          'SECURITY.md': lines(500)
        },
        {}
      )
    ).toEqual([
      'apps/web/AGENTS.md: 121 wrapped lines exceeds the map budget of 120; move detail into a leaf doc',
      'docs/README.md: 121 wrapped lines exceeds the map budget of 120; move detail into a leaf doc',
      'docs/DEPLOY_RUNBOOK.md: 301 wrapped lines exceeds the leaf budget of 300; split it by topic'
    ])
  })

  it('lets an allowed doc shrink but not grow, whichever pull request lands first', () => {
    const lines = (count: number) => Array.from({ length: count }, () => 'line').join('\n')
    const allowances = { 'docs/DEPLOY_RUNBOOK.md': 304 }
    // Before the growing pull request merges, after it, and after a later split.
    for (const size of [231, 304, 290, 120])
      expect(
        validateDocumentationBudgets({ 'docs/DEPLOY_RUNBOOK.md': lines(size) }, allowances)
      ).toEqual([])
    expect(
      validateDocumentationBudgets({ 'docs/DEPLOY_RUNBOOK.md': lines(305) }, allowances)
    ).toEqual([
      'docs/DEPLOY_RUNBOOK.md: 305 wrapped lines exceeds its allowance of 304; an over-budget doc may shrink but not grow, so split it by topic'
    ])
    // An allowance covers only its own file.
    expect(validateDocumentationBudgets({ 'docs/HARNESS.md': lines(301) }, allowances)).toEqual([
      'docs/HARNESS.md: 301 wrapped lines exceeds the leaf budget of 300; split it by topic'
    ])
  })

  it('lists allowances that no longer hold a doc back, without failing the check', () => {
    const lines = (count: number) => Array.from({ length: count }, () => 'line').join('\n')
    const allowances = {
      'docs/DEPLOY_RUNBOOK.md': 304,
      'docs/GONE.md': 400,
      'docs/HARNESS.md': 350
    }
    expect(
      unusedDocumentationAllowances(
        { 'docs/DEPLOY_RUNBOOK.md': lines(231), 'docs/HARNESS.md': lines(320) },
        allowances
      )
    ).toEqual(['docs/DEPLOY_RUNBOOK.md', 'docs/GONE.md'])
    expect(Object.values(DOC_LINE_ALLOWANCES).every(allowance => allowance > 300)).toBe(true)
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
