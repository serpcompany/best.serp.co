import 'server-only'

import type { SessionUser } from '../auth/guards'
import { getRequestUser } from '../auth/server'
import { billing, publicOrigin } from './runtime'
import type { BillingDependencies, CheckoutStart } from './service'

/**
 * The checkout routes' shared HTTP shape (#68). They are GET routes, because the approved pages
 * and emails link to them ("Pay $49 and go live", "Complete checkout", "Upgrade", "Relist"):
 * opening one only opens (or reuses) a checkout at the provider, which charges nothing until the
 * buyer pays there. A Next.js router prefetch or RSC request never opens one.
 */

const NO_STORE = { 'cache-control': 'private, no-store' }

export function noStore(status: number, body: string | null = null): Response {
  return new Response(body, {
    headers: { ...NO_STORE, ...(body ? { 'content-type': 'text/plain; charset=utf-8' } : {}) },
    status
  })
}

/** A path stays relative, so the browser stays on the origin it came from. */
export function redirectTo(location: string): Response {
  return new Response(null, {
    headers: { ...NO_STORE, location },
    status: 303
  })
}

/** A Next.js router request (a prefetch or a client navigation): never a checkout. */
export function isRouterRequest(request: Request): boolean {
  return ['rsc', 'next-router-prefetch', 'next-router-state-tree'].some(
    name => request.headers.get(name) !== null
  )
}

type CheckoutHandler = (input: {
  deps: BillingDependencies
  origin: string
  user: { email: string; id: string }
}) => Promise<Response>

/**
 * Runs a checkout route: 404 while orders are off, the sign-in page (and back) when signed
 * out, 503 when billing is misconfigured, and the handler otherwise. Account routes pass the
 * user `requireAccountUser()` already resolved.
 */
export async function withCheckout(
  request: Request,
  returnPath: string,
  handler: CheckoutHandler,
  signedIn?: SessionUser
): Promise<Response> {
  if (isRouterRequest(request)) return noStore(204)
  let deps: BillingDependencies | null
  try {
    deps = await billing()
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'billing_unavailable',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return noStore(503, 'Checkout is unavailable right now. Try again.')
  }
  if (!deps) return noStore(404, 'Not found')
  const user = signedIn ?? (await getRequestUser(request))
  if (!user) return redirectTo(`/login/?callbackUrl=${encodeURIComponent(returnPath)}`)
  return handler({ deps, origin: await publicOrigin(request), user })
}

/** Sends the buyer to the provider, or to where things stand, or answers the failure. */
export function checkoutResponse(start: CheckoutStart): Response {
  if (!start.ok) return noStore(start.status, start.message)
  return redirectTo('url' in start ? start.url : start.redirect)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value)
}
