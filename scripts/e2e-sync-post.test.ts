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
    const { poster } = await stoppingPoster(stop)
    const started = Date.now()
    // `exiting`: the wake came from the thread's exit handler, as the caller's thread can't take
    // the `exit` event while it waits.
    expect(() => poster.post(`${origin}/hang`, '{}')).toThrow(
      /\/hang failed: the request thread stopped \(exiting\)\.$/u
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise(resolve => poster.thread.once('exit', resolve))
  })

  it('wakes a call whose thread exits between its check and its wait (#402)', async () => {
    const { poster, state } = await stoppingPoster('process.exit(3)', 1_000)
    const now = Date.now.bind(Date)
    let reads = 0
    // post() reads the clock for its deadline, then again between its EXITING check and its
    // wait. Holding that second read until the exit handler has notified on the reply count
    // (index 0) starts the wait after the exit.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (++reads === 2) Atomics.wait(state, 0, 0, 5_000)
      return now()
    })
    const started = now()
    try {
      expect(() => poster.post(`${origin}/hang`, '{}')).toThrow(/stopped \(exiting\)\.$/u)
    } finally {
      clock.mockRestore()
    }
    // Unless the exit changed the count, the wait sleeps to the deadline: the timeout plus 5 s.
    expect(now() - started).toBeLessThan(2_000)
    await new Promise(resolve => poster.thread.once('exit', resolve))
  })
})

/**
 * A poster from a fresh import of `sync-post.ts` whose request thread's source gets one more
 * listener, which runs `stop` 200 ms after a request arrives, while the call waits on a server
 * that never answers. `state` is the thread's shared state.
 */
async function stoppingPoster(stop: string, timeoutMs?: number) {
  let state: Int32Array | undefined
  vi.resetModules()
  vi.doMock('node:worker_threads', async importOriginal => {
    const actual = await importOriginal<typeof import('node:worker_threads')>()
    class StoppingWorker extends actual.Worker {
      constructor(source: string, options: WorkerOptions) {
        state = (options.workerData as { state: Int32Array }).state
        super(`${source}\nport.on('message', () => setTimeout(() => { ${stop} }, 200))`, options)
      }
    }
    return { ...actual, Worker: StoppingWorker }
  })
  try {
    const { startSyncPoster: start } = await import('../apps/web/e2e/sync-post')
    const poster = start(timeoutMs)
    if (!state) throw new Error('The request thread was not started.')
    return { poster, state }
  } finally {
    vi.doUnmock('node:worker_threads')
    vi.resetModules()
  }
}
