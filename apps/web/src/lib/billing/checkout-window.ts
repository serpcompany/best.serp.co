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

/**
 * Where the checkout route sends a paid claim it refused because too little of the confirmation
 * is left, or none: the listing's claim dialog, told to ask for a new code (#128, #476). The
 * server's clock decided, so the dialog asks whatever the browser's clock says. Relative: the
 * browser stays on the origin it came from.
 */
export const CONFIRM_AGAIN_HASH = '#claim-confirm-again'

export function confirmAgainPath(listingSlug: string): string {
  return `/products/${listingSlug}/${CONFIRM_AGAIN_HASH}`
}
