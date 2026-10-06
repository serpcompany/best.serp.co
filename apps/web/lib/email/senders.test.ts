import { describe, expect, it } from 'vitest'
import {
  createUseSendSender,
  EmailProviderError,
  emailErrorCode,
  type OutgoingEmail,
  redactedErrorMessage,
  scrubSecrets
} from './senders'

const message: OutgoingEmail = {
  from: { email: 'noreply@mail.serp.co', name: 'SERP Directory' },
  headers: { 'Auto-Submitted': 'auto-generated' },
  html: '<p>Hello</p>',
  idempotencyKey: 'test-fixture:fixture:1',
  subject: 'Hello',
  text: 'Hello',
  to: 'person@example.com'
}

const apiKey = 'us_secret_test_key'

function sender(respond: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request.clone())
    return respond(request)
  }
  return {
    requests,
    useSend: createUseSendSender({ apiKey, baseUrl: 'https://app.usesend.com/', fetch: fetcher })
  }
}

/** What the service would log for this failure. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; logged: string }> {
  try {
    await promise
  } catch (error) {
    return { code: emailErrorCode(error), logged: redactedErrorMessage(error) }
  }
  throw new Error('expected the send to fail')
}

describe('useSend sender', () => {
  it('posts one message to the send-email API with the key, idempotency key, and no Reply-To', async () => {
    const { requests, useSend } = sender(() => Response.json({ emailId: 'em_123' }))
    expect(useSend.provider).toBe('usesend')
    expect(await useSend.send(message)).toEqual({ messageId: 'em_123' })
    const request = requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('https://app.usesend.com/api/v1/emails')
    expect(request?.headers.get('authorization')).toBe(`Bearer ${apiKey}`)
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(request?.headers.get('idempotency-key')).toBe('test-fixture:fixture:1')
    expect(await request?.json()).toEqual({
      from: 'SERP Directory <noreply@mail.serp.co>',
      headers: { 'Auto-Submitted': 'auto-generated' },
      html: '<p>Hello</p>',
      subject: 'Hello',
      text: 'Hello',
      to: 'person@example.com'
    })
  })

  it('accepts a success without an email id', async () => {
    const { useSend } = sender(() => new Response('{}', { status: 200 }))
    expect(await useSend.send(message)).toEqual({ messageId: null })
  })

  it("maps useSend's error codes, with addresses redacted and never the key", async () => {
    const cases: Array<[Response, string]> = [
      [
        Response.json(
          { error: { code: 'BAD_REQUEST', message: 'Domain of person@example.com not verified' } },
          { status: 400 }
        ),
        'BAD_REQUEST'
      ],
      [
        Response.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } },
          { status: 401 }
        ),
        'UNAUTHORIZED'
      ],
      [
        Response.json({ error: { code: 'RATE_LIMITED', message: 'Too many' } }, { status: 429 }),
        'RATE_LIMITED'
      ],
      [
        Response.json(
          { error: { code: 'NOT_UNIQUE', message: 'Idempotency-Key reused' } },
          { status: 409 }
        ),
        'NOT_UNIQUE'
      ],
      [new Response('<html>bad gateway</html>', { status: 502 }), 'HTTP_502'],
      [Response.json({ error: { code: 'weird code!' } }, { status: 500 }), 'HTTP_500']
    ]
    for (const [response, code] of cases) {
      const { useSend } = sender(() => response)
      const result = await failure(useSend.send(message))
      expect(result.code, code).toBe(code)
      expect(result.logged).toMatch(/^useSend answered \d{3}/u)
      expect(result.logged).not.toMatch(/@|person|us_secret/u)
    }
  })

  it('scrubs the API key and any bearer or us_ token from error messages', async () => {
    const leaky = [
      `Invalid API token ${apiKey}`,
      'Rejected header Authorization: Bearer us_live_abcdef123456',
      'Token us_live_abcdef123456 revoked',
      `proxy said: bearer ${apiKey.toUpperCase()}`
    ]
    for (const detail of leaky) {
      const { useSend } = sender(() =>
        Response.json({ error: { code: 'UNAUTHORIZED', message: detail } }, { status: 401 })
      )
      const result = await failure(useSend.send(message))
      expect(result.code).toBe('UNAUTHORIZED')
      expect(result.logged, detail).toContain('[redacted]')
      expect(result.logged, detail).not.toMatch(/us_|secret|abcdef/iu)
    }
    expect(scrubSecrets('key k-123 here', 'k-123')).toBe('key [redacted] here')
    expect(redactedErrorMessage(new Error('Bearer xyz.abc for a@b.co'))).toBe(
      '[redacted] for [redacted]'
    )
  })

  it('reports network failures and timeouts without detail', async () => {
    const offline = sender(() => {
      throw new TypeError('fetch failed for person@example.com')
    })
    expect(await failure(offline.useSend.send(message))).toEqual({
      code: 'NETWORK_ERROR',
      logged: 'useSend could not be reached.'
    })

    const hanging = createUseSendSender({
      apiKey,
      baseUrl: 'https://app.usesend.com',
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      timeoutMs: 5
    })
    expect(await failure(hanging.send(message))).toEqual({
      code: 'TIMEOUT',
      logged: 'useSend did not answer within 5 ms.'
    })
  })

  it('exposes a stable code on its errors', () => {
    const error = new EmailProviderError('RATE_LIMITED', 'x')
    expect(error).toBeInstanceOf(Error)
    expect(emailErrorCode(error)).toBe('RATE_LIMITED')
    expect(emailErrorCode(new Error('plain'))).toBe('E_UNKNOWN')
  })
})
