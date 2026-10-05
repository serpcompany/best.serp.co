import { createHash, createHmac } from 'node:crypto'
import { getSchema } from 'better-auth/db'
import { emailOTP } from 'better-auth/plugins/email-otp'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import {
  AUTH_RATE_LIMIT_RETENTION_MS,
  type AuthRateLimitRule,
  authModelNames,
  authSchema,
  authSchemaOptions,
  createAuthOperations,
  normalizeEmail
} from './auth'
import { createDatabase } from './client'
import { SqliteD1 } from './test-support'

function setup(start = Date.parse('2026-10-06T12:00:00.000Z')) {
  const sqlite = new SqliteD1()
  let now = start
  const operations = createAuthOperations({
    client: createDatabase(sqlite.asD1Database()),
    clock: () => new Date(now),
    rateLimitKey: RATE_LIMIT_KEY
  })
  return {
    advance(ms: number) {
      now += ms
    },
    hitCount: () =>
      Number(
        (
          sqlite.database.prepare('SELECT count(*) AS n FROM auth_rate_limit_hits').get() as {
            n: number
          }
        ).n
      ),
    insertUser(id: string, email: string, emailVerified = true) {
      sqlite.database
        .prepare('INSERT INTO users (id, name, email, email_verified) VALUES (?, ?, ?, ?)')
        .run(id, '', email, emailVerified ? 1 : 0)
    },
    operations,
    sqlite
  }
}

const MINUTE = 60_000
const RATE_LIMIT_KEY = 'rate-limit-test-key-'.repeat(3)
const HOUR = 60 * MINUTE

function otpRules(email: string, ip: string): AuthRateLimitRule[] {
  return [
    { key: email, max: 1, scope: 'otp-email', windowMs: MINUTE },
    { key: email, max: 5, scope: 'otp-email', windowMs: HOUR },
    { key: ip, max: 3, scope: 'otp-ip', windowMs: HOUR }
  ]
}

describe('auth data operations', () => {
  it('maps Better Auth models onto the schema tables', () => {
    expect(Object.keys(authSchema).sort()).toEqual(Object.values(authModelNames).sort())
    expect(normalizeEmail('  Devin@SERP.co ')).toBe('devin@serp.co')
  })

  // Catches schema drift on a Better Auth upgrade: every field Better Auth reads or writes
  // for this configuration exists with a compatible column type and nullability.
  it('has every column Better Auth expects for the configured models and plugins', () => {
    const schema = getSchema({
      ...authSchemaOptions,
      plugins: [emailOTP({ sendVerificationOTP: async () => {} })]
    }) as Record<
      string,
      {
        fields: Record<
          string,
          { required?: boolean; type: unknown; unique?: boolean; defaultValue?: unknown }
        >
      }
    >
    const columnTypes: Record<string, string[]> = {
      boolean: ['SQLiteBoolean'],
      date: ['SQLiteTimestamp'],
      number: ['SQLiteInteger', 'SQLiteReal'],
      string: ['SQLiteText']
    }
    expect(Object.keys(schema).sort()).toEqual(Object.values(authModelNames).sort())
    for (const [modelName, table] of Object.entries(schema)) {
      const drizzleTable: SQLiteTable = authSchema[modelName as keyof typeof authSchema]
      const columns = getTableColumns(drizzleTable)
      const config = getTableConfig(drizzleTable)
      const uniqueColumns = new Set(
        config.uniqueConstraints
          .filter(constraint => constraint.columns.length === 1)
          .map(constraint => constraint.columns[0]?.name)
      )
      expect(Object.keys(columns)).toContain('id')
      for (const [property, field] of Object.entries(table.fields)) {
        const column = columns[property as keyof typeof columns]
        expect(column, `${modelName}.${property}`).toBeDefined()
        expect(columnTypes[String(field.type)], `${modelName}.${property} type`).toContain(
          column?.columnType
        )
        if (field.required !== false && field.defaultValue === undefined) {
          expect(column?.notNull, `${modelName}.${property} not null`).toBe(true)
        }
        if (field.unique) {
          expect(
            Boolean(column?.isUnique || uniqueColumns.has(column?.name)),
            `${modelName}.${property} unique`
          ).toBe(true)
        }
      }
    }
  })

  it('enforces a per-email cooldown, an hourly cap, and a per-IP cap without counting denials', async () => {
    const { advance, hitCount, operations } = setup()
    expect(await operations.consumeRateLimit(otpRules('a@example.com', '1.1.1.1'))).toEqual({
      allowed: true,
      retryAfterSeconds: 0
    })
    // Same email inside the cooldown: denied until the first request is a minute old.
    advance(10_000)
    expect(await operations.consumeRateLimit(otpRules('a@example.com', '1.1.1.2'))).toEqual({
      allowed: false,
      retryAfterSeconds: 50
    })
    expect(hitCount()).toBe(2)

    // The IP allows three requests per hour across emails; the denial above was not counted.
    expect((await operations.consumeRateLimit(otpRules('b@example.com', '1.1.1.1'))).allowed).toBe(
      true
    )
    expect((await operations.consumeRateLimit(otpRules('c@example.com', '1.1.1.1'))).allowed).toBe(
      true
    )
    const ipDenied = await operations.consumeRateLimit(otpRules('d@example.com', '1.1.1.1'))
    expect(ipDenied.allowed).toBe(false)
    expect(ipDenied.retryAfterSeconds).toBe(3590)

    // Five per hour per email, one per minute.
    for (let request = 2; request <= 5; request += 1) {
      advance(MINUTE)
      const decision = await operations.consumeRateLimit(
        otpRules('a@example.com', `9.9.9.${request}`)
      )
      expect(decision.allowed, `request ${request}`).toBe(true)
    }
    advance(MINUTE)
    const hourly = await operations.consumeRateLimit(otpRules('a@example.com', '9.9.9.9'))
    expect(hourly.allowed).toBe(false)
    expect(hourly.retryAfterSeconds).toBeGreaterThan(50 * 60)
    advance(HOUR)
    expect((await operations.consumeRateLimit(otpRules('a@example.com', '9.9.9.9'))).allowed).toBe(
      true
    )
  })

  it('prunes log rows older than the retention window and validates rules', async () => {
    const { advance, hitCount, operations } = setup()
    await operations.consumeRateLimit(otpRules('a@example.com', '1.1.1.1'))
    expect(hitCount()).toBe(2)
    advance(AUTH_RATE_LIMIT_RETENTION_MS + 1)
    await operations.consumeRateLimit(otpRules('b@example.com', '2.2.2.2'))
    expect(hitCount()).toBe(2)

    await expect(
      operations.consumeRateLimit([{ key: 'k', max: 0, scope: 's', windowMs: 1000 }])
    ).rejects.toThrow(/positive integer max/u)
    await expect(
      operations.consumeRateLimit([
        { key: 'k', max: 1, scope: 's', windowMs: AUTH_RATE_LIMIT_RETENTION_MS + 1 }
      ])
    ).rejects.toThrow(/invalid window/u)
    expect(await operations.consumeRateLimit([])).toEqual({ allowed: true, retryAfterSeconds: 0 })
  })

  it('stores keyed digests of rate-limited emails and IP addresses, never the values', async () => {
    const { operations, sqlite } = setup()
    await operations.consumeRateLimit(otpRules('secret@example.com', '203.0.113.9'))
    const buckets = (
      sqlite.database.prepare('SELECT DISTINCT bucket FROM auth_rate_limit_hits').all() as Array<{
        bucket: string
      }>
    ).map(row => row.bucket)
    expect(buckets).toHaveLength(2)
    // An unkeyed SHA-256 of the same input (reversible by enumerating IPv4 addresses or known
    // emails) is not what is stored.
    const unkeyed = createHash('sha256').update('otp-ip\u0000203.0.113.9').digest('hex')
    const keyed = createHmac('sha256', RATE_LIMIT_KEY)
      .update('otp-ip\u0000203.0.113.9')
      .digest('hex')
    expect(buckets).not.toContain(unkeyed)
    expect(buckets).toContain(keyed)
    for (const bucket of buckets) expect(bucket).toMatch(/^[a-f0-9]{64}$/u)
    await expect(
      createAuthOperations({
        client: createDatabase(sqlite.asD1Database()),
        rateLimitKey: 'short'
      }).consumeRateLimit(otpRules('a@example.com', '1.1.1.1'))
    ).rejects.toThrow(/HMAC key/u)
  })

  it('reads the seeded allowlist and syncs roles from it', async () => {
    const { insertUser, operations, sqlite } = setup()
    expect(await operations.isAllowlistedEmail(' Devin@serp.co ')).toBe(true)
    expect(await operations.isAllowlistedEmail('someone@example.com')).toBe(false)

    insertUser('owner', 'devin@serp.co')
    insertUser('visitor', 'visitor@example.com')
    expect(await operations.syncUserRole('owner')).toBe('admin')
    expect(await operations.syncUserRole('visitor')).toBe('user')
    expect(await operations.syncUserRole('missing')).toBeNull()
    expect(await operations.getAdminStatus('owner')).toEqual({
      allowlisted: true,
      email: 'devin@serp.co',
      emailVerified: true,
      role: 'admin'
    })
    expect(await operations.getAdminStatus('missing')).toBeNull()
    expect(await operations.findVerifiedAccount(' Visitor@Example.com ')).toEqual({ id: 'visitor' })
    insertUser('pending', 'pending@example.com', false)
    expect(await operations.findVerifiedAccount('pending@example.com')).toBeNull()
    expect(await operations.findVerifiedAccount('nobody@example.com')).toBeNull()

    // Removal from the allowlist shows immediately, and the next sync demotes the role.
    sqlite.database.prepare("DELETE FROM admin_allowlist WHERE email = 'devin@serp.co'").run()
    expect((await operations.getAdminStatus('owner'))?.allowlisted).toBe(false)
    expect(await operations.syncUserRole('owner')).toBe('user')
  })
})
