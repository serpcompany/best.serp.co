import { describe, expect, it } from 'vitest'
import { describeMediaFailure, logoNote } from './logo-note'

describe('logo hosting note (#95)', () => {
  it('says nothing for a hosted logo, and why the tile shows otherwise', () => {
    expect(logoNote(null)).toBeNull()
    expect(
      logoNote({
        attempts: 0,
        lastError: null,
        nextAttemptAt: '2026-10-06T12:15:00.000Z',
        sourceUrl: 'https://example.com/logo.png',
        status: 'pending'
      })
    ).toMatchObject({
      text: expect.stringMatching(/^Waiting to be hosted; .*Next attempt/u),
      tone: 'warn'
    })
    expect(
      logoNote({
        attempts: 2,
        lastError: 'http_503',
        nextAttemptAt: null,
        sourceUrl: 'https://example.com/logo.png',
        status: 'pending'
      })?.text
    ).toContain('after 2 failed attempts: the server answered HTTP 503 (http_503)')
    expect(
      logoNote({
        attempts: 1,
        lastError: 'svg',
        nextAttemptAt: null,
        sourceUrl: 'https://example.com/logo.svg',
        status: 'failed'
      })
    ).toEqual({
      text: "Couldn't host this logo: it is an SVG, which can't be hosted (svg). The page shows the fallback tile. Save another image URL to try again.",
      tone: 'err'
    })
  })

  it('names a failure in words, with its code', () => {
    expect(describeMediaFailure('http_404')).toBe('the server answered HTTP 404 (http_404)')
    expect(describeMediaFailure('too_many_pixels')).toBe(
      'the image has more than 40 megapixels (too_many_pixels)'
    )
    expect(describeMediaFailure('something_new')).toBe('something_new')
    // Reviewed-copy failures stay in the data and logs; the screens add no wording for them.
    expect(describeMediaFailure('reviewed_copy_changed')).toBe('reviewed_copy_changed')
  })

  it('adds no note while a hosted logo stays on the page (#96 round 2 S2)', () => {
    const queue = {
      attempts: 1,
      lastError: 'http_503',
      nextAttemptAt: null,
      sourceUrl: 'https://example.com/new.png',
      status: 'pending' as const
    }
    expect(logoNote(queue, true)).toBeNull()
    expect(logoNote({ ...queue, status: 'failed' }, true)).toBeNull()
    expect(logoNote(queue, false)?.text).toMatch(/fallback tile/u)
  })
})
