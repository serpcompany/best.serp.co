/**
 * How much time a checkout needs (serpcompany/best.serp.co#128), shared by the billing service
 * and the claim dialog, so the page and the server agree on when a paid claim's confirmation is
 * too close to running out to pay for. No server-only imports: the claim dialog imports it.
 */

/** The shortest checkout the provider opens (Stripe: 30 minutes), with a minute's margin. */
export const SHORTEST_CHECKOUT_MS = 31 * 60 * 1000

/**
 * True when a checkout that must close by `closesBy` can't open at `now` (both epoch
 * milliseconds): less than the shortest checkout is left. A paid claim's checkout closes with its
 * confirmation, so the claim dialog then asks for a new code and the checkout route refuses it.
 */
export function tooLateForCheckout(closesBy: number, now: number): boolean {
  return closesBy - now < SHORTEST_CHECKOUT_MS
}
