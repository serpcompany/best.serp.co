import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'
import { describe, expect, it } from 'vitest'
import { createSiteDatabase } from './client'

const injectedBinding = {} as D1Database

describe('shared Drizzle client', () => {
  it('retains the explicit supported Site identity beside the injected binding client', () => {
    const client = createSiteDatabase(injectedBinding, 'serp.software')
    expect(client.siteId).toBe('serp.software')
    expect(client.binding).toBe(injectedBinding)
    expect(client.database).toBeDefined()
  })

  it('fails closed for an unsupported Site identity at runtime', () => {
    expect(() =>
      createSiteDatabase(injectedBinding, 'unsupported.example' as ActiveCheckedInSiteId)
    ).toThrow('is not active in this repo')
  })
})
