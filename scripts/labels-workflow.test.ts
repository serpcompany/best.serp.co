import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface LabelerDefinition {
  [labelName: string]: Array<{
    'changed-files'?: Array<{
      'any-glob-to-any-file'?: string[]
    }>
  }>
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

  it('labels D1 catalog review inputs', () => {
    const labelerRules = loadLabelerRules()
    const contentRules = labelerRules['area:content']

    expect(contentRules).toBeDefined()

    const globs =
      contentRules
        ?.flatMap(rule => rule['changed-files'] || [])
        .flatMap(rule => rule['any-glob-to-any-file'] || []) || []

    expect(globs).toContain('d1/migrations/**')
    expect(globs).toContain('apps/serp.software/lib/submissions/**')
    expect(globs).toContain('apps/pornvideodownloaders.com/lib/submissions/**')
    expect(globs).toContain('d1/publications/**')
  })
})
