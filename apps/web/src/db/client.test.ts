import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDatabase, createSessionDatabase, runBatch, runQuery, servedBy } from './client'
import { listings } from './schema'
import { SqliteD1 } from './test-support'

const injectedBinding = {} as D1Database

describe('shared Drizzle client', () => {
  it('wraps the injected binding in a typed Drizzle client without Site identity', () => {
    const client = createDatabase(injectedBinding)
    expect(client.binding).toBe(injectedBinding)
    expect(client.database).toBeDefined()
    expect(client).not.toHaveProperty('siteId')
  })

  // #382: a public render reads through a D1 session, so every way a statement is sent (a
  // compiled query, a batch, Drizzle's own query builder) must go through it.
  it('sends every statement of a session database through the session', async () => {
    const sqlite = new SqliteD1()
    const binding = sqlite.asD1Database()
    const calls: string[] = []
    const session = {
      batch: (statements: D1PreparedStatement[]) => {
        calls.push(`batch:${statements.length}`)
        return binding.batch(statements)
      },
      getBookmark: () => null,
      prepare: (text: string) => {
        calls.push('prepare')
        return binding.prepare(text)
      }
    } as unknown as D1DatabaseSession
    const client = createSessionDatabase(session)
    expect(client.binding).toBe(session)

    const compiled = { toSQL: () => ({ params: [1], sql: 'SELECT ?1 AS one' }) }
    expect((await runQuery(client, compiled)).results).toEqual([{ one: 1 }])
    expect((await runQuery(client, sql`SELECT ${2} AS two`)).results).toEqual([{ two: 2 }])
    expect(await runBatch(client, [compiled, compiled])).toHaveLength(2)
    expect(await client.database.select({ slug: listings.slug }).from(listings)).toEqual([])
    expect(calls).toEqual(['prepare', 'prepare', 'prepare', 'prepare', 'batch:2', 'prepare'])
    expect(sqlite.roundTrips.map(trip => trip.kind)).toEqual([
      'statement',
      'statement',
      'batch',
      'statement'
    ])
  })
})

describe('servedBy (#382)', () => {
  it('reports where remote D1 ran a statement, and nothing it does not say', () => {
    expect(servedBy({ served_by_primary: false, served_by_region: 'ENAM' })).toEqual({
      servedByPrimary: false,
      servedByRegion: 'ENAM'
    })
    expect(servedBy({ served_by_primary: true })).toEqual({ servedByPrimary: true })
    // Local D1 (Miniflare) reports neither; malformed values are dropped, never logged.
    expect(servedBy({ duration: 0, rows_read: 1 })).toEqual({})
    expect(servedBy({ served_by_primary: 'yes', served_by_region: 'not a region!' })).toEqual({})
    expect(servedBy(undefined)).toEqual({})
  })
})
