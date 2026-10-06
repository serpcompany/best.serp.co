import { describe, expect, it, vi } from 'vitest'
import { readJsonBody } from './http'

vi.mock('server-only', () => ({}))

function chunked(chunks: string[]): Request {
  const encoder = new TextEncoder()
  let index = 0
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(encoder.encode(chunk))
    }
  })
  const request = new Request('https://best.serp.co/api/submissions/prefill', {
    body,
    // @ts-expect-error Node's fetch needs `duplex` for a streamed body.
    duplex: 'half',
    method: 'POST'
  })
  Object.defineProperty(request, 'pulledChunks', { get: () => pulled })
  return request
}

// PR #84 review round 1, finding 4.
describe('JSON request bodies', () => {
  it('cuts a body with no Content-Length at the cap instead of buffering it', async () => {
    const request = chunked(Array.from({ length: 100 }, () => 'x'.repeat(1_000)))
    expect(request.headers.get('content-length')).toBeNull()
    const body = await readJsonBody(request, 4_000)
    expect(body.response?.status).toBe(413)
    expect(await body.response?.json()).toMatchObject({ code: 'payload_too_large' })
    expect((request as unknown as { pulledChunks: number }).pulledChunks).toBeLessThan(10)
  })

  it('refuses a declared length over the cap before reading', async () => {
    const request = new Request('https://best.serp.co/api/submissions', {
      body: '{}',
      headers: { 'content-length': '40000' },
      method: 'POST'
    })
    const body = await readJsonBody(request)
    expect(body.response?.status).toBe(413)
  })

  it('parses a JSON body under the cap, and reads invalid JSON as null', async () => {
    await expect(
      readJsonBody(chunked(['{"url":', '"https://a.example/"}']), 4_000)
    ).resolves.toEqual({ response: null, value: { url: 'https://a.example/' } })
    await expect(readJsonBody(chunked(['{not json']), 4_000)).resolves.toEqual({
      response: null,
      value: null
    })
  })
})
