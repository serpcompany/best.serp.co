import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'

/**
 * Synchronous JSON POSTs for the e2e fixtures' D1 helper (`suiteD1` in `admin-fixture.ts`), whose
 * callers are synchronous: a worker thread makes each request while the calling thread waits
 * for its reply. Nothing else in the test process runs while it waits, so the thread's fetch
 * gives up after `timeoutMs`, and the caller waits a little longer for that answer.
 *
 * A thread that stops fails the next call at once, with the reason, instead of leaving every
 * later call to wait out its deadline (#389). One that stops with an error or `process.exit`
 * also wakes the call waiting on it.
 */

/** The thread's state: [0] the replies it has posted, [1] 1 once it is exiting. */
const REPLIES = 0
const EXITING = 1

/** Posts JSON, replies with the status and body text or the error, then counts the reply. */
const SOURCE = `
const { workerData } = require('node:worker_threads')
const { port, state, timeoutMs } = workerData
process.on('exit', () => {
  Atomics.store(state, ${EXITING}, 1)
  Atomics.notify(state, ${REPLIES})
})
port.on('message', async ({ body, id, url }) => {
  let reply
  try {
    const response = await fetch(url, {
      body,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    reply = { id, status: response.status, text: await response.text() }
  } catch (error) {
    reply = { error: String(error), id }
  }
  port.postMessage(reply)
  Atomics.add(state, ${REPLIES}, 1)
  Atomics.notify(state, ${REPLIES})
})`

/** How much longer than the thread's own timeout a call waits for its answer. */
const GRACE_MS = 5_000

interface Reply {
  error?: string
  id: number
  status?: number
  text?: string
}

export interface SyncPoster {
  post(url: string, body: string): { status: number; text: string }
  /** The thread that makes the requests (tests stop it). */
  thread: Worker
}

export function startSyncPoster(timeoutMs = 30_000): SyncPoster {
  const state = new Int32Array(new SharedArrayBuffer(8))
  const { port1, port2 } = new MessageChannel()
  const thread = new Worker(SOURCE, {
    eval: true,
    transferList: [port2],
    workerData: { port: port2, state, timeoutMs }
  })
  let stopped: string | undefined
  // An error ends the thread; it is reported by the next call rather than thrown here.
  thread.on('error', error => {
    stopped ??= String(error)
  })
  thread.on('exit', code => {
    stopped ??= `exit code ${code}`
  })
  thread.unref()
  port1.unref()
  let requests = 0
  const stoppedError = (url: string) =>
    new Error(`${url} failed: the request thread stopped (${stopped ?? 'exiting'}).`)

  return {
    post(url, body) {
      if (stopped !== undefined || Atomics.load(state, EXITING) === 1) throw stoppedError(url)
      const id = ++requests
      port1.postMessage({ body, id, url })
      const deadline = Date.now() + timeoutMs + GRACE_MS
      for (;;) {
        const seen = Atomics.load(state, REPLIES)
        const received = receiveMessageOnPort(port1)
        if (received) {
          const reply = received.message as Reply
          // A late reply to a request that timed out.
          if (reply.id !== id) continue
          if (reply.text === undefined) throw new Error(`${url} failed: ${reply.error}`)
          return { status: reply.status ?? 0, text: reply.text }
        }
        if (Atomics.load(state, EXITING) === 1) throw stoppedError(url)
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(
            `No answer from ${url} in ${Math.round((timeoutMs + GRACE_MS) / 1000)} seconds.`
          )
        }
        Atomics.wait(state, REPLIES, seen, remaining)
      }
    },
    thread
  }
}
