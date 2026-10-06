import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { adminSuiteEnabled, localD1, type SuiteServer } from './admin-fixture'

/**
 * The orders suite (serpcompany/best.serp.co#68) runs on its own local Worker and D1, started by
 * `playwright.config.ts` from the already-built Worker with orders and claims on (`LOCAL_ORDERS`,
 * `LOCAL_CLAIMS`, a local Worker only) and pointed at a mocked Stripe API on 127.0.0.1 (`LOCAL_STRIPE_MOCK_PORT`), with
 * the suite's own test-mode values for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Nothing
 * reaches Stripe: the mock answers the Checkout Session and refund calls the Worker makes, and
 * serves the "Stripe page" the buyer pays or cancels on. Never used against a deployed Worker.
 */

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

export const billingSuiteEnabled = adminSuiteEnabled

export const billingServer: SuiteServer = {
  // +3 admin, +4 media, +5 account, +6 badge program, +7 claims (#67).
  port: playwrightPort + 9,
  stateDirectory: resolve(tmpdir(), `best-serp-co-e2e-billing-${playwrightPort + 9}`)
}

/** Where the mocked Stripe API listens (the Worker reads it from `LOCAL_STRIPE_MOCK_PORT`). */
export const stripeMockPort = playwrightPort + 10

/** Test-mode values for this suite's local Worker only; never real keys. */
export const E2E_STRIPE_SECRET_KEY = 'sk_test_e2emock'
export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2emock'

export function billingOrigin(): string {
  return `http://127.0.0.1:${billingServer.port}`
}

export function billingServerCommand(): string {
  const state = billingServer.stateDirectory
  const vars = [
    'LOCAL_CLAIMS=on',
    'LOCAL_ORDERS=on',
    `LOCAL_STRIPE_MOCK_PORT=${stripeMockPort}`,
    `STRIPE_SECRET_KEY=${E2E_STRIPE_SECRET_KEY}`,
    `STRIPE_WEBHOOK_SECRET=${E2E_STRIPE_WEBHOOK_SECRET}`
  ].join(',')
  return [
    'cd ../..',
    `rm -rf "${state}"`,
    `mkdir -p "${state}"`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" pnpm db:migrate:local`,
    `HARNESS_D1_STATE_DIRECTORY="${state}" LOCAL_PREVIEW_VARS=${vars} PORT=${billingServer.port} pnpm tsx scripts/d1-local-preview.ts`
  ].join(' && ')
}

export function billingD1<T = Record<string, unknown>>(sql: string): T[] {
  return localD1<T>(sql, billingServer)
}

/** A `Stripe-Signature` header for `body`, signed now (or at `at`, in seconds). */
export function stripeSignatureHeader(body: string, at = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', E2E_STRIPE_WEBHOOK_SECRET)
    .update(`${at}.${body}`)
    .digest('hex')
  return `t=${at},v1=${signature}`
}

export interface MockSession {
  amount_total: number
  cancel_url: string
  client_reference_id: string
  currency: string
  expires_at: number
  id: string
  livemode: false
  metadata: { order_id: string }
  object: 'checkout.session'
  payment_intent: string | null
  payment_status: 'paid' | 'unpaid'
  status: 'complete' | 'expired' | 'open'
  success_url: string
  url: string
}

export interface MockRefund {
  amount: number
  id: string
  payment_intent: string
}

export interface StripeMock {
  close(): Promise<void>
  /** Marks the session paid, as Stripe does when the buyer pays. */
  pay(sessionId: string): MockSession
  refunds: MockRefund[]
  sessions: Map<string, MockSession>
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
    })
    request.on('end', () => resolveBody(body))
    request.on('error', reject)
  })
}

/**
 * The mocked Stripe API: `POST /v1/checkout/sessions`, `GET /v1/checkout/sessions/<id>`, and
 * `POST /v1/refunds`, each honoring `Idempotency-Key` and the test secret key, plus the buyer's
 * page `/pay/<id>` with "Pay" (completes the session and returns to its `success_url`) and
 * "Cancel" (its `cancel_url`).
 */
export async function startStripeMock(): Promise<StripeMock> {
  const sessions = new Map<string, MockSession>()
  const refunds: MockRefund[] = []
  const idempotent = new Map<string, unknown>()
  let counter = 0
  const pay = (sessionId: string): MockSession => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown session ${sessionId}`)
    if (session.status !== 'complete') {
      session.status = 'complete'
      session.payment_status = 'paid'
      session.payment_intent = `pi_e2e_${sessionId.slice(-6)}`
    }
    return session
  }
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${stripeMockPort}`)
    const json = (status: number, body: unknown) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const body = await readBody(request)
    if (url.pathname.startsWith('/v1/')) {
      if (request.headers.authorization !== `Bearer ${E2E_STRIPE_SECRET_KEY}`) {
        json(401, { error: { type: 'invalid_request_error', code: 'api_key_invalid' } })
        return
      }
      const key = request.headers['idempotency-key']
      const keyed = typeof key === 'string' ? `${url.pathname}:${key}` : null
      if (request.method === 'POST' && keyed && idempotent.has(keyed)) {
        json(200, idempotent.get(keyed))
        return
      }
      const form = new URLSearchParams(body)
      let answer: unknown
      if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        counter += 1
        const id = `cs_test_e2e${Date.now().toString(36)}${counter}`
        const session: MockSession = {
          amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
          cancel_url: form.get('cancel_url') ?? '',
          client_reference_id: form.get('client_reference_id') ?? '',
          currency: form.get('line_items[0][price_data][currency]') ?? '',
          expires_at: Number(form.get('expires_at')),
          id,
          livemode: false,
          metadata: { order_id: form.get('metadata[order_id]') ?? '' },
          object: 'checkout.session',
          payment_intent: null,
          payment_status: 'unpaid',
          status: 'open',
          success_url: form.get('success_url') ?? '',
          url: `http://127.0.0.1:${stripeMockPort}/pay/${id}`
        }
        sessions.set(id, session)
        answer = session
      } else if (
        request.method === 'POST' &&
        /^\/v1\/checkout\/sessions\/[^/]+\/expire$/u.test(url.pathname)
      ) {
        const session = sessions.get(url.pathname.split('/')[4] ?? '')
        if (!session || session.status !== 'open') {
          json(400, { error: { code: 'checkout_session_not_open' } })
          return
        }
        session.status = 'expired'
        answer = session
      } else if (request.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
        const session = sessions.get(url.pathname.split('/').pop() ?? '')
        if (!session) {
          json(404, { error: { code: 'resource_missing' } })
          return
        }
        answer = session
      } else if (request.method === 'POST' && url.pathname === '/v1/refunds') {
        const paymentIntent = form.get('payment_intent') ?? ''
        if (refunds.some(refund => refund.payment_intent === paymentIntent)) {
          json(400, { error: { code: 'charge_already_refunded' } })
          return
        }
        const refund = {
          amount: Number(form.get('amount')),
          id: `re_e2e_${refunds.length + 1}`,
          payment_intent: paymentIntent
        }
        refunds.push(refund)
        answer = { ...refund, object: 'refund', status: 'succeeded' }
      } else {
        json(404, { error: { code: 'resource_missing' } })
        return
      }
      if (keyed) idempotent.set(keyed, answer)
      json(200, answer)
      return
    }
    const match = /^\/pay\/([^/]+)\/?(complete)?$/u.exec(url.pathname)
    const session = match ? sessions.get(match[1] ?? '') : undefined
    if (!session) {
      response.writeHead(404).end('unknown session')
      return
    }
    if (match?.[2] === 'complete' && request.method === 'POST') {
      pay(session.id)
      response.writeHead(303, { location: session.success_url }).end()
      return
    }
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><title>Mock checkout</title><p>${session.amount_total} ${session.currency}</p>` +
          `<form method="post" action="/pay/${session.id}/complete"><button type="submit">Pay</button></form>` +
          `<a href="${session.cancel_url}">Cancel</a>`
      )
  })
  await new Promise<void>(resolveListen =>
    server.listen(stripeMockPort, '127.0.0.1', resolveListen)
  )
  return {
    close: () => new Promise(resolveClose => server.close(() => resolveClose())),
    pay,
    refunds,
    sessions
  }
}
