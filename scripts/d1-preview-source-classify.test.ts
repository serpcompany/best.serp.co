import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertCanonicalLegacyMigrationSet,
  buildExpectedLegacySource,
  classifyLegacySource,
  type ExpectedLegacySource,
  type LegacySourceObservation
} from './d1-preview-source-classify'
import { canonicalLegacyMigrationNames } from './d1-replatform-inventory'

const migrationNames = [...canonicalLegacyMigrationNames]
const tables = {
  sites: { count: 1, checksum: 'site' },
  listing_submissions: { count: 0, checksum: 'empty' },
  listing_submission_notifications: { count: 0, checksum: 'empty' },
  listing_submission_rate_limits: { count: 0, checksum: 'empty' }
}
const expected: ExpectedLegacySource = {
  applicationSnapshotChecksum: 'application-exact',
  applicationTables: tables,
  migrationNames,
  schemaFingerprint: 'schema-exact',
  siteId: 'serp.software'
}
const exact: LegacySourceObservation = {
  applicationSnapshot: { checksum: 'application-exact', migrationNames, tables },
  hasMigrationLedger: true,
  migrationNames,
  schemaFingerprint: 'schema-exact',
  siteIds: ['serp.software'],
  unexpectedUserObjects: []
}

describe('legacy Preview source classification', () => {
  it('rejects extra, missing, or renamed legacy migration SQL', () => {
    const canonical = expected.migrationNames
    expect(() => assertCanonicalLegacyMigrationSet(canonical)).not.toThrow()
    expect(() => assertCanonicalLegacyMigrationSet([...canonical, '0010_forward.sql'])).toThrow(
      'canonical immutable 0001-0009'
    )
    expect(() => assertCanonicalLegacyMigrationSet(canonical.slice(0, -1))).toThrow()
    expect(() =>
      assertCanonicalLegacyMigrationSet([...canonical.slice(0, -1), '0009_renamed.sql'])
    ).toThrow()
  })
  it.each(['serp.software', 'pornvideodownloaders.com'] as const)(
    'reconstructs the reviewed %s legacy schema and full artifact snapshot',
    siteId => {
      const reconstructed = buildExpectedLegacySource(siteId)
      expect(reconstructed.migrationNames).toHaveLength(9)
      expect(reconstructed.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/u)
      expect(reconstructed.applicationSnapshotChecksum).toMatch(/^[0-9a-f]{64}$/u)
      expect(reconstructed.siteId).toBe(siteId)
    }
  )
  it('accepts only truly blank or exact controlled populated state', () => {
    expect(
      classifyLegacySource(
        {
          applicationSnapshot: {
            checksum: 'empty',
            migrationNames: [],
            tables: Object.fromEntries(
              Object.keys(tables).map(name => [name, { count: 0, checksum: 'empty' }])
            )
          },
          hasMigrationLedger: false,
          migrationNames: [],
          schemaFingerprint: createHash('sha256').update('[]').digest('hex'),
          siteIds: [],
          unexpectedUserObjects: []
        },
        expected
      )
    ).toBe('blank')
    expect(classifyLegacySource(exact, expected)).toBe('controlled-populated')
  })

  it.each([
    [
      'zero-row forged ledger',
      {
        ...exact,
        applicationSnapshot: {
          ...exact.applicationSnapshot,
          tables: Object.fromEntries(
            Object.keys(tables).map(name => [name, { count: 0, checksum: 'empty' }])
          )
        },
        siteIds: []
      }
    ],
    ['extra migration', { ...exact, migrationNames: [...migrationNames, '0010.sql'] }],
    ['wrong site', { ...exact, siteIds: ['other.example'] }],
    ['schema drift', { ...exact, schemaFingerprint: 'schema-drift' }],
    [
      'audit drift',
      { ...exact, applicationSnapshot: { ...exact.applicationSnapshot, checksum: 'audit-drift' } }
    ],
    ['extra user schema', { ...exact, unexpectedUserObjects: ['shadow_table'] }]
  ])('rejects %s before mutation', (_label, observed) => {
    expect(() => classifyLegacySource(observed as LegacySourceObservation, expected)).toThrow()
  })
})
