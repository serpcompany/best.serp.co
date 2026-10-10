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
  'docs/architecture.md',
  'docs/data-model.md',
  'docs/development.md',
  'docs/deploy-runbook.md',
  'docs/dependency-security.md',
  'docs/harness.md',
  'docs/agents/domain.md',
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  '.github/workflows/harness-gardening.yml'
] as const

/**
 * Whether the checks below hold a file to the documentation rules. `.archive/` keeps history
 * as it was (serp's docs README, #315): it is read, not maintained, so its links and sizes go
 * unchecked.
 */
export function isMaintainedFile(file: string): boolean {
  return !file.startsWith('.archive/')
}

function repositoryFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(file => file && isMaintainedFile(file))
}

function markdownLinkTargets(source: string, { anchors = false } = {}): string[] {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map(match => match[1]?.trim() || '')
    .filter(
      target =>
        target.length > 0 &&
        (anchors || !target.startsWith('#')) &&
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

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const UPPERCASE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md'])

/**
 * Every folder and file under `docs/` is named in kebab-case; only `README.md`, `AGENTS.md`
 * and `CLAUDE.md` are uppercase (serp's docs README, "Writing Guidance").
 */
export function validateDocumentNames(files: readonly string[]): string[] {
  const misnamed = new Set<string>()
  for (const file of files.filter(candidate => candidate.startsWith('docs/'))) {
    const segments = file.split('/').slice(1)
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1
      if (isFile && UPPERCASE_NAMES.has(segment)) return
      const name = isFile ? segment.replace(/\.[^.]+$/u, '') : segment
      if (!KEBAB_CASE.test(name)) misnamed.add(['docs', ...segments.slice(0, index + 1)].join('/'))
    })
  }
  return [...misnamed].map(
    path =>
      `${path}: not kebab-case; use lowercase words joined by hyphens (only README.md, AGENTS.md and CLAUDE.md are uppercase)`
  )
}

/**
 * The anchors GitHub gives a Markdown file's headings: the heading's text, lowercased, with
 * everything but letters, digits, spaces, hyphens and underscores removed and spaces made
 * hyphens; a repeated slug gets `-1`, `-2`, and so on. Headings inside code fences don't count;
 * `<a id>` and `<a name>` anchors do.
 */
export function markdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  let fence: string | null = null
  for (const line of source.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as string
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) {
      if (match[1]) anchors.add(match[1])
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line)
    if (!heading?.[1]) continue
    const text = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/<[^>]+>/gu, '')
      .replace(/`/gu, '')
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/gu, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

/** A local Markdown link's `#fragment` that names no heading or anchor in its target file. */
function validateLinkAnchor(root: string, sourcePath: string, rawTarget: string): string | null {
  const targetWithoutTitle = rawTarget.split(/\s+"/u)[0] || rawTarget
  const target = targetWithoutTitle.replace(/^<|>$/gu, '')
  const hash = target.indexOf('#')
  if (hash === -1) return null
  const path = target.slice(0, hash)
  const fragment = decodeURIComponent(target.slice(hash + 1))
  if (!fragment) return null
  const file = path
    ? resolve(root, dirname(sourcePath), decodeURIComponent(path))
    : resolve(root, sourcePath)
  if (extname(file) !== '.md' || !existsSync(file) || statSync(file).isDirectory()) return null
  if (markdownAnchors(readFileSync(file, 'utf8')).has(fragment.toLowerCase())) return null
  return `${sourcePath}: broken anchor ${rawTarget}`
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

/**
 * Docs allowed over budget, at the size they had when they were let in (serp's allowance
 * rule). Each may shrink but not grow, and docs:check fails once it fits its budget, so the
 * entry gets deleted. Record only a doc that is already over budget on `main`; split a doc that
 * a pull request grows past its budget instead of adding an entry for it.
 */
export const DOC_LINE_ALLOWANCES: Readonly<Record<string, number>> = {}

/** Lines as read at 100 columns, so a long paragraph counts for its real length. */
export function wrappedLineCount(source: string): number {
  return source
    .trimEnd()
    .split('\n')
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / WRAP_COLUMNS)),
      0
    )
}

function documentationBudget(file: string): { budget: number; kind: 'leaf' | 'map' } | null {
  const name = file.split('/').at(-1)
  if (name === 'AGENTS.md' || name === 'README.md') return { budget: MAP_LINE_BUDGET, kind: 'map' }
  if (file.startsWith('docs/')) return { budget: LEAF_LINE_BUDGET, kind: 'leaf' }
  return null
}

/**
 * Size budgets: maps (`AGENTS.md`, `README.md`) stay at or under 120 wrapped lines and every
 * other doc under `docs/` at or under 300, unless `allowances` holds a doc at a recorded size.
 * An allowance whose doc fits its budget or no longer exists fails too, so it gets deleted.
 * The numbers are serp's docs-are-maps budgets
 * (`docs/engineering/standards/agent-harness/docs-are-maps.md`), counted in code points.
 */
export function validateDocumentationBudgets(
  documents: Readonly<Record<string, string>>,
  allowances: Readonly<Record<string, number>> = DOC_LINE_ALLOWANCES
): string[] {
  const violations: string[] = []
  for (const [file, source] of Object.entries(documents)) {
    const limit = documentationBudget(file)
    if (!limit) continue
    const lines = wrappedLineCount(source)
    const allowance = allowances[file]
    if (lines <= Math.max(limit.budget, allowance ?? 0)) continue
    violations.push(
      allowance === undefined
        ? `${file}: ${lines} wrapped lines exceeds the ${limit.kind} budget of ${limit.budget}; ${
            limit.kind === 'map' ? 'move detail into a leaf doc' : 'split it by topic'
          }`
        : `${file}: ${lines} wrapped lines exceeds its allowance of ${allowance}; an over-budget doc may shrink but not grow, so split it by topic`
    )
  }
  for (const [file, allowance] of Object.entries(allowances)) {
    const source = documents[file]
    const limit = documentationBudget(file)
    if (source !== undefined && limit && wrappedLineCount(source) > limit.budget) continue
    violations.push(
      `${file}: its allowance of ${allowance} lines is no longer needed (${
        source === undefined || !limit ? 'no such budgeted doc' : 'it fits its budget'
      }); delete its DOC_LINE_ALLOWANCES entry in scripts/harness/docs-health.ts`
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
    for (const target of markdownLinkTargets(source, { anchors: true })) {
      const violation = validateLinkAnchor(root, file, target)
      if (violation) violations.push(violation)
    }
  }
  violations.push(...validateDocumentNames(files))

  for (const file of files.filter(candidate =>
    /^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(candidate)
  )) {
    violations.push(...validateSkill(root, file))
  }

  for (const file of files.filter(candidate => candidate.endsWith('package.json'))) {
    const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as {
      scripts?: Record<string, string>
    }
    for (const name of ['lint', 'check']) {
      if (manifest.scripts?.[name]?.includes('--write')) {
        violations.push(`${file}: ${name} must be read-only; move --write behavior to lint:fix`)
      }
    }
  }

  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  for (const script of [
    // The web stack standard's script names (#179); `check` is the finish gate.
    'lint',
    'format',
    'typecheck',
    'test',
    'test:e2e',
    'db:generate',
    'db:check',
    'check',
    'preview',
    'deploy:staging',
    'deploy:production',
    'docs:check',
    'docs:garden',
    'harness:fast',
    'harness:check',
    'agent:manifest',
    'agent:doctor',
    'agent:ui:capture',
    'worktree:new',
    'worktree:doctor',
    'worktree:destroy'
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
    console.error('See docs/harness.md#documentation-health for remediation.')
    process.exitCode = 1
    return
  }
  console.log('Documentation health passed: indexes, links, skills, and commands agree.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
