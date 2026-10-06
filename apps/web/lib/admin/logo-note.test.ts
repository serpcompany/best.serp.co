import { describe, expect, it } from 'vitest'
import { logoNote } from './logo-note'

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
    ).toContain('after 2 failed attempts (http_503)')
    expect(
      logoNote({
        attempts: 1,
        lastError: 'svg',
        nextAttemptAt: null,
        sourceUrl: 'https://example.com/logo.svg',
        status: 'failed'
      })
    ).toEqual({
      text: "Couldn't host this logo (svg), so the page shows the fallback tile. Save another image URL to try again.",
      tone: 'err'
    })
  })
})
