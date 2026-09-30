import { describe, expect, it } from 'vitest'
import {
  adoptRecoveryRateFingerprint,
  assertRecoveredApplicationSnapshots,
  buildRecoveryPlans,
  type RecoveryJournal
} from './d1-preview-submission-recovery'

const base: RecoveryJournal = {
  originalPublicationRunIds: ['existing-run'],
  originalPublicationState: {
    site_id: 'serp.software',
    version: 1,
    manifest_id: 'initial',
    checksum: 'a'.repeat(64),
    published_at: '2026-01-01T00:00:00.000Z'
  },
  ownedRateFingerprint: null,
  rateFingerprintsBefore: [],
  runId: 'run-1',
  siteId: 'serp.software',
  sourcePrivateBefore: {},
  sourceSnapshotChecksum: 'snapshot-a',
  submissions: [],
  targetPrivateBefore: {},
  targetSnapshotChecksum: 'snapshot-a',
  version: 1
}

describe('Preview Submission recovery journal', () => {
  it.each([
    ['before intake', [], []],
    ['interrupted after intake', [], ['intake-id']],
    [
      'interrupted after notification',
      [
        {
          id: 'notified-id',
          listingId: 'submission_notified-id',
          publicationRunId: 'submission_publish_notified-id'
        }
      ],
      []
    ],
    [
      'interrupted after approval',
      [
        {
          id: 'approved-id',
          listingId: 'submission_approved-id',
          publicationRunId: 'submission_publish_approved-id'
        }
      ],
      []
    ],
    [
      'interrupted after rejection/rate',
      [
        {
          id: 'approved-id',
          listingId: 'submission_approved-id',
          publicationRunId: 'submission_publish_approved-id'
        },
        {
          id: 'rejected-id',
          listingId: 'submission_rejected-id',
          publicationRunId: 'submission_publish_rejected-id'
        }
      ],
      []
    ]
  ])('builds idempotent exact recovery for %s', (_label, submissions, discovered) => {
    const journal = {
      ...base,
      submissions,
      ownedRateFingerprint: _label === 'before intake' ? null : 'owned-fingerprint'
    }
    const plans = buildRecoveryPlans(journal, discovered)
    const sql = plans.map(item => item.sql).join('\n')
    const params = plans.flatMap(item => item.params)
    expect(sql).toContain('UPDATE publication_state SET version=?')
    if (journal.ownedRateFingerprint) {
      expect(sql).toContain('DELETE FROM listing_submission_rate_limits WHERE fingerprint_hash=?')
      expect(params).toContain('owned-fingerprint')
    }
    for (const id of [...submissions.map(item => item.id), ...discovered])
      expect(params).toContain(id)
    expect(params).not.toContain('unrelated-fingerprint')
  })

  it('never targets a concurrent unrelated fingerprint', () => {
    const plans = buildRecoveryPlans({ ...base, ownedRateFingerprint: 'owned-fingerprint' }, [])
    expect(plans.flatMap(item => item.params)).toContain('owned-fingerprint')
    expect(plans.flatMap(item => item.params)).not.toContain('unrelated-fingerprint')
  })

  it('adopts exactly one post-intake fingerprint when the journal baseline is empty', () => {
    const adopted = adoptRecoveryRateFingerprint(base, ['intake-id'], ['owned-fingerprint'])
    expect(adopted.ownedRateFingerprint).toBe('owned-fingerprint')
    expect(() => adoptRecoveryRateFingerprint(base, ['intake-id'], [])).toThrow('exactly one row')
    expect(() =>
      adoptRecoveryRateFingerprint(base, ['intake-id'], ['owned-fingerprint', 'unrelated'])
    ).toThrow('exactly one row')
    expect(() =>
      adoptRecoveryRateFingerprint(
        { ...base, rateFingerprintsBefore: ['preexisting'] },
        ['intake-id'],
        ['preexisting', 'owned']
      )
    ).toThrow('isolated empty state')
  })

  it.each(['intake', 'notification', 'approval', 'rejection', 'rate'])(
    'requires full application snapshot parity after interrupted %s recovery',
    () => {
      const snapshot = {
        checksum: 'snapshot-a',
        migrationNames: [],
        tables: { listings: { count: 1, checksum: 'row-a' } }
      }
      expect(() => assertRecoveredApplicationSnapshots(base, snapshot, snapshot)).not.toThrow()
      expect(() =>
        assertRecoveredApplicationSnapshots(base, snapshot, {
          ...snapshot,
          checksum: 'snapshot-b',
          tables: { ...snapshot.tables, listings: { count: 2, checksum: 'row-b' } }
        })
      ).toThrow('full application snapshot')
    }
  )
})
