import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeFetchError, getR2Object } from './r2-objects'

/**
 * The R2 REST calls through Node's real fetch, not a fake: a fake accepts any header. In the
 * uploader's process, importing the pinned Node fetcher loads the npm undici package (7.29.1),
 * whose Agent becomes the dispatcher of Node's own fetch (Node 24 bundles undici 7.18.2). That
 * Agent refuses a hand-set Content-Length ("invalid content-length header"), so every PUT of Upload
 * Listing Media (staging) run 37471183304 threw `fetch failed` (#95 release blocker). GETs set no
 * Content-Length and the dry run never PUTs, so neither showed it.
 *
 * The PUT runs in a fresh Node process that loads `media-upload.ts` first, exactly as the workflow
 * does (inside Vitest, Node's fetch has already installed its own dispatcher). A local server
 * stands in for the API, so nothing leaves the machine.
 */
interface Received {
  body: Buffer
  headers: IncomingMessage['headers']
  method: string
  url: string
}
const received: Received[] = []
let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      received.push({
        body: Buffer.concat(chunks),
        headers: request.headers,
        method: request.method ?? '',
        url: request.url ?? ''
      })
      if (request.method === 'GET' && request.url?.endsWith('/missing.png')) {
        response.writeHead(404).end()
      } else if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([1, 2, 3]))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

const env = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' } as NodeJS.ProcessEnv
/** Node's own fetch, pointed at the local server instead of api.cloudflare.com. */
const local: typeof fetch = (input, init) =>
  fetch(String(input).replace('https://api.cloudflare.com', origin), init)

/** Runs `script` in a new Node process that has loaded the uploader, and returns its JSON line. */
async function inUploaderProcess(script: string): Promise<unknown> {
  const prelude = `require('./scripts/media-upload.ts')
const { describeFetchError, putR2Object } = require('./scripts/r2-objects.ts')
const local = (input, init) => fetch(String(input).replace('https://api.cloudflare.com', process.env.R2_TEST_ORIGIN), init)
const env = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }
const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')] !== undefined;
`
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '-e', `${prelude}(async () => { ${script} })()`],
    { env: { ...process.env, R2_TEST_ORIGIN: origin } }
  )
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null')
}

describe('R2 objects through Node fetch', () => {
  it('PUTs an object with its type and cache policy where the uploader runs; fetch sets Content-Length', async () => {
    const key = 'best.serp.co/listings/example.com/logo/0123456789abcdef.png'
    const result = await inUploaderProcess(`
      const body = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
      const outcome = await putR2Object({ bytes: 7, contentType: 'image/png', key: '${key}' }, body,
        'cdn-staging', 'public, max-age=31536000, immutable', env, local).catch(describeFetchError)
      console.log(JSON.stringify({ dispatcher, outcome }))`)
    // The npm undici Agent is the global dispatcher there, as in the workflow.
    expect(result).toEqual({ dispatcher: true, outcome: null })
    const put = received.find(request => request.method === 'PUT')
    expect(put?.url).toBe(`/client/v4/accounts/account/r2/buckets/cdn-staging/objects/${key}`)
    expect(put?.headers).toMatchObject({
      authorization: 'Bearer token',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': '7',
      'content-type': 'image/png'
    })
    expect([...(put?.body ?? [])]).toEqual([137, 80, 78, 71, 1, 2, 3])
  })

  it('names the cause of a fetch failure instead of a bare "fetch failed"', async () => {
    // The request run 37471183304 sent: a hand-set Content-Length.
    const result = await inUploaderProcess(`
      const error = await local('https://api.cloudflare.com/x', { body: new Uint8Array([1, 2, 3]),
        headers: { 'Content-Length': '3' }, method: 'PUT' }).then(() => null, e => e)
      console.log(JSON.stringify(describeFetchError(error)))`)
    expect(result).toBe('fetch failed: UND_ERR_INVALID_ARG invalid content-length header')
    expect(describeFetchError(new Error('r2_get_500'))).toBe('r2_get_500')
  })

  it('GETs bytes, and null for a missing object', async () => {
    expect(await getR2Object('cdn-staging', 'best.serp.co/a.png', env, local)).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(await getR2Object('cdn-staging', 'best.serp.co/missing.png', env, local)).toBeNull()
  })
})
