/**
 * Account data operations for Better Auth (serpcompany/best.serp.co#60): the Drizzle adapter
 * over the `users`, `sessions`, `accounts`, and `verification` tables, the admin allowlist,
 * and the D1-backed sign-in code limits. Every statement is built here and binds its values;
 * the application layer (`apps/web/lib/auth/`) only composes these operations.
 */
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { type Database, runQuery } from './client'
import {
  accounts,
  adminAllowlist,
  authRateLimitHits,
  sessions,
  type userRoles,
  users,
  verification
} from './schema'

/** Better Auth model names, mapped onto the plural table names of the schema. */
export const authModelNames = {
  account: 'accounts',
  session: 'sessions',
  user: 'users',
  verification: 'verification'
} as const

/** The tables the adapter reads and writes, keyed by model name. */
export const authSchema = { accounts, sessions, users, verification }

/**
 * The schema-shaping part of the Better Auth options: model names and the `role` column, which
 * users can never set themselves (`input: false`). `apps/web/lib/auth/config.ts` spreads it into
 * the full options; `auth.test.ts` checks the tables against what Better Auth expects from it.
 */
export const authSchemaOptions = {
  account: { modelName: authModelNames.account },
  session: { modelName: authModelNames.session },
  user: {
    additionalFields: {
      role: { defaultValue: 'user', input: false, required: false, type: 'string' }
    },
    modelName: authModelNames.user
  },
  verification: { modelName: authModelNames.verification }
} as const

export type UserRole = (typeof userRoles)[number]

/** Rate-limit log rows older than this are pruned; no rule window may exceed it. */
export const AUTH_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000
const PRUNE_BATCH_SIZE = 200

export interface AuthRateLimitRule {
  /** Normalized key the rule counts, for example an email address or an IP address. */
  key: string
  /** Allowed requests per window. */
  max: number
  /** What the key is (`otp-email`, `otp-ip`, ...); buckets never collide across scopes. */
  scope: string
  windowMs: number
}

export interface AuthRateLimitDecision {
  allowed: boolean
  /** Seconds until the most restrictive violated rule allows a request again (0 if allowed). */
  retryAfterSeconds: number
}

export interface AdminStatus {
  /** The user's email is on the D1 admin allowlist right now. */
  allowlisted: boolean
  email: string
  emailVerified: boolean
  role: UserRole
}

export interface AuthOperations {
  /**
   * Records one request against every rule's bucket if, and only if, all rules still allow
   * it. The check and the insert are one statement, so concurrent requests cannot both pass
   * a limit; denied requests are not counted.
   */
  consumeRateLimit(rules: readonly AuthRateLimitRule[]): Promise<AuthRateLimitDecision>
  /** The user's role, verification state, and live allowlist membership; null if unknown. */
  getAdminStatus(userId: string): Promise<AdminStatus | null>
  /** The id of the verified account with this email, or null when there is none. */
  findVerifiedAccount(email: string): Promise<{ id: string } | null>
  isAllowlistedEmail(email: string): Promise<boolean>
  /** Sets the user's role from the allowlist (admin if listed, otherwise user). */
  syncUserRole(userId: string): Promise<UserRole | null>
}

export interface AuthOperationsOptions {
  client: Database
  clock?: () => Date
  /**
   * HMAC key for rate-limit buckets (the app passes a key derived from `BETTER_AUTH_SECRET`). Buckets are
   * HMAC-SHA256 digests, so a database reader cannot recover emails or IP addresses by
   * enumerating them; rotating the key starts every limit afresh.
   */
  rateLimitKey: string
}

const dialect = new SQLiteAsyncDialect()

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** The Better Auth database adapter over the injected D1 client. */
export function createAuthDatabaseAdapter(client: Database) {
  return drizzleAdapter(client.database, { provider: 'sqlite', schema: authSchema })
}

const encoder = new TextEncoder()

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('Auth rate limits need an HMAC key of 32+ characters.')
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  )
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function prepareSql(client: Database, query: SQL): D1PreparedStatement {
  const compiled = dialect.sqlToQuery(query)
  return client.binding.prepare(compiled.sql).bind(...compiled.params)
}

function validRule(rule: AuthRateLimitRule): void {
  if (!rule.scope || !rule.key) throw new Error('Auth rate limit rules need a scope and a key.')
  if (!Number.isInteger(rule.max) || rule.max < 1) {
    throw new Error(`Auth rate limit ${rule.scope} needs a positive integer max.`)
  }
  if (
    !Number.isInteger(rule.windowMs) ||
    rule.windowMs < 1 ||
    rule.windowMs > AUTH_RATE_LIMIT_RETENTION_MS
  ) {
    throw new Error(`Auth rate limit ${rule.scope} has an invalid window.`)
  }
}

export function createAuthOperations({
  client,
  clock = () => new Date(),
  rateLimitKey
}: AuthOperationsOptions): AuthOperations {
  const bucketKey = hmacKey(rateLimitKey)
  bucketKey.catch(() => undefined)
  const hits = authRateLimitHits
  const bucketColumn = sql.identifier('bucket')
  const hitAtColumn = sql.identifier('hit_at')

  return {
    async consumeRateLimit(rules) {
      if (rules.length === 0) return { allowed: true, retryAfterSeconds: 0 }
      for (const rule of rules) validRule(rule)
      const now = clock().getTime()
      if (!Number.isFinite(now)) throw new Error('Auth rate limit clock is invalid.')
      const key = await bucketKey
      const buckets = await Promise.all(
        rules.map(rule => hmacHex(key, `${rule.scope}\0${rule.key}`))
      )
      const distinctBuckets = [...new Set(buckets)]
      const candidates = sql.join(
        distinctBuckets.map(bucket => sql`SELECT ${bucket} AS bucket`),
        sql` UNION `
      )
      const underEveryLimit = sql.join(
        rules.map(
          (rule, index) =>
            sql`(SELECT count(*) FROM ${hits} WHERE ${hits.bucket} = ${buckets[index]} AND ${hits.hitAt} > ${now - rule.windowMs}) < ${rule.max}`
        ),
        sql` AND `
      )
      const statements = [
        prepareSql(
          client,
          sql`DELETE FROM ${hits} WHERE ${hits.id} IN (SELECT ${hits.id} FROM ${hits} WHERE ${hits.hitAt} <= ${now - AUTH_RATE_LIMIT_RETENTION_MS} LIMIT ${PRUNE_BATCH_SIZE})`
        ),
        prepareSql(
          client,
          sql`INSERT INTO ${hits} (${bucketColumn}, ${hitAtColumn}) SELECT candidate.bucket, ${now} FROM (${candidates}) AS candidate WHERE ${underEveryLimit}`
        )
      ]
      let results: D1Result<unknown>[]
      try {
        results = await client.binding.batch(statements)
      } catch {
        throw new Error('D1 auth rate limit failed.')
      }
      const changes = Number(results[1]?.meta?.changes)
      if (!Number.isFinite(changes)) throw new Error('D1 auth rate limit failed.')
      if (changes > 0) return { allowed: true, retryAfterSeconds: 0 }

      // Denied: the request is allowed again once the max-th most recent hit of every
      // violated rule has left that rule's window.
      const blocking = await Promise.all(
        rules.map(async (rule, index) => {
          const result = await runQuery<{ hit_at: number }>(
            client,
            client.database
              .select({ hit_at: hits.hitAt })
              .from(hits)
              .where(
                sql`${hits.bucket} = ${buckets[index]} AND ${hits.hitAt} > ${now - rule.windowMs}`
              )
              .orderBy(sql`${hits.hitAt} DESC`)
              .limit(1)
              .offset(rule.max - 1)
          )
          const hitAt = result.results[0]?.hit_at
          return typeof hitAt === 'number' ? hitAt + rule.windowMs - now : 0
        })
      )
      const retryAfterMs = Math.max(1000, ...blocking)
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) }
    },

    async getAdminStatus(userId) {
      const result = await runQuery<{
        allowlisted: number
        email: string
        email_verified: number
        role: UserRole
      }>(
        client,
        client.database
          .select({
            allowlisted:
              sql<number>`EXISTS (SELECT 1 FROM ${adminAllowlist} WHERE ${adminAllowlist.email} = ${users.email})`.as(
                'allowlisted'
              ),
            email: users.email,
            email_verified: users.emailVerified,
            role: users.role
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
      )
      const row = result.results[0]
      if (!row) return null
      return {
        allowlisted: Number(row.allowlisted) === 1,
        email: row.email,
        emailVerified: Number(row.email_verified) === 1,
        role: row.role
      }
    },

    async findVerifiedAccount(email) {
      const result = await runQuery<{ id: string }>(
        client,
        client.database
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, normalizeEmail(email)), eq(users.emailVerified, true)))
          .limit(1)
      )
      const id = result.results[0]?.id
      return id ? { id } : null
    },

    async isAllowlistedEmail(email) {
      const result = await runQuery<{ email: string }>(
        client,
        client.database
          .select({ email: adminAllowlist.email })
          .from(adminAllowlist)
          .where(eq(adminAllowlist.email, normalizeEmail(email)))
          .limit(1)
      )
      return result.results.length === 1
    },

    async syncUserRole(userId) {
      const result = await runQuery<{ role: UserRole }>(
        client,
        client.database
          .update(users)
          .set({
            role: sql`CASE WHEN EXISTS (SELECT 1 FROM ${adminAllowlist} WHERE ${adminAllowlist.email} = ${users.email}) THEN 'admin' ELSE 'user' END`
          })
          .where(eq(users.id, userId))
          .returning({ role: users.role })
      )
      return result.results[0]?.role ?? null
    }
  }
}
