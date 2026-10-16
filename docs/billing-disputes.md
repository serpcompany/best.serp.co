# Disputes and refunds outside the site

How the billing webhook records a refund made in Stripe's dashboard, a refund that failed, and a
buyer's dispute (serpcompany/best.serp.co#473, #483, #484), and what each does to the listing. The
rest of billing (checkout, fulfilment, the site's own refunds, the sweep) is in
[Billing](./billing.md).

## Events

The webhook also takes `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` and
`refund.failed`, with the same signature check and once-per-event handling, and finds the order by
the charge's PaymentIntent (an unknown one is recorded as `unknown_order` and answered 200).
Everything is recorded before the answer; only the admin's email (`admin-payment-alert`) goes
after it, and the sweep re-sends it. The four events stay dormant until the owner ticks them on
both webhooks ([Configuration](./billing.md#configuration-owner)).

A refund of a payment the site hasn't recorded yet (before the checkout's own report, the buyer's
return or the sweep) finds its order by the `order_id` the checkout put on the PaymentIntent,
which the charge carries a copy of, but only an order with no payment recorded (#484): a full
refund records the payment, at the charge's amount, then the refund, so nothing applies the
payment later. A dispute carries no such copy, so one that opens, or closes lost, before its
payment is recorded asks Stripe for the Checkout Session that took the PaymentIntent
(`GET /v1/checkout/sessions?payment_intent=`, the read access `getCheckout` already uses) and
records the payment on that session's order, then the dispute: fulfilment never applies it (#484).
A charge no checkout of the site's took stays `unknown_order`, as does a dispute closed `won`
first, whose payment stands and is applied by its checkout's own report.

## Takedown

A dispute that opens (`dispute_status` `open`), or a full refund made in Stripe's dashboard
(`refunded`, an admin's refund by `provider`), takes down the listing the payment made or kept
live (a paid submission's, an upgrade's, a relist's) in the same batch, even in review (owner
decision on #156), and emails the admin. A dispute does too while the site's own refund is still
`refunding` (flagged `refund_failed` or not), and on a `refunded` order whose refund failed,
whether its `refund.failed` arrives before the dispute or after it (#484, the lead's decision on
#485): the money never went back. A refund that succeeded (`refunded`, not flagged) decided its
listing, so a dispute on it takes nothing down; one the refund took down stays down. The dispute
and the flag compare and swap on each other, so neither order of arrival is missed. A paid
claim's listing comes down too (owner, #473, 2026-10-16) while its payer still owns it by that
payment (after an admin's revoke or transfer: record and email only), owner kept for an admin to
decide, by the same rules. A held payment has none live.

Neither returns as paid: by one rule (`db/payment-kept.ts`: the paying order, a claim's latest,
refunded or disputed and not won), /admin (the listing page, the plan badge in the review queue
and on the review page) and the account read it free, the review queue shows "Refunded" or
"Disputed", Approve answers 409, and the weekly badge check takes a live one in. An account row
taken down in review says "Unpublished: payment disputed" (or refunded), and a resubmission's
review email says "Paid. Payment disputed", never a badge check. The refund also records an approved or held
submission refunded (`at_provider`; `paid_pending_review` can't hold `refunded_at`, a CHECK).
Fulfilment never applies a disputed payment (the apply refuses one disputed meanwhile).

## Disputes

A closed dispute records `won` or `lost` only, and an admin decides; a lost one never reported
open is opened first (takedown, email). No refund is asked of a payment whose dispute is open or
lost (Stripe refuses): admin Orders offers no "Refund…" and the refund routes answer 409.

Rejecting such a submission as `other` makes no refund call either (#483). The order records that
the dispute decides the refund (`refund_note`), the owner gets the plain `submission-rejected`,
the sweep stops retrying it while the dispute is open or lost, the reject dialog says so, and
admin Orders shows "Disputed · rejected: the dispute decides the refund". Once the dispute is won,
the payment is the site's again, so the sweep refunds it with the rejection's email, as the Terms
promise for a rejection; the admin is emailed ("Dispute won, refunding the rejection") and Orders
shows "Dispute won · rejected: refund pending" until then (#485). An admin's "Refund…" of a
rejection that a dispute opens on mid-refund answers 409 `disputed` and refunds nothing.

## Refunds

A partial refund changes nothing but records the amount refunded so far
(`partial_refund_cents`, `0017_order_partial_refunds`), which admin Orders shows ("Partly refunded
outside the site: $…"), and emails the admin (#484). `refund.failed` flags the site's refund
`refund_failed` and emails the admin; a refund that then succeeds clears it: the site's retry,
or a full refund in Stripe's dashboard of an order already `refunded` (#485). The site's own
refund's `charge.refunded` (its `refund:<order>` key) is the refund that failed, delivered late,
and clears nothing. A `refund.failed` for a refund other than the one the order recorded
(`provider_refund_id`: an earlier one, reported after the site's retry succeeded) flags nothing.

The site's own refund's `charge.refunded` finds the order `refunded`, or `refunding` while that
refund may still run (claimed under ten minutes ago, never failed), and changes nothing. After it
failed, the dashboard refund finishes it (its listing change, none for a claim, `refunded`, the
admin's email; a rejection's own refund then records the submission and emails the owner). One
the event says the site's own request made (its `refund:<order>` idempotency key: a call that
timed out after Stripe refunded) finishes it the same way, as the site's refund, with no
"refunded outside the site" email (#484). An admin's "Refund…" on an order refunded outside the
site, before it or while it was claimed, answers 409 and is never reported as the admin's refund.

Admin Orders shows "Disputed", "Dispute won", "Dispute lost" or "Refunded outside the site".
