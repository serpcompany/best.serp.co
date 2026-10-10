import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDocumentation,
  DOC_LINE_ALLOWANCES,
  isMaintainedFile,
  markdownAnchors,
  validateDocumentationBudgets,
  validateDocumentNames,
  validateLinkAnchor,
  validatePlanningDocumentation,
  wrappedLineCount
} from './harness/docs-health.ts'
import { stepsForProfile } from './harness/runner.ts'

describe('repository harness contract', () => {
  it('keeps documentation, indexes, skills, links, and commands healthy', () => {
    expect(checkDocumentation(resolve('.'))).toEqual([])
  })

  it('leaves .archive/ out of the documentation checks: it keeps history as it was', () => {
    expect(isMaintainedFile('.archive/releases/2026-10-06-promotion-plan.md')).toBe(false)
    expect(isMaintainedFile('docs/harness.md')).toBe(true)
    expect(isMaintainedFile('apps/web/docs/agents/web.md')).toBe(true)
  })

  it('names every doc and folder under docs/ in kebab-case (#190)', () => {
    expect(
      validateDocumentNames([
        'docs/README.md',
        'docs/deploy-runbook.md',
        'docs/agents/issue-tracker.md',
        'AGENTS.md',
        'apps/web/docs/agents/web.md',
        'docs/DATA_MODEL.md',
        'docs/Mockups/copy.md'
      ])
    ).toEqual([
      'docs/DATA_MODEL.md: not kebab-case; use lowercase words joined by hyphens (only README.md, AGENTS.md and CLAUDE.md are uppercase)',
      'docs/Mockups: not kebab-case; use lowercase words joined by hyphens (only README.md, AGENTS.md and CLAUDE.md are uppercase)'
    ])
  })

  it("reads a doc's anchors as GitHub writes them (#190)", () => {
    const anchors = markdownAnchors(
      [
        '# Release guards',
        '## `db:*` commands by target',
        '## Staging before production',
        '## Staging before production',
        '### [Linked](./x.md) heading',
        '```md',
        '## Not a heading',
        '```',
        '<a id="custom-anchor"></a>'
      ].join('\n')
    )
    expect([...anchors]).toEqual([
      'release-guards',
      'db-commands-by-target',
      'staging-before-production',
      'staging-before-production-1',
      'linked-heading',
      'custom-anchor'
    ])
  })

  it('fails a link whose anchor names no heading in its target doc (#190)', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-anchors-'))
    try {
      writeFileSync(join(root, 'runbook.md'), '# Runbook\n\n## After a deploy\n')
      writeFileSync(join(root, 'caching.md'), '# Caching\n\n## Why this design\n')
      const check = (target: string) => validateLinkAnchor(root, 'caching.md', target)
      expect(check('./runbook.md#after-a-deploy')).toBeNull()
      expect(check('#why-this-design')).toBeNull()
      expect(check('./runbook.md')).toBeNull()
      expect(check('./runbook.md#caching-after-a-deploy')).toBe(
        'caching.md: broken anchor ./runbook.md#caching-after-a-deploy'
      )
      expect(check('#gone')).toBe('caching.md: broken anchor #gone')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
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
          'docs/harness.md': lines(300),
          'docs/deploy-runbook.md': lines(301),
          'apps/web/content/legal/terms.mdx': lines(500),
          'SECURITY.md': lines(500)
        },
        {}
      )
    ).toEqual([
      'apps/web/AGENTS.md: 121 wrapped lines exceeds the map budget of 120; move detail into a leaf doc',
      'docs/README.md: 121 wrapped lines exceeds the map budget of 120; move detail into a leaf doc',
      'docs/deploy-runbook.md: 301 wrapped lines exceeds the leaf budget of 300; split it by topic'
    ])
  })

  it('lets an allowed doc shrink but not grow', () => {
    const lines = (count: number) => Array.from({ length: count }, () => 'line').join('\n')
    const allowances = { 'docs/LEGACY.md': 340 }
    for (const size of [340, 320, 301])
      expect(validateDocumentationBudgets({ 'docs/LEGACY.md': lines(size) }, allowances)).toEqual(
        []
      )
    expect(validateDocumentationBudgets({ 'docs/LEGACY.md': lines(341) }, allowances)).toEqual([
      'docs/LEGACY.md: 341 wrapped lines exceeds its allowance of 340; an over-budget doc may shrink but not grow, so split it by topic'
    ])
    // An allowance covers only its own file.
    expect(
      validateDocumentationBudgets(
        { 'docs/LEGACY.md': lines(320), 'docs/harness.md': lines(301) },
        allowances
      )
    ).toEqual([
      'docs/harness.md: 301 wrapped lines exceeds the leaf budget of 300; split it by topic'
    ])
  })

  it('fails on an allowance that is no longer needed, so its entry gets deleted', () => {
    const lines = (count: number) => Array.from({ length: count }, () => 'line').join('\n')
    expect(
      validateDocumentationBudgets(
        { 'docs/LEGACY.md': lines(300), 'docs/harness.md': lines(320) },
        { 'docs/GONE.md': 400, 'docs/harness.md': 350, 'docs/LEGACY.md': 340 }
      )
    ).toEqual([
      'docs/GONE.md: its allowance of 400 lines is no longer needed (no such budgeted doc); delete its DOC_LINE_ALLOWANCES entry in scripts/harness/docs-health.ts',
      'docs/LEGACY.md: its allowance of 340 lines is no longer needed (it fits its budget); delete its DOC_LINE_ALLOWANCES entry in scripts/harness/docs-health.ts'
    ])
    // Every doc fits today, so the table is empty; an entry is for a doc already over budget.
    expect(DOC_LINE_ALLOWANCES).toEqual({})
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
    const fast = stepsForProfile('fast', {}).map(step => step.name)
    const full = stepsForProfile('full', {}).map(step => step.name)
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
        'lint',
        'database migrations',
        'repository tests',
        'Cloudflare configuration',
        'Cloudflare types',
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
    const workflow = readFileSync(resolve('.github/workflows/web.yml'), 'utf8')
    // pnpm check runs documentation health and both Vitest projects (scripts/harness/runner.ts).
    expect(workflow).toContain('run: pnpm check')
  })
})
