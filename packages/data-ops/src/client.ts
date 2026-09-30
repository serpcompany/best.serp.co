import {
  type ActiveCheckedInSiteId,
  assertSiteIdIsSupported
} from '@serpdirectory/site-contract/active-site-ids'
import type { SQL } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export interface SiteDatabase {
  binding: D1Database
  database: DrizzleD1Database<typeof schema>
  siteId: ActiveCheckedInSiteId
}

export interface CompiledSiteQuery {
  toSQL(): { params: unknown[]; sql: string }
}

/**
 * Execute a typed, parameterized statement through the shared Drizzle client while
 * retaining D1's per-statement metadata. Drizzle's mapped `all()` API intentionally
 * returns rows only, so Catalog queries that must report rows read/written use the
 * driver's raw response through `run()`.
 */
export async function runSiteQuery<T>(
  client: SiteDatabase,
  query: CompiledSiteQuery | SQL<T>
): Promise<D1Result<T>> {
  if ('toSQL' in query) {
    const compiled = query.toSQL()
    return client.binding
      .prepare(compiled.sql)
      .bind(...compiled.params)
      .all<T>()
  }
  return (await client.database.run(query)) as D1Result<T>
}

export function createSiteDatabase(
  binding: D1Database,
  siteId: ActiveCheckedInSiteId
): SiteDatabase {
  assertSiteIdIsSupported(siteId)
  return {
    binding,
    database: drizzle(binding, { schema }),
    siteId
  }
}
