import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  activeCutoverLockIdPrefix,
  assertCutoverUnlockedPlan,
  CutoverFrozenError,
  hasActiveCutoverLock,
  selectActiveCutoverLockPlan
} from './cutover-lock'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE migration_runs (
    id TEXT PRIMARY KEY,site_id TEXT NOT NULL,outcome TEXT NOT NULL,started_at TEXT NOT NULL
  )`)
  return db
}

function execute(db: DatabaseSync, plan: { params: unknown[]; sql: string }) {
  return db.prepare(plan.sql).all(...(plan.params as SQLInputValue[])) as Array<
    Record<string, unknown>
  >
}

describe('durable D1 cutover lock', () => {
  it('uses an immutable, site-scoped reserved identity prefix', () => {
    expect(activeCutoverLockIdPrefix('serp.software')).toBe('d1-cutover-lock-v1:serp.software:')
    expect(activeCutoverLockIdPrefix('pornvideodownloaders.com')).toBe(
      'd1-cutover-lock-v1:pornvideodownloaders.com:'
    )
    expect(new CutoverFrozenError()).toMatchObject({ code: 'cutover_frozen', status: 503 })
  })

  it('detects only an active reserved lock for the selected Site', () => {
    const db = database()
    db.exec(`
      INSERT INTO migration_runs VALUES
        ('ordinary-import','serp.software','started','2026-01-01'),
        ('d1-cutover-lock-v1:serp.software:old','serp.software','succeeded','2026-01-02'),
        ('d1-cutover-lock-v1:pornvideodownloaders.com:active','pornvideodownloaders.com','started','2026-01-03')
    `)
    expect(hasActiveCutoverLock(execute(db, selectActiveCutoverLockPlan('serp.software')))).toBe(
      false
    )
    expect(
      hasActiveCutoverLock(execute(db, selectActiveCutoverLockPlan('pornvideodownloaders.com')))
    ).toBe(true)
  })

  it('fails inside the transaction when the lock is active', () => {
    const db = database()
    db.prepare('INSERT INTO migration_runs VALUES (?,?,?,?)').run(
      'd1-cutover-lock-v1:serp.software:run-1',
      'serp.software',
      'started',
      '2026-01-01'
    )
    expect(() => execute(db, assertCutoverUnlockedPlan('serp.software'))).toThrow(/malformed JSON/u)
    expect(() => execute(db, assertCutoverUnlockedPlan('pornvideodownloaders.com'))).not.toThrow()
  })
})
