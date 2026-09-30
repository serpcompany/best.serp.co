import { describe, expect, it } from 'vitest'
import { createDatabase } from './client'

const injectedBinding = {} as D1Database

describe('shared Drizzle client', () => {
  it('wraps the injected binding in a typed Drizzle client without Site identity', () => {
    const client = createDatabase(injectedBinding)
    expect(client.binding).toBe(injectedBinding)
    expect(client.database).toBeDefined()
    expect(client).not.toHaveProperty('siteId')
  })
})
