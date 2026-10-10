import { describe, expect, it } from 'vitest'
import { isLocalRequestHost } from './local-host'

describe('isLocalRequestHost (#164)', () => {
  it.each([
    'http://localhost:8978/api/dev/email-outbox',
    'http://127.0.0.1:3100/api/auth/dev/otp-outbox',
    'http://[::1]:3100/x',
    'http://best.localhost:3000/x'
  ])('accepts %s', url => {
    expect(isLocalRequestHost(url)).toBe(true)
  })

  it.each([
    'https://best.serp.co/api/dev/email-outbox',
    'https://best-serp-co-staging.serpcompany.workers.dev/api/auth/dev/otp-outbox',
    'https://staging.best.serp.co/api/auth/dev/otp-outbox',
    'http://127.0.0.1.nip.io/x',
    'http://localhost.example.com/x',
    'http://10.0.0.1/x',
    'not a url'
  ])('refuses %s', url => {
    expect(isLocalRequestHost(url)).toBe(false)
  })
})
