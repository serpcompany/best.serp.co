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
payment later. A dispute carries no such copy, so one reported before its payment is recorded
stays `unknown_order`; its close is recorded once the payment is.

## Takedown

A dispute that opens (`dispute_status` `open`), or a full refund made in Stripe's dashboard
(`refunded`, an admin's refund by `provider`), takes down the listing the payment made or kept
live (a paid submission's, an upgrade's, a relist's) in the same batch, even in review (owner
decision on #156), and emails the admin. A dispute does too while the site's own refund is still
`refunding` (flagged `refund_failed` or not), never once it is `refunded`, unless that refund's
`refund.failed` arrives after the dispute, which takes the listing down then (#484); one the
refund took down stays down. A paid claim's listing comes down too (owner, #473, 2026-10-16)
while its payer still owns it by that payment (after an admin's revoke or transfer: record and
email only), owner kept for an admin to decide; one refunded in /admin stays up unless a dispute
opens while its refund is still `refunding` (flagged or not). A held payment has none live.

Neither returns as paid: by one rule (`db/payment-kept.ts`: the paying order, a claim's latest,
refunded or disputed and not won), /admin (the listing page, the review queue's plan) and the
account read it free, the review queue shows "Refunded" or "Disputed", Approve answers 409, and
the weekly badge check takes a live one in. The refund also records an approved or held
submission refunded (`at_provider`; `paid_pending_review` can't hold `refunded_at`, a CHECK).
Fulfilment never applies a disputed payment (the apply refuses one disputed meanwhile).

## Disputes

A closed dispute records `won` or `lost` only, and an admin decides; a lost one never reported
open is opened first (takedown, email). No refund is asked of a payment whose dispute is open or
lost (Stripe refuses): admin Orders offers no "Refund…" and the refund routes answer 409.

Rejecting such a submission as `other` makes no refund call either (#483). The order records that
the dispute decides the refund (`refund_note`), the owner gets the plain `submission-rejected`,
the sweep stops retrying it, the reject dialog says so, and admin Orders shows "Disputed ·
rejected: the dispute decides the refund". After a won dispute, an admin's "Refund…" refunds it
with the rejection's email.

## Refunds

A partial refund changes nothing but records the amount refunded so far
(`partial_refund_cents`, `0017_order_partial_refunds`), which admin Orders shows ("Partly refunded
outside the site: $…"), and emails the admin (#484). `refund.failed` flags the site's refund
`refund_failed` and emails the admin; a refund that then succeeds clears it.

The site's own refund's `charge.refunded` finds the order `refunded`, or `refunding` while that
refund may still run (claimed under ten minutes ago, never failed), and changes nothing. After it
failed, the dashboard refund finishes it (its listing change, none for a claim, `refunded`, the
admin's email; a rejection's own refund then records the submission and emails the owner). One
the event says the site's own request made (its `refund:<order>` idempotency key: a call that
timed out after Stripe refunded) finishes it the same way, as the site's refund, with no
"refunded outside the site" email (#484). An admin's "Refund…" on an order refunded outside the
site, before it or while it was claimed, answers 409 and is never reported as the admin's refund.

Admin Orders shows "Disputed", "Dispute won", "Dispute lost" or "Refunded outside the site".
