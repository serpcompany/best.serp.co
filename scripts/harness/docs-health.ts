import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_FILES = [
  'AGENTS.md',
  'CONTEXT.md',
  'README.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/ARCHITECTURE.md',
  'docs/DATA_MODEL.md',
  'docs/DEVELOPMENT.md',
  'docs/DEPLOY_RUNBOOK.md',
  'docs/DEPENDENCY_SECURITY.md',
  'docs/HARNESS.md',
  'docs/agents/domain.md',
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  '.github/workflows/harness-gardening.yml'
] as const

function repositoryFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
}

function markdownLinkTargets(source: string): string[] {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map(match => match[1]?.trim() || '')
    .filter(
      target =>
        target.length > 0 &&
        !target.startsWith('#') &&
        !target.startsWith('http://') &&
        !target.startsWith('https://') &&
        !target.startsWith('mailto:')
    )
}

function validateLocalLink(root: string, sourcePath: string, rawTarget: string): string | null {
  const targetWithoutTitle = rawTarget.split(/\s+"/u)[0] || rawTarget
  const decodedTarget = decodeURIComponent(targetWithoutTitle.replace(/^<|>$/gu, ''))
  const pathTarget = decodedTarget.split('#')[0]
  if (!pathTarget) return null

  const absolute = resolve(root, dirname(sourcePath), pathTarget)
  if (!existsSync(absolute)) return `${sourcePath}: broken local link ${rawTarget}`
  if (statSync(absolute).isDirectory() && !existsSync(resolve(absolute, 'README.md'))) {
    return `${sourcePath}: directory link ${rawTarget} has no README.md index`
  }
  return null
}

function validateSkill(root: string, file: string): string[] {
  const source = readFileSync(resolve(root, file), 'utf8')
  const violations: string[] = []
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/u.test(source)) {
    violations.push(`${file}: skill frontmatter must begin with name and description`)
  }
  if (source.split('\n').length > 500) {
    violations.push(`${file}: skill exceeds the 500-line progressive-disclosure limit`)
  }
  return violations
}

const WRAP_COLUMNS = 100
const MAP_LINE_BUDGET = 120
const LEAF_LINE_BUDGET = 300

/** Lines as read at 100 columns, so a long paragraph counts for its real length. */
export function wrappedLineCount(source: string): number {
  return source
    .trimEnd()
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / WRAP_COLUMNS)), 0)
}

/**
 * Size budgets from serpcompany/serp docs/engineering/standards/agent-harness/docs-are-maps.md:
 * maps (`AGENTS.md`, `README.md`) stay at or under 120 wrapped lines and every other doc under
 * `docs/` at or under 300. Split an oversized leaf by topic instead of squeezing it.
 */
export function validateDocumentationBudgets(
  documents: Readonly<Record<string, string>>
): string[] {
  const violations: string[] = []
  for (const [file, source] of Object.entries(documents)) {
    const name = file.split('/').at(-1)
    const isMap = name === 'AGENTS.md' || name === 'README.md'
    if (!isMap && !file.startsWith('docs/')) continue
    const budget = isMap ? MAP_LINE_BUDGET : LEAF_LINE_BUDGET
    const lines = wrappedLineCount(source)
    if (lines > budget)
      violations.push(
        `${file}: ${lines} wrapped lines exceeds the ${isMap ? 'map' : 'leaf'} budget of ${budget}; ${
          isMap ? 'move detail into a leaf doc' : 'split it by topic'
        }`
      )
  }
  return violations
}

export function validatePlanningDocumentation(
  documents: Readonly<Record<string, string>>
): string[] {
  const violations: string[] = []
  const retiredReferences = ['PLANS.md', 'docs/exec-plans', 'ExecPlan', 'write-exec-plan']

  for (const [file, source] of Object.entries(documents)) {
    for (const reference of retiredReferences) {
      if (source.includes(reference)) {
        violations.push(`${file}: retired Markdown planning reference "${reference}"`)
      }
    }
  }

  return violations
}

export function checkDocumentation(root = resolve('.')): string[] {
  const violations: string[] = []
  const files = repositoryFiles(root).filter(file => existsSync(resolve(root, file)))

  for (const file of REQUIRED_FILES) {
    if (!existsSync(resolve(root, file)))
      violations.push(`${file}: required harness document is missing`)
  }

  const agentsPath = resolve(root, 'AGENTS.md')
  if (existsSync(agentsPath)) {
    const lineCount = readFileSync(agentsPath, 'utf8').trimEnd().split('\n').length
    if (lineCount < 80 || lineCount > 120) {
      violations.push(`AGENTS.md: expected 80-120 lines; found ${lineCount}`)
    }
  }

  const documentationSources = Object.fromEntries(
    files
      .filter(file => extname(file) === '.md')
      .map(file => [file, readFileSync(resolve(root, file), 'utf8')])
  )
  violations.push(...validatePlanningDocumentation(documentationSources))
  violations.push(...validateDocumentationBudgets(documentationSources))

  for (const file of files.filter(candidate => extname(candidate) === '.md')) {
    const source = readFileSync(resolve(root, file), 'utf8')
    for (const target of markdownLinkTargets(source)) {
      const violation = validateLocalLink(root, file, target)
      if (violation) violations.push(violation)
    }
  }

  for (const file of files.filter(candidate =>
    /^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(candidate)
  )) {
    violations.push(...validateSkill(root, file))
  }

  for (const file of files.filter(candidate => candidate.endsWith('package.json'))) {
    const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const lint = manifest.scripts?.lint
    if (lint?.includes('--write')) {
      violations.push(`${file}: lint must be read-only; move --write behavior to lint:fix`)
    }
  }

  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  for (const script of [
    'docs:check',
    'docs:garden',
    'harness:fast',
    'harness:check',
    'validate',
    'agent:manifest',
    'agent:doctor',
    'agent:ui:capture',
    'worktree:new',
    'worktree:doctor',
    'worktree:destroy',
    'migration:preflight'
  ]) {
    if (!rootManifest.scripts?.[script]) violations.push(`package.json: missing ${script} command`)
  }

  return violations
}

function main(): void {
  const violations = checkDocumentation()
  if (violations.length > 0) {
    console.error('Documentation health failed:')
    for (const violation of violations) console.error(`- ${violation}`)
    console.error('See docs/HARNESS.md#documentation-health for remediation.')
    process.exitCode = 1
    return
  }
  console.log('Documentation health passed: indexes, links, skills, and commands agree.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
