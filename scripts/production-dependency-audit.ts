import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Severity = 'high' | 'critical'

interface PnpmAuditAdvisory {
  github_advisory_id?: string | null
  id: number | string
  module_name: string
  severity: string
}

interface PnpmAuditReport {
  advisories: Record<string, PnpmAuditAdvisory>
  metadata: {
    vulnerabilities: Record<'info' | 'low' | 'moderate' | Severity, number>
  }
}

export interface AuditFinding {
  id: string
  module: string
  severity: Severity
}

interface AuditReviewGroup {
  batch: string
  modules: string[]
  rationale: string
  target: string
}

export interface AuditBaseline {
  generatedAt: string
  reviewBy: string
  scope: 'production'
  advisories: Array<AuditFinding & { batch: string }>
  reviewGroups: Record<string, AuditReviewGroup>
}

export interface AuditResult {
  baselineMissing: boolean
  current: AuditFinding[]
  escalated: AuditFinding[]
  expired: boolean
  newFindings: AuditFinding[]
  resolved: AuditFinding[]
}

const DEFAULT_BASELINE = resolve('security/production-audit-baseline.json')
const GATING_SEVERITIES = new Set<Severity>(['high', 'critical'])
const AUDIT_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const MAX_BASELINE_HORIZON_DAYS = 45
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCalendarDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${field} must be a YYYY-MM-DD calendar date.`)
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a valid calendar date: ${value}`)
  }
  return date
}

function findingKey(finding: Pick<AuditFinding, 'id' | 'module'>): string {
  return `${finding.id}:${finding.module}`
}

function severityRank(severity: Severity): number {
  return severity === 'critical' ? 2 : 1
}

export function normalizeAuditReport(report: PnpmAuditReport): AuditFinding[] {
  const findings = new Map<string, AuditFinding>()

  for (const advisory of Object.values(report.advisories ?? {})) {
    if (!GATING_SEVERITIES.has(advisory.severity as Severity)) continue

    const finding: AuditFinding = {
      id: advisory.github_advisory_id || String(advisory.id),
      module: advisory.module_name,
      severity: advisory.severity as Severity
    }
    const key = findingKey(finding)
    const previous = findings.get(key)
    if (!previous || severityRank(finding.severity) > severityRank(previous.severity)) {
      findings.set(key, finding)
    }
  }

  return [...findings.values()].sort((left, right) =>
    findingKey(left).localeCompare(findingKey(right))
  )
}

export function validateAuditReport(value: unknown): PnpmAuditReport {
  if (!isRecord(value)) throw new Error('pnpm audit output must be a JSON object.')
  if (Object.hasOwn(value, 'error')) {
    throw new Error('pnpm audit returned an error-shaped response; refusing to treat it as clean.')
  }
  if (!isRecord(value.advisories)) {
    throw new Error('pnpm audit output is missing the advisories object.')
  }
  if (!isRecord(value.metadata) || !isRecord(value.metadata.vulnerabilities)) {
    throw new Error('pnpm audit output is missing vulnerability metadata.')
  }

  const severityCounts = value.metadata.vulnerabilities
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical'] as const) {
    const count = severityCounts[severity]
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error(`pnpm audit vulnerability metadata has an invalid ${severity} count.`)
    }
  }

  const seenSeverities = new Set<string>()
  for (const [key, advisory] of Object.entries(value.advisories)) {
    if (
      !isRecord(advisory) ||
      !('id' in advisory) ||
      !['string', 'number'].includes(typeof advisory.id) ||
      (typeof advisory.id === 'string' && advisory.id.length === 0) ||
      (typeof advisory.id === 'number' && !Number.isFinite(advisory.id)) ||
      (advisory.github_advisory_id !== undefined &&
        advisory.github_advisory_id !== null &&
        (typeof advisory.github_advisory_id !== 'string' ||
          advisory.github_advisory_id.length === 0)) ||
      typeof advisory.module_name !== 'string' ||
      advisory.module_name.length === 0 ||
      typeof advisory.severity !== 'string' ||
      !AUDIT_SEVERITIES.has(advisory.severity)
    ) {
      throw new Error(`pnpm audit advisory ${key} is malformed.`)
    }
    seenSeverities.add(advisory.severity)
  }

  for (const severity of GATING_SEVERITIES) {
    if ((severityCounts[severity] as number) > 0 && !seenSeverities.has(severity)) {
      throw new Error(
        `pnpm audit reports ${severity} vulnerabilities but supplies no ${severity} advisories.`
      )
    }
  }

  return value as unknown as PnpmAuditReport
}

export function validateAuditBaseline(value: unknown, now = new Date()): AuditBaseline {
  if (!isRecord(value) || value.scope !== 'production') {
    throw new Error('Production audit baseline must be an object with scope "production".')
  }

  const generatedAt = parseCalendarDate(value.generatedAt, 'baseline generatedAt')
  const reviewBy = parseCalendarDate(value.reviewBy, 'baseline reviewBy')
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  if (generatedAt.valueOf() > today + MILLISECONDS_PER_DAY) {
    throw new Error('Baseline generatedAt cannot be in the future.')
  }
  const horizonDays = (reviewBy.valueOf() - generatedAt.valueOf()) / MILLISECONDS_PER_DAY
  if (horizonDays < 0 || horizonDays > MAX_BASELINE_HORIZON_DAYS) {
    throw new Error(
      `Baseline reviewBy must be between generatedAt and ${MAX_BASELINE_HORIZON_DAYS} days later.`
    )
  }
  if (!Array.isArray(value.advisories)) {
    throw new Error('Production audit baseline advisories must be an array.')
  }
  if (!isRecord(value.reviewGroups)) {
    throw new Error('Production audit baseline reviewGroups must be an object.')
  }

  const reviewGroups = new Map<string, AuditReviewGroup>()
  for (const [name, rawGroup] of Object.entries(value.reviewGroups)) {
    if (
      name.length === 0 ||
      !isRecord(rawGroup) ||
      typeof rawGroup.batch !== 'string' ||
      rawGroup.batch.length === 0 ||
      !Array.isArray(rawGroup.modules) ||
      rawGroup.modules.length === 0 ||
      rawGroup.modules.some(moduleName => typeof moduleName !== 'string' || !moduleName) ||
      new Set(rawGroup.modules).size !== rawGroup.modules.length ||
      typeof rawGroup.rationale !== 'string' ||
      rawGroup.rationale.length < 30 ||
      typeof rawGroup.target !== 'string' ||
      rawGroup.target.length < 10
    ) {
      throw new Error(`Baseline review group ${name} is malformed or lacks reviewed context.`)
    }
    reviewGroups.set(name, {
      batch: rawGroup.batch as string,
      modules: rawGroup.modules as string[],
      rationale: rawGroup.rationale as string,
      target: rawGroup.target as string
    })
  }

  const identities = new Set<string>()
  const usedGroups = new Set<string>()
  for (const [index, rawFinding] of value.advisories.entries()) {
    if (
      !isRecord(rawFinding) ||
      typeof rawFinding.id !== 'string' ||
      rawFinding.id.length === 0 ||
      typeof rawFinding.module !== 'string' ||
      rawFinding.module.length === 0 ||
      !GATING_SEVERITIES.has(rawFinding.severity as Severity) ||
      typeof rawFinding.batch !== 'string' ||
      rawFinding.batch.length === 0
    ) {
      throw new Error(`Baseline advisory at index ${index} is malformed.`)
    }

    const identity = findingKey(rawFinding as unknown as AuditFinding)
    if (identities.has(identity))
      throw new Error(`Duplicate baseline advisory identity: ${identity}`)
    identities.add(identity)

    const matchingGroups = [...reviewGroups.entries()].filter(
      ([, group]) =>
        group.batch === rawFinding.batch && group.modules.includes(rawFinding.module as string)
    )
    if (matchingGroups.length !== 1) {
      throw new Error(
        `Baseline advisory ${identity} must be covered by exactly one review group for its batch and module.`
      )
    }
    usedGroups.add(matchingGroups[0]?.[0] as string)
  }

  for (const groupName of reviewGroups.keys()) {
    if (!usedGroups.has(groupName)) throw new Error(`Baseline review group ${groupName} is unused.`)
  }

  return value as unknown as AuditBaseline
}

export function compareWithBaseline(
  current: AuditFinding[],
  baseline: AuditBaseline | null,
  now = new Date()
): AuditResult {
  if (!baseline) {
    return {
      baselineMissing: true,
      current,
      escalated: [],
      expired: false,
      newFindings: [],
      resolved: []
    }
  }

  const baselineByKey = new Map(baseline.advisories.map(finding => [findingKey(finding), finding]))
  const currentByKey = new Map(current.map(finding => [findingKey(finding), finding]))
  const newFindings = current.filter(finding => !baselineByKey.has(findingKey(finding)))
  const escalated = current.filter(finding => {
    const previous = baselineByKey.get(findingKey(finding))
    return previous ? severityRank(finding.severity) > severityRank(previous.severity) : false
  })
  const resolved = baseline.advisories
    .filter(finding => !currentByKey.has(findingKey(finding)))
    .map(({ id, module, severity }) => ({ id, module, severity }))
  const deadline = new Date(`${baseline.reviewBy}T23:59:59.999Z`)

  if (Number.isNaN(deadline.valueOf())) {
    throw new Error(`Invalid baseline reviewBy date: ${baseline.reviewBy}`)
  }

  return {
    baselineMissing: false,
    current,
    escalated,
    expired: now.valueOf() > deadline.valueOf(),
    newFindings,
    resolved
  }
}

function readAuditReport(inputPath?: string): PnpmAuditReport {
  if (inputPath) return validateAuditReport(JSON.parse(readFileSync(resolve(inputPath), 'utf8')))

  const audit = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })

  if (audit.error) throw audit.error
  if (!audit.stdout.trim()) {
    throw new Error(`pnpm audit produced no JSON output. ${audit.stderr.trim()}`.trim())
  }

  return validateAuditReport(JSON.parse(audit.stdout))
}

function formatFinding(finding: AuditFinding): string {
  return `${finding.severity.toUpperCase()} ${finding.id} (${finding.module})`
}

function reportResult(result: AuditResult, baseline: AuditBaseline | null): void {
  const lines = [
    '# Production dependency audit',
    '',
    `High/critical advisory-package identities: ${result.current.length}`
  ]

  if (result.baselineMissing) {
    lines.push(
      '',
      '::warning::No reviewed production audit baseline exists; reporting without gating.',
      'Create security/production-audit-baseline.json through review before enabling enforcement.'
    )
  } else {
    lines.push(
      `Reviewed baseline identities still present: ${result.current.length - result.newFindings.length}`,
      `New identities: ${result.newFindings.length}`,
      `Severity escalations: ${result.escalated.length}`,
      `Resolved baseline identities: ${result.resolved.length}`,
      `Baseline review deadline: ${baseline?.reviewBy}`,
      '',
      `::warning::${result.current.length} high/critical production advisory-package identities remain; a passing check only means no new debt.`
    )
  }

  for (const finding of result.newFindings) lines.push(`::error::New ${formatFinding(finding)}`)
  for (const finding of result.escalated) lines.push(`::error::Escalated ${formatFinding(finding)}`)
  for (const finding of result.resolved) lines.push(`Resolved: ${formatFinding(finding)}`)
  if (result.expired)
    lines.push('::error::The production dependency audit baseline review deadline has expired.')

  const output = lines.join('\n')
  console.log(output)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${output}\n`)
}

function parseArguments(args: string[]): { baselinePath: string; inputPath?: string; now?: Date } {
  let baselinePath = DEFAULT_BASELINE
  let inputPath: string | undefined
  let now: Date | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--baseline' && value) {
      baselinePath = resolve(value)
      index += 1
    } else if (argument === '--input' && value) {
      inputPath = value
      index += 1
    } else if (argument === '--now' && value) {
      now = new Date(`${value}T00:00:00.000Z`)
      if (Number.isNaN(now.valueOf())) throw new Error(`Invalid --now date: ${value}`)
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
  }

  return { baselinePath, inputPath, now }
}

export function runProductionDependencyAudit(args = process.argv.slice(2)): number {
  const options = parseArguments(args)
  const report = readAuditReport(options.inputPath)
  const current = normalizeAuditReport(report)
  const baseline = existsSync(options.baselinePath)
    ? validateAuditBaseline(
        JSON.parse(readFileSync(options.baselinePath, 'utf8')),
        options.now ?? new Date()
      )
    : null
  const result = compareWithBaseline(current, baseline, options.now)

  reportResult(result, baseline)
  return result.newFindings.length > 0 || result.escalated.length > 0 || result.expired ? 1 : 0
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isEntrypoint) {
  try {
    process.exitCode = runProductionDependencyAudit()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
