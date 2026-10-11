import { once } from 'node:events'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startSyncPoster } from '../apps/web/e2e/sync-post'

/**
 * The e2e fixtures' synchronous POST (`apps/web/e2e/sync-post.ts`, under `suiteD1`): the server
 * runs in a thread of its own, as the Worker runs in a process of its own, because this thread
 * waits while a request is out.
 */
const SERVER = `
const { createServer } = require('node:http')
const { parentPort } = require('node:worker_threads')
const server = createServer((request, response) => {
  if (request.url === '/hang') return
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => response.writeHead(201).end('got ' + body))
})
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port))`

let server: Worker
let origin: string

beforeAll(async () => {
  server = new Worker(SERVER, { eval: true })
  const [port] = await once(server, 'message')
  origin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await server.terminate()
})

describe('the e2e fixtures’ synchronous POST (#389)', () => {
  it('answers with the status and body, or the request’s error', async () => {
    const poster = startSyncPoster()
    expect(poster.post(`${origin}/`, '{"sql":"SELECT 1"}')).toEqual({
      status: 201,
      text: 'got {"sql":"SELECT 1"}'
    })
    expect(() => poster.post('http://127.0.0.1:9/', '{}')).toThrow(
      /^http:\/\/127\.0\.0\.1:9\/ failed: TypeError: fetch failed$/u
    )
    await poster.thread.terminate()
  })

  it('gives up on a request with no answer after its timeout', async () => {
    const poster = startSyncPoster(300)
    const started = Date.now()
    expect(() => poster.post(`${origin}/hang`, '{}')).toThrow(/\/hang failed: TimeoutError/u)
    expect(Date.now() - started).toBeLessThan(3_000)
    await poster.thread.terminate()
  })

  it('fails every call at once after its thread stopped, instead of waiting out the deadline', async () => {
    const poster = startSyncPoster()
    await poster.thread.terminate()
    const started = Date.now()
    expect(() => poster.post(`${origin}/`, '{}')).toThrow(
      /failed: the request thread stopped \(exit code \d+\)\.$/u
    )
    expect(() => poster.post(`${origin}/`, '{}')).toThrow(/the request thread stopped/u)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it.each([
    ['throws', "throw new Error('the request thread crashed')"],
    ['calls process.exit', 'process.exit(3)']
  ])('wakes a call already waiting when its thread %s (#402)', async (_, stop) => {
    // The thread's source gets one more listener, which stops it 200 ms after a request arrives,
    // while the call waits on a server that never answers (the thread's own timeout is 30 s).
    vi.resetModules()
    vi.doMock('node:worker_threads', async importOriginal => {
      const actual = await importOriginal<typeof import('node:worker_threads')>()
      class StoppingWorker extends actual.Worker {
        constructor(source: string, options: WorkerOptions) {
          super(`${source}\nport.on('message', () => setTimeout(() => { ${stop} }, 200))`, options)
        }
      }
      return { ...actual, Worker: StoppingWorker }
    })
    try {
      const { startSyncPoster: startStopping } = await import('../apps/web/e2e/sync-post')
      const poster = startStopping()
      const started = Date.now()
      // `exiting`: the wake came from the thread's exit handler, as the caller's thread can't take
      // the `exit` event while it waits.
      expect(() => poster.post(`${origin}/hang`, '{}')).toThrow(
        /\/hang failed: the request thread stopped \(exiting\)\.$/u
      )
      expect(Date.now() - started).toBeLessThan(5_000)
      await new Promise(resolve => poster.thread.once('exit', resolve))
    } finally {
      vi.doUnmock('node:worker_threads')
      vi.resetModules()
    }
  })
})
