import { describe, expect, it } from 'vitest'
import { execute, planDatabase } from './plan-test-support'
import { findSelfComparison, SqliteD1 } from './test-support'

describe('the shared SQLite test binding', () => {
  it('finds a column compared with itself, quoted, bare, or qualified', () => {
    for (const sql of [
      'select EXISTS (SELECT 1 FROM "admin_allowlist" WHERE "email" = "email") as "allowlisted"',
      'SELECT 1 FROM t WHERE "t"."email" = "t"."email"',
      'SELECT 1 FROM t WHERE t.email IS t.email',
      'SELECT 1 FROM t WHERE email IS NOT email',
      'SELECT 1 FROM t WHERE email<>email',
      'SELECT 1 FROM t WHERE "Email" == "email"'
    ]) {
      expect(findSelfComparison(sql), sql).not.toBeNull()
    }
  })

  it('ignores increments, distinct columns, bound values, literals, and comments', () => {
    for (const sql of [
      'UPDATE t SET "attempts" = "attempts" + 1',
      'UPDATE t SET request_count=request_count+1',
      'SELECT 1 FROM t WHERE "email" = ?',
      'SELECT 1 FROM t WHERE "admin_allowlist"."email" = "users"."email"',
      'SELECT 1 FROM t WHERE email = email_verified',
      'SELECT 1 FROM t WHERE x + email = email',
      "SELECT 'email = email' AS note",
      'SELECT 1 /* email = email */',
      'SELECT 1 -- email = email',
      'INSERT INTO t (x) VALUES (?) ON CONFLICT(x) DO UPDATE SET x=excluded.x'
    ]) {
      expect(findSelfComparison(sql), sql).toBeNull()
    }
  })

  it('refuses such a statement in every test that uses it (#78)', () => {
    const binding = new SqliteD1().asD1Database()
    expect(() =>
      binding.prepare('SELECT 1 FROM "admin_allowlist" WHERE "email" = "email"')
    ).toThrow(/compares a column with itself \("email" = "email"\)/u)
    expect(() =>
      execute(planDatabase(), [{ params: [], sql: 'DELETE FROM listings WHERE "id" = "id"' }])
    ).toThrow(/compares a column with itself/u)
    expect(() => binding.prepare('SELECT 1 FROM "admin_allowlist" WHERE "email" = ?')).not.toThrow()
  })
})
