# Billing

Paid listings (serpcompany/best.serp.co#68): **$49 USD, one-off and permanent**
(`site.submissions.paidListingPriceCents`), sold through Stripe Checkout behind a
provider-agnostic billing module, so SERP's self-hosted Lago can replace Stripe later. Everything
here is off while `features.orders` (`apps/web/lib/features.ts`) is off, which is the default.

## Module

| Piece | Where | Does |
|---|---|---|
| Provider interface | `apps/web/lib/billing/provider.ts` | `createCheckout`, `getCheckout`, `verifyWebhook`, `refund` |
| Stripe | `apps/web/lib/billing/stripe.ts` | The only Stripe code: `fetch` and Web Crypto, no Node SDK |
| Service | `apps/web/lib/billing/service.ts` | Checkout, webhook, fulfilment, refunds, the sweep |
| Guardrails | `apps/web/lib/billing/guardrails.ts` | Checks before a paid submission goes live |
| Runtime | `apps/web/lib/billing/{runtime,worker-billing,flags,http}.ts` | Bindings, secrets, the flag, route helpers |
| Ledger | `packages/data-ops/src/billing.ts` | `orders` and `billing_events` statement plans and reads |

The architecture guard keeps billing SQL in `packages/data-ops` and every Stripe specific (API
host, signature header, event names, secret names) inside `lib/billing/`. Swapping in Lago
means a `lago.ts` implementing `BillingProvider` and a change in `worker-billing.ts`.

## Data

`orders` (`0008_billing_orders`) is the ledger of record for every charge and refund: the buyer,
`kind` (`paid_listing` | `paid_claim`), `purpose` (`submission`, `upgrade`, `relist`, `claim`),
the target (submission, listing, or claim), amount and currency, provider and its references
(checkout, payment, refund), what was actually charged, `status` (`pending` → `paid` →
`refunding` → `refunded`, or `failed`), `outcome` once applied (`published`, `held`,
`upgraded`, `relisted`, `claimed`, `unapplied`), the refund reason (`rejected`, `admin`,
`unapplied`), actor, and an admin refund's listing decision and badge check, `attention`
(`amount_mismatch`, `listing_update_failed`), and timestamps. A partial unique index allows
one `pending` order per target, so a double click or a second tab reuses the open checkout.
`billing_events` records each provider event once by `(provider, event_id)`.

## Flows

Every step is a compare-and-swap on the order, so the webhook, its replays, the buyer's return,
and the hourly sweep can all report the same payment and only one applies it. A refund is
claimed in D1 first (`paid` → `refunding`, on the state it was decided on: an unapplied payment
only while nothing applied it, an applied one only with the outcome it was read with), then
asked of Stripe, then finalized (`refunded`), so a racing fulfilment can never apply a refunded
payment nor a refund undo an applied one. Provider calls carry idempotency keys
(`checkout:<order>`, `refund:<order>`).

- **Checkout.** `GET /submit/<id>/checkout/` (the choose and badge steps' "$49" links, and the
  draft reminder's "Complete checkout") and `GET /account/listings/<slug>/checkout/` ("Upgrade:
  $49 one-off" in the badge panel of a live free listing, "Relist for $49" on a listing the badge
  program unlisted) open or reuse a one-hour, card-only Checkout Session and redirect to it. A
  superseded session is expired at Stripe, and one the ledger failed to record is expired and
  never handed out. A website now covered by a prohibited block, or already listed, is refused
  before any checkout. A draft with no plan chooses paid first. The account shows "Upgrade"
  and "Relist" only when the checkout would accept them (never after a refund). A submission or listing that can't be paid for goes to
  its account page. Next.js router requests never open one, and the links are plain anchors.
- **Return.** Stripe returns to `/submit/<id>/checkout/success/?order=<id>` (or the account
  listing's): the route asks Stripe about the session and applies a paid one, then opens the
  account page. Cancelling returns to `/submit/<id>/choose/` (or the account listing).
- **Webhook.** `POST /api/billing/webhook/` verifies the raw body's `Stripe-Signature` within 300
  seconds, records the event, acts, and marks it processed; a processed event answers
  `replayed: true`. A failure answers 500 and the retry runs it again. An event of the other
  mode (`livemode` against the environment) or naming another account is recorded as ignored,
  and an event acts only on the order holding its session id (the session's order reference
  only for an order that never recorded its session). A charge that doesn't match the order's
  amount and currency is flagged `amount_mismatch` and refunded in full, never applied.
- **Paid submission.** The guardrails run: a public address under the safe-fetch rules, the site
  answers with an HTML page, no listing has the website, and no prohibited block covers it. Pass:
  the listing is created and published (catalog version bump) and the submission is
  `paid_pending_review`: live and in the review queue; the submitter gets `listing-live-paid` and
  the admin `admin-review-ready` (paid, live now). Fail: `verified` with the paid plan, not live;
  `payment-received-in-review` and the admin alert (paid, waiting for review).
- **Upgrade and relist.** An upgrade moves the approved free submission to the paid plan (the
  listing stays live; the badge becomes optional). A relist republishes a listing whose latest
  unpublish was the badge program's (`badge_missing`) on the paid plan. Neither sends an email:
  #70 has none for them.
- **Paid claim (#67).** The service has `startClaimCheckout` and applies a claim payment through
  `PaidClaims.complete` (`completePaidClaim`). Until #67's module is wired in
  `worker-billing.ts`, a claim checkout is a 404 and a claim payment is refunded.
- **Unapplied payments.** A payment the target can no longer accept (withdrawn or expired, already
  paid by another checkout, rejected, unlisted by an admin) is refunded in full and recorded
  (`unapplied`); a withdrawn submission records it with `buildRecordUnappliedPaymentPlans`.
- **Rejection refund.** Rejecting a paid submission as `other` refunds its order through the admin
  panel's `AdminRefunds` hook and sends `submission-rejected-refunded`; `prohibited` never
  refunds. The hook runs after the rejection, on every replay, and from the sweep.
- **Refund from Orders.** `/admin/orders/` lists orders; Refund (`POST
  /api/admin/orders/<id>/refund`) on a live paid listing runs `checkBadgeAtRefund` once (#66):
  a pass keeps it live as free, a miss or an inconclusive check unpublishes it (410). One already
  down is refunded as is. A submission still in review is rejected instead (409), a prohibited
  rejection is never refunded, and an unapplied or claim order is refunded from the order alone.
  The badge check and the listing decision are recorded with the claim, so a retry (a lost
  write, Stripe down) finishes that decision without checking again; a listing change that
  keeps failing still records the refund, flagged `listing_update_failed`, and answers
  "pending". No email: #70 has none for it.
- **Sweep.** The hourly cron (`billing-sweep` in `lib/worker/scheduled.ts`) retries pending
  rejection refunds, finishes claimed refunds, reconciles pending orders whose checkout closed
  (paid → applied, otherwise `failed`) and failed orders for three days (a superseded session
  paid late), and applies paid orders a crash left unapplied.

No self-withdraw after payment (#59): the withdraw plans already refuse a paid submission.

## Configuration (owner)

Stripe account `acct_1RiT0QCp8si97z5s`: test mode on staging, live mode in production. Agents
never set or read these values.

| Worker secret | Staging | Production |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (or a restricted `rk_test_…`) | `sk_live_…` (or `rk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | the staging endpoint's `whsec_…` | the production endpoint's `whsec_…` |

The Worker refuses a live key outside production and a test key in production. A restricted
key needs write access to Checkout Sessions and Refunds. Webhook endpoints (trailing slash
included; Stripe does not follow redirects):

- `https://best.serp.co/api/billing/webhook/` (live mode)
- the staging Worker's origin + `/api/billing/webhook/` (test mode)

Events: `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. No Stripe
Tax: billing refuses to start while `site.submissions.automaticTax` is on, since a taxed charge
wouldn't match its order. Then set `features.orders` to `true`.

## Tests

`apps/web/lib/billing/{stripe,service}.test.ts` (node:sqlite and a fake provider),
`scripts/d1-drizzle-local.test.ts` (the migration), and `apps/e2e/tests/billing.spec.ts`
(Playwright on its own Worker, `PLAYWRIGHT_PORT` + 7, with orders on through `LOCAL_ORDERS` and a
mocked Stripe API on `PLAYWRIGHT_PORT` + 8: checkout success and cancel, webhook replay, upgrade,
refunds with a badge pass and a miss, and the `other` rejection refund).
