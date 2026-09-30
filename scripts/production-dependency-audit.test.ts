import { describe, expect, it } from 'vitest'
import {
  type AuditBaseline,
  type AuditFinding,
  compareWithBaseline,
  normalizeAuditReport,
  validateAuditBaseline,
  validateAuditReport
} from './production-dependency-audit.ts'

const baseline: AuditBaseline = {
  generatedAt: '2026-09-26',
  reviewBy: '2026-10-31',
  scope: 'production',
  reviewGroups: {
    'framework-runtime': {
      batch: 'framework-runtime',
      modules: ['runtime-package'],
      rationale: 'The runtime package requires a coordinated framework compatibility upgrade.',
      target: 'Issue #93 framework/runtime upgrade batch'
    }
  },
  advisories: [
    {
      id: 'GHSA-existing',
      module: 'runtime-package',
      severity: 'high',
      batch: 'framework-runtime'
    }
  ]
}

describe('production dependency audit', () => {
  it('normalizes and deduplicates high and critical advisory-package identities', () => {
    expect(
      normalizeAuditReport({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0 }
        },
        advisories: {
          '1': {
            github_advisory_id: 'GHSA-existing',
            id: 1,
            module_name: 'runtime-package',
            severity: 'high'
          },
          '2': {
            github_advisory_id: 'GHSA-existing',
            id: 2,
            module_name: 'runtime-package',
            severity: 'high'
          },
          '3': {
            github_advisory_id: 'GHSA-low',
            id: 3,
            module_name: 'ignored-package',
            severity: 'moderate'
          }
        }
      })
    ).toEqual([{ id: 'GHSA-existing', module: 'runtime-package', severity: 'high' }])
  })

  it.each([
    [{ error: { message: 'registry unavailable' } }, 'error-shaped response'],
    [{ metadata: { vulnerabilities: {} } }, 'missing the advisories object'],
    [{ advisories: {} }, 'missing vulnerability metadata'],
    [
      {
        advisories: {},
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 }
        }
      },
      'supplies no high advisories'
    ]
  ])('fails closed on incomplete pnpm audit output', (report, message) => {
    expect(() => validateAuditReport(report)).toThrow(message)
  })

  it('rejects invalid or effectively permanent baseline dates', () => {
    expect(() => validateAuditBaseline({ ...baseline, generatedAt: '2026-02-30' })).toThrow(
      'not a valid calendar date'
    )
    expect(() => validateAuditBaseline({ ...baseline, reviewBy: '9999-12-31' })).toThrow(
      '45 days later'
    )
    expect(() =>
      validateAuditBaseline({ ...baseline, generatedAt: '9999-01-01', reviewBy: '9999-01-30' })
    ).toThrow('cannot be in the future')
  })

  it('rejects duplicate and unreviewed advisory identities', () => {
    expect(() =>
      validateAuditBaseline({
        ...baseline,
        advisories: [...baseline.advisories, ...baseline.advisories]
      })
    ).toThrow('Duplicate baseline advisory identity')

    expect(() =>
      validateAuditBaseline({
        ...baseline,
        advisories: [{ ...baseline.advisories[0], module: 'unreviewed-package' }]
      })
    ).toThrow('must be covered by exactly one review group')
  })

  it('fails new identities while preserving reviewed debt visibility', () => {
    const current: AuditFinding[] = [
      { id: 'GHSA-existing', module: 'runtime-package', severity: 'high' },
      { id: 'GHSA-new', module: 'new-package', severity: 'critical' }
    ]
    const result = compareWithBaseline(current, baseline, new Date('2026-09-27T00:00:00Z'))

    expect(result.newFindings).toEqual([
      { id: 'GHSA-new', module: 'new-package', severity: 'critical' }
    ])
    expect(result.expired).toBe(false)
  })

  it('detects severity escalation and an expired baseline', () => {
    const result = compareWithBaseline(
      [{ id: 'GHSA-existing', module: 'runtime-package', severity: 'critical' }],
      baseline,
      new Date('2026-11-01T00:00:00Z')
    )

    expect(result.escalated).toHaveLength(1)
    expect(result.expired).toBe(true)
  })

  it('reports without gating before a reviewed baseline is recorded', () => {
    const current: AuditFinding[] = [
      { id: 'GHSA-unreviewed', module: 'runtime-package', severity: 'critical' }
    ]
    const result = compareWithBaseline(current, null)

    expect(result.baselineMissing).toBe(true)
    expect(result.current).toEqual(current)
    expect(result.newFindings).toEqual([])
  })
})
