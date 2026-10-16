/**
 * Whether a payment is still kept (#473): the one rule for everything that reads a submission or
 * a listing as paid. A payment refunded (by the site, or at the provider), or disputed and not
 * won (open, or lost), is no longer kept: /admin reads its listing as free, Approve refuses it,
 * the review queue shows it refunded or disputed with no amount paid, the weekly badge check
 * takes its live listing in as a free one, and the owner's account shows no "Paid". A won
 * dispute keeps it.
 */

/** Why a payment is no longer kept. */
export type PaymentLoss = 'disputed' | 'refunded'

export function toPaymentLoss(value: unknown): PaymentLoss | null {
  return value === 'refunded' || value === 'disputed' ? value : null
}

/** Why order `o`'s payment is no longer kept: `refunded`, `disputed`, or NULL while kept. */
export const orderPaymentLossSql = (order: string) => `(CASE WHEN ${order}.status='refunded'
    THEN 'refunded' WHEN ${order}.dispute_status IN ('open','lost') THEN 'disputed' END)`

/** The outcomes of the order applied to a paid submission (it is paid once). */
const SUBMISSION_PAYMENT_OUTCOMES = `'published','held','upgraded','relisted'`

/**
 * Why submission `s`'s payment is no longer kept: refunded (recorded on it, or on the order
 * applied to it, since one in review can't hold `refunded_at`), or disputed; NULL while it is,
 * and for a submission never paid.
 */
export const submissionPaymentLossSql = (submission: string) => `(CASE
    WHEN ${submission}.plan IS NOT 'paid' OR ${submission}.paid_at IS NULL THEN NULL
    WHEN ${submission}.refunded_at IS NOT NULL THEN 'refunded'
    ELSE (SELECT ${orderPaymentLossSql('kp')} FROM orders kp
      WHERE kp.submission_id=${submission}.id AND kp.outcome IN (${SUBMISSION_PAYMENT_OUTCOMES})
        AND ${orderPaymentLossSql('kp')} IS NOT NULL
      ORDER BY kp.status='refunded' DESC,kp.id LIMIT 1) END)`

/** The claim payment that made `user` the owner of `listing`: their latest one applied. */
export const paidClaimOrderSql = (listing: string, user: string) => `(SELECT kl.id FROM orders kl
    WHERE kl.purpose='claim' AND kl.listing_id=${listing} AND kl.user_id=${user}
      AND kl.outcome='claimed' ORDER BY kl.applied_at DESC,kl.id DESC LIMIT 1)`

/** Why the paid claim that made `user` the owner of `listing` is no longer kept, or NULL. */
export const claimPaymentLossSql = (listing: string, user: string) =>
  `(SELECT ${orderPaymentLossSql('kc')} FROM orders kc WHERE kc.id=${paidClaimOrderSql(listing, user)})`
