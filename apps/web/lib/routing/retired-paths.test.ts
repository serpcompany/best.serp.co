import { describe, expect, it } from 'vitest'
import { retiredPathResponse } from './retired-paths'

describe('retired paths (#166)', () => {
  it.each([
    'https://best.serp.co/news',
    'https://best.serp.co/news/',
    'https://best.serp.co/news/?x=1'
  ])('answers %s with 410 and no redirect', url => {
    const response = retiredPathResponse(new Request(url))
    expect(response?.status).toBe(410)
    expect(response?.headers.get('location')).toBeNull()
  })

  it.each([
    'https://best.serp.co/',
    'https://best.serp.co/newsletter/',
    'https://best.serp.co/news/today/'
  ])('leaves %s alone', url => {
    expect(retiredPathResponse(new Request(url))).toBeNull()
  })

  it('leaves non-GET requests alone', () => {
    expect(
      retiredPathResponse(new Request('https://best.serp.co/news', { method: 'POST' }))
    ).toBeNull()
  })
})
