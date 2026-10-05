import { describe, expect, it } from 'vitest'
import { execute, planDatabase } from './plan-test-support'
import {
  d1StatementLimitViolations,
  maxFunctionArguments,
  stripSqlLiteralsAndComments
} from './sql-limits'
import { findSelfComparison, SqliteD1 } from './test-support'

describe('the shared SQLite test binding', () => {
  it('finds a column compared with itself, quoted, bare, or qualified', () => {
    for (const sql of [
      'select EXISTS (SELECT 1 FROM "admin_allowlist" WHERE "email" = "email") as "allowlisted"',
      'SELECT 1 FROM t WHERE "t"."email" = "t"."email"',
      'SELECT 1 FROM t WHERE t.email IS t.email',
      'SELECT 1 FROM t WHERE email IS NOT email',
      'SELECT 1 FROM t WHERE email<>email',
      'SELECT 1 FROM t WHERE "Email" == "email"',
      // A trailing COLLATE does not make it a different comparison (#80 review).
      'SELECT 1 FROM t WHERE "email" = "email" COLLATE NOCASE',
      // A quote inside a comment no longer starts a fake string that hides code (#80 review).
      "SELECT 1 -- don't\nFROM t WHERE email = email AND name = 'x'",
      "SELECT 1 /* it's */ FROM t WHERE email = email AND name = 'x'"
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
      "SELECT 'a -- b' AS note FROM t WHERE email = ?",
      'SELECT 1 /* email = email */',
      'SELECT 1 -- email = email',
      'INSERT INTO t (x) VALUES (?) ON CONFLICT(x) DO UPDATE SET x=excluded.x'
    ]) {
      expect(findSelfComparison(sql), sql).toBeNull()
    }
  })

  it('strips strings and comments in one left-to-right pass', () => {
    expect(stripSqlLiteralsAndComments("SELECT 'it''s' -- don't\nFROM \"t's\" /* '' */")).toBe(
      "SELECT ''  \nFROM \"t's\"  "
    )
  })

  it('counts function arguments, not column lists, IN lists, or VALUES rows', () => {
    const many = Array.from({ length: 33 }, (_, index) => `'k${index}', ${index}`).join(', ')
    expect(maxFunctionArguments(`SELECT json_object(${many})`)).toEqual({
      count: 66,
      name: 'json_object'
    })
    expect(maxFunctionArguments('SELECT coalesce(a, b, max(c, d, e)) FROM t')).toEqual({
      count: 3,
      name: 'coalesce'
    })
    const columns = Array.from({ length: 40 }, (_, index) => `c${index}`).join(', ')
    for (const sql of [
      `INSERT INTO t (${columns}) VALUES (${columns})`,
      `SELECT 1 FROM t WHERE x IN (${columns})`,
      `CREATE TABLE t (${columns})`,
      `CREATE INDEX i ON t (${columns})`
    ]) {
      expect(maxFunctionArguments(sql)?.count ?? 0, sql).toBeLessThanOrEqual(1)
    }
  })

  it('reports every D1 statement limit a statement would exceed', () => {
    expect(d1StatementLimitViolations('SELECT ?', Array(100).fill(1))).toEqual([])
    expect(d1StatementLimitViolations('SELECT ?', Array(101).fill(1))).toEqual([
      '101 bound parameters'
    ])
    expect(d1StatementLimitViolations('SELECT ?101')).toEqual(['101 bound parameters'])
    expect(
      d1StatementLimitViolations(`SELECT max(${Array.from({ length: 33 }, () => '1').join(',')})`)
    ).toEqual(['max() has 33 arguments'])
    expect(d1StatementLimitViolations(`SELECT 1 /*${' '.repeat(100_000)}*/`)[0]).toMatch(
      /^statement is \d+ bytes$/u
    )
    expect(
      d1StatementLimitViolations(
        Array.from({ length: 6 }, (_, index) => `SELECT ${index}`).join(' UNION ALL ')
      )
    ).toEqual(['6 compound SELECT terms'])
    expect(d1StatementLimitViolations(`SELECT 'x' GLOB '${'?'.repeat(51)}'`)).toEqual([
      'LIKE/GLOB pattern of 51 bytes'
    ])
  })

  it('refuses such a statement in every test that uses it (#78)', () => {
    const binding = new SqliteD1().asD1Database()
    expect(() =>
      binding.prepare('SELECT 1 FROM "admin_allowlist" WHERE "email" = "email"')
    ).toThrow(/column compared with itself \("email" = "email"\)/u)
    expect(() =>
      execute(planDatabase(), [{ params: [], sql: 'DELETE FROM listings WHERE "id" = "id"' }])
    ).toThrow(/compares a column with itself/u)
    expect(() => binding.prepare('SELECT 1 FROM "admin_allowlist" WHERE "email" = ?')).not.toThrow()
    expect(() =>
      binding
        .prepare(`SELECT ${Array.from({ length: 101 }, () => '?').join(',')}`)
        .bind(...Array(101).fill(1))
    ).toThrow(/101 bound parameters/u)
  })
})
