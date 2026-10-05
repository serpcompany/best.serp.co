import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { routedRunsOn } from './ci-runners'

interface LabelerDefinition {
  [labelName: string]: Array<{
    'changed-files'?: Array<{
      'any-glob-to-any-file'?: string[]
    }>
  }>
}

interface LabelsWorkflow {
  jobs: Record<
    string,
    {
      'runs-on'?: string
      steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>
    }
  >
  on: unknown
}

function loadLabelsWorkflow(): string {
  return readFileSync(resolve(process.cwd(), '.github/workflows/labels.yml'), 'utf8')
}

function loadLabelerRules(): LabelerDefinition {
  return yaml.load(
    readFileSync(resolve(process.cwd(), '.github/labeler.yml'), 'utf8')
  ) as LabelerDefinition
}

describe('labels workflow', () => {
  it('only manages the active content label for current listing-entry sources', () => {
    const workflow = loadLabelsWorkflow()

    expect(workflow).toContain("name: 'area:content'")
    expect(workflow).not.toContain("name: 'lane:mdx-fast'")
    expect(workflow).not.toContain("name: 'lane:standard'")
    expect(workflow).not.toContain("name: 'lane:blocked'")
    expect(workflow).not.toContain("name: 'status:blocked'")
    expect(workflow).not.toContain("name: 'automerge:candidate'")
  })

  it('labels pull requests without checking out or running pull request code', () => {
    const source = loadLabelsWorkflow()
    const workflow = yaml.load(source) as LabelsWorkflow
    const job = workflow.jobs.triage
    const steps = job?.steps ?? []
    const checkouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'))

    // pull_request_target runs with a write token, and a fork's pull request runs on
    // ubuntu-latest whatever CI_RUNNER_LABELS says.
    expect(workflow.on).toEqual(['pull_request_target'])
    expect(Object.keys(workflow.jobs)).toEqual(['triage'])
    expect(job?.['runs-on']).toBe(routedRunsOn)
    expect(steps.filter(step => step.run)).toEqual([])
    // Only the labeler rules, from the base commit (no ref), so a persistent workspace cannot
    // hand the labeler another branch's rules.
    expect(checkouts).toEqual([
      {
        name: 'Check out the base labeler rules',
        uses: 'actions/checkout@v7',
        with: {
          'persist-credentials': false,
          'sparse-checkout': '.github/labeler.yml',
          'sparse-checkout-cone-mode': false
        }
      }
    ])
    const labeler = steps.findIndex(step => step.uses?.startsWith('actions/labeler@'))
    expect(steps[labeler - 1]).toBe(checkouts[0])
    expect(source).not.toMatch(/head\.(?:sha|ref)|head_ref|refs\/pull/u)
    expect(source.match(/pull_request\.head\.repo\.full_name/gu)).toHaveLength(1)
  })

  it('labels D1 catalog review inputs', () => {
    const labelerRules = loadLabelerRules()
    const contentRules = labelerRules['area:content']

    expect(contentRules).toBeDefined()

    const globs =
      contentRules
        ?.flatMap(rule => rule['changed-files'] || [])
        .flatMap(rule => rule['any-glob-to-any-file'] || []) || []

    expect(globs).toEqual(
      expect.arrayContaining(['d1/drizzle/**', 'apps/web/lib/submissions/**', 'd1/publications/**'])
    )
    expect(globs.join('\n')).not.toMatch(/d1\/migrations|serp\.software|pornvideodownloaders/u)
  })
})
