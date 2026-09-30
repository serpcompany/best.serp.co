import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { siteIds } from '../site-targets.ts'

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
  'docs/MIGRATION_SOP.md',
  'docs/QUALITY_SCORE.md',
  'docs/agents/domain.md',
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  '.github/workflows/harness-gardening.yml',
  '.agents/skills/migrate-json-directory-site/SKILL.md'
] as const

const REQUIRED_MIGRATION_HEADINGS = [
  '# JSON-directory to D1 migration SOP',
  '## Scope and support boundary',
  '## Required evidence package',
  '## Phase 0: choose the tenancy architecture',
  '## Phase 1: freeze and inventory the source',
  '## Phase 2: map and normalize',
  '## Phase 3: construct deterministic D1 artifacts',
  '## Phase 4: prove local parity',
  '## Phase 5: provision Cloudflare safely',
  '## Phase 6: rehearse and release',
  '## Phase 7: remove the JSON architecture',
  '## Rollback and recovery',
  '## Completion checklist'
] as const

const MULTISITE_DOCUMENTS = [
  'AGENTS.md',
  'docs/ARCHITECTURE.md',
  'docs/BUILD_PIPELINE.md',
  'docs/DEPLOY_RUNBOOK.md',
  'docs/MIGRATION_SOP.md',
  'docs/ONBOARDING.md'
] as const

const RETIRED_SINGLE_SITE_ASSERTIONS = [
  'The current repository deploys one application and one tenant',
  'is the only application and deployable site in this repository',
  'no second site is currently enabled',
  'the current commands intentionally target only `serp.software`'
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

export function validateMultisiteDocumentation(
  documents: Readonly<Record<string, string>>,
  activeSiteIds: readonly string[]
): string[] {
  const violations: string[] = []

  for (const file of MULTISITE_DOCUMENTS) {
    const source = documents[file]
    if (source === undefined) continue
    for (const siteId of activeSiteIds) {
      if (!source.includes(siteId)) {
        violations.push(`${file}: active site "${siteId}" is missing from multisite guidance`)
      }
    }
  }

  for (const file of MULTISITE_DOCUMENTS) {
    const source = documents[file]
    if (source === undefined) continue
    for (const assertion of RETIRED_SINGLE_SITE_ASSERTIONS) {
      if (source.includes(assertion)) {
        violations.push(`${file}: retired single-site assertion "${assertion}"`)
      }
    }
  }

  return violations
}

export function validateReleaseDocumentation(
  documents: Readonly<Record<string, string>>
): string[] {
  const violations: string[] = []
  const requiredText = {
    'docs/BUILD_PIPELINE.md': [
      '`packages/data-ops/`',
      '`worker-only`',
      '`database-and-worker`',
      '`check-schema`'
    ],
    'docs/DEPLOY_RUNBOOK.md': [
      '`worker-only`',
      '`database-and-worker`',
      '`check-schema`',
      'fails closed',
      'Functional QA and D1 efficiency QA are separate gates'
    ],
    'docs/DATA_OPS_BENCHMARK.md': [
      '## Production follow-up recorded 2026-07-31',
      'actions/runs/30560826641',
      'actions/runs/30561183257'
    ]
  } as const

  for (const [file, requirements] of Object.entries(requiredText)) {
    const source = documents[file]
    if (source === undefined) continue
    for (const requirement of requirements) {
      if (!source.includes(requirement))
        violations.push(`${file}: missing release guidance "${requirement}"`)
    }
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

  const migrationPath = resolve(root, 'docs/MIGRATION_SOP.md')
  if (existsSync(migrationPath)) {
    const migration = readFileSync(migrationPath, 'utf8')
    for (const heading of REQUIRED_MIGRATION_HEADINGS) {
      if (!migration.includes(heading))
        violations.push(`docs/MIGRATION_SOP.md: missing "${heading}"`)
    }
  }

  const documentationSources = Object.fromEntries(
    files
      .filter(file => extname(file) === '.md')
      .map(file => [file, readFileSync(resolve(root, file), 'utf8')])
  )
  violations.push(...validateMultisiteDocumentation(documentationSources, siteIds))
  violations.push(...validateReleaseDocumentation(documentationSources))
  violations.push(...validatePlanningDocumentation(documentationSources))

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
  console.log(
    `Documentation health passed: indexes, links, active sites (${siteIds.join(', ')}), skills, and commands agree.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
