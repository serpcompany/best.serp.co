# Billing

Paid listings (serpcompany/best.serp.co#68): **$49 USD, one-off and permanent**
(`site.submissions.paidListingPriceCents`), sold through Stripe Checkout behind a
provider-agnostic billing module, so SERP's self-hosted Lago can replace Stripe later. It runs
while `features.orders` (`apps/web/src/lib/features.ts`) is on, which it is since #133 (the
owner's decision, with the provider's secrets and webhooks set up; see
[Configuration](#configuration-owner)). The submit flow then offers the paid plan ("Skip the
badge: $49 one-off", "Pay $49 and go live"), the account offers "Upgrade: $49 one-off" and
"Relist for $49", the claim dialog offers "Skip the badge: $49 one-off" ([Claims](./CLAIMS.md)),
the admin sidebar shows Orders, the draft reminder and the badge program's emails make their
paid offers, and the hourly sweep runs. Turned off, all of that is hidden, every checkout route
and the webhook answer 404, `/admin/orders/` is a 404, and the sweep does nothing.

## Module

| Piece | Where | Does |
|---|---|---|
| Provider interface | `apps/web/src/lib/billing/provider.ts` | `createCheckout`, `getCheckout`, `verifyWebhook`, `refund` |
| Provider | `apps/web/src/lib/billing/providers/{index,stripe}.ts` | The only Stripe code (secrets, key modes, API): `fetch` and Web Crypto, no Node SDK |
| Service | `apps/web/src/lib/billing/service.ts` | Checkout, webhook, fulfilment, refunds, the sweep |
| Guardrails | `apps/web/src/lib/billing/guardrails.ts` | Checks before a paid submission goes live |
| Runtime | `apps/web/src/lib/billing/{runtime,worker-billing,flags,http}.ts` | Bindings, the flag, route helpers |
| Ledger | `apps/web/src/db/billing.ts` | `orders` and `billing_events` statement plans and reads |

The architecture guard keeps billing SQL in `apps/web/src/db` and every Stripe specific (API
host, signature header, event names, secret names) in `lib/billing/providers/`. Swapping in Lago
means a `providers/lago.ts` implementing `BillingProvider` and a change in `providers/index.ts`.

**The provider is never named to people** (owner decision on #70): no "Stripe" on pages, in
emails, in the admin panel, in error lines, in the legal pages, or in the item names sent to the
provider's own checkout page. Copy says "secure checkout", "our payment provider", or "payment".
An architecture guard fails on the name in any string or JSX text outside
`lib/billing/providers/` (the app, the UI packages, `apps/web/src/db/src`, and
`apps/web/content/`), pins the provider page's item name to the order's neutral
description, and the end-to-end suite checks every screen it visits.

## Data

`orders` (`0009_billing_orders`; `0008` is #67's) is the ledger of record for every charge and refund: its
number (`ORD-1001` on), the buyer,
`kind` (`paid_listing` | `paid_claim`), `purpose` (`submission`, `upgrade`, `relist`, `claim`),
the target (submission, listing, or claim), amount and currency, provider and its references
(checkout, payment, refund), what was actually charged, `status` (`pending` → `paid` →
`refunding` → `refunded`, or `failed`), `outcome` once applied (`published`, `held`,
`upgraded`, `relisted`, `claimed`, `unapplied`), the refund reason (`rejected`, `admin`,
`unapplied`), actor, note, and an admin refund's listing decision and badge check, `attention`
(`amount_mismatch`, `refund_failed`), refund attempts and their backoff, and timestamps. A partial unique index allows
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

- **Screens** (#70 screen 4, copy from `.archive/mockups/submissions/COPY.md`): the handoff
  `/submit/<id>/checkout/` (4a; the choose and badge steps' "$49" links and the draft reminder's
  "Complete checkout" open it, and it moves on to the checkout by itself); the return
  `/submit/<id>/checkout/return/?order=<id>` (4c confirming, refreshing until settled; 4d live
  and in review; 4e waiting for review after a failed check; 4g failed); and
  `/submit/<id>/checkout/cancelled/` (4f).
- **Checkout.** `GET /submit/<id>/checkout/start/` and `GET /account/listings/<slug>/checkout/` ("Upgrade:
  $49 one-off" in the badge panel of a live free listing, "Relist for $49" on a listing the badge
  program unlisted) open or reuse a one-hour, card-only Checkout Session and redirect to it. It
  sells the catalog price for the order's kind (#250, [Prices](#prices-and-promotion-codes)) and
  allows promotion codes; a price that isn't `paidListingPriceCents` in USD expires the new
  session and answers 503, so the page and the charge never differ. A
  superseded session is expired at Stripe, and one the ledger failed to record is expired and
  never handed out. A website now covered by a prohibited block, or already listed, is refused
  before any checkout. A draft with no plan chooses paid first. The account shows "Upgrade"
  and "Relist" only when the checkout would accept them (never after a refund). A submission or listing that can't be paid for goes to
  its account page. Next.js router requests never open one, and the links are plain anchors.
- **Return.** Stripe returns to the return page (or, for an upgrade or relist, the account
  listing's success route): it asks Stripe about the order's own session and applies a paid one
  if the webhook hasn't. Cancelling returns to the cancelled page (or the account listing).
- **Webhook.** `POST /api/billing/webhook/` verifies the raw body's `Stripe-Signature` within 300
  seconds, records the event, acts, and marks it processed; a processed event answers
  `replayed: true`. A failure answers 500 and the retry runs it again. An event of the other
  mode (`livemode` against the environment) or naming another account is recorded as ignored,
  and an event acts only on the order holding its session id (the session's order reference
  only for an order that never recorded its session). A charge must be the order's amount and
  currency less exactly the promotion code's discount (`chargedCents` records what was paid). A
  100%-off checkout has no payment, so its session id is the payment reference and a refund of
  it calls nothing. Any other charge is flagged `amount_mismatch` and refunded in full.
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
- **Paid claim (#67).** Only while claims are on as well as orders (`lib/billing/paid-claims.ts`).
  The claim dialog's "Continue to payment" opens `GET /claims/<id>/checkout/` for a confirmed
  paid claim (in time, the listing unowned); the return `/claims/<id>/checkout/success/` and a
  cancel both go back to `/products/<slug>/#claim`. The checkout closes when the confirmation
  does (none opens in its last half hour). The payment completes the claim through
  `completePaidClaim` (the claimer becomes the owner, `paid_claim`) in one D1 batch with the
  order's applied record, so a payment completed the claim exactly when it is applied. Any other
  payment for it (a second tab, a claim completed by the badge, one an admin refunded meanwhile,
  someone else owning the listing, an expired confirmation) is refunded.
- **Unapplied payments.** A payment the target can no longer accept (withdrawn or expired, already
  paid by another checkout, rejected, unlisted by an admin) is refunded in full and recorded
  (`unapplied`); a withdrawn submission records it with `buildRecordUnappliedPaymentPlans`.
- **Rejection refund.** Rejecting a paid submission as `other` refunds its order through the admin
  panel's `AdminRefunds` hook and sends `submission-rejected-refunded`; `prohibited` never
  refunds. The hook runs after the rejection, on every replay, and from the sweep.
- **Refund from Orders.** `/admin/orders/` (#70 screen 13) lists orders. "Refund…" first asks
  `POST /api/admin/orders/<id>/refund-preview`, which decides the refund and, for a live paid
  listing, runs `checkBadgeAtRefund` once (#66), so the dialog shows 13c (keeps a passing badge)
  or 13b (unpublish); `POST /api/admin/orders/<id>/refund` then sends that check's id and the
  reason for the activity log (`refund_note`), and the refund applies that same check:
  a pass keeps it live as free, a miss or an inconclusive check unpublishes it (410). One already
  down is refunded as is. A submission still in review is rejected instead (409), a prohibited
  rejection is never refunded, and an unapplied or claim order is refunded from the order alone.
  The badge check and the listing decision are recorded with the claim, and finishing applies
  that decision whatever its age or any later check (`decidedAt`), so a retry (a lost write,
  Stripe down, the sweep an hour later) never checks again and never leaves the listing live on
  the paid plan. The refund sends the dialog's check and listing decision; a check a newer
  dialog replaced, one over an hour old, or a decision that no longer holds answers 409 and the
  dialog previews again, so a refund never does other than the button said. A listing that went
  down meanwhile is refunded as it is. No email: #70 has none for it.
- **Sweep.** The hourly cron (`billing-sweep` in `lib/worker/scheduled.ts`) works most urgent
  first, with at most 20 Stripe calls a run: paid orders a crash left unapplied, claimed refunds
  (at most half the calls; a refund Stripe refuses backs off 1, 2, 4, 8 and 16 hours and is
  flagged `refund_failed` for an admin after five failures, after which only "Refund…" retries
  it), pending orders whose checkout closed (paid → applied, otherwise `failed`), failed
  orders whose superseded checkout couldn't be confirmed expired (for three days; it expires an
  open one and drops one Stripe expired), then refunds still owed after an `other` rejection.

No self-withdraw after payment (#59): the withdraw plans already refuse a paid submission.

## Configuration (owner)

Stripe account `acct_1RiT0QCp8si97z5s`: test mode on staging, live mode in production. Agents
never set or read these values.

| Worker secret | Staging | Production |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (or a restricted `rk_test_…`) | `sk_live_…` (or `rk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | the staging endpoint's `whsec_…` | the production endpoint's `whsec_…` |

The Worker refuses a live key outside production and a test key in production. A restricted
key needs write access to Checkout Sessions and Refunds, and read access to Products and Prices. Webhook endpoints (trailing slash
included; Stripe does not follow redirects):

- `https://best.serp.co/api/billing/webhook/` (live mode)
- `https://staging.best.serp.co/api/billing/webhook/` (test mode; staging's canonical host
  since #323, whose workers.dev host 308s there)

### Prices and promotion codes

The owner manages the catalog in the account's dashboard (#250). Checkout sells these one-off
$49.00 USD prices (`STRIPE_PRICES` in `lib/billing/providers/index.ts`):

| Product | Test mode (staging) | Live mode (production) |
|---|---|---|
| best.serp.co Paid listing | `price_1UOQRHCp8si97z5sqYTUNjxv` | `price_1UOQSUCp8si97z5sqEz614sI` |
| best.serp.co Paid claim | `price_1UOQRiCp8si97z5sJHO0RNcz` | `price_1UOQT5Cp8si97z5s8gXo0jHH` |

A coupon with a promotion code, made in the same mode, works at checkout. Changing the price
needs `paidListingPriceCents` changed too, or checkout refuses. A price id exists only in this
account, so a key from another account can't open a checkout. A restricted key needs read
access to Products and Prices as well.

Events: `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. No Stripe
Tax: billing refuses to start while `site.submissions.automaticTax` is on, since a taxed charge
wouldn't match its order.

`features.orders` is `true` since #133: the staging Worker has its test-mode secrets and
webhook. **Production needs its live secrets before the promotion that ships #133.** A Worker
with orders on but without them still shows the paid options, but every checkout answers 503,
the webhook 503, admin refunds are unavailable, and the hourly trigger fails on the billing
sweep (logged as `scheduled_job_failed`, `job: "billing-sweep"`) after the draft and badge jobs
ran. A local Worker is the same unless you pass test-mode values through `LOCAL_PREVIEW_VARS`
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `LOCAL_STRIPE_MOCK_PORT` for a mocked API),
as the end-to-end suite does. `LOCAL_ORDERS=on` still turns orders on for a local Worker with
the flag off; nothing uses it while the flag is on.

## Tests

`apps/web/src/lib/billing/{service,providers/stripe}.test.ts` (node:sqlite and a fake provider),
`scripts/d1-drizzle-local.test.ts` (the migration), and `apps/web/e2e/billing.spec.ts`
(Playwright on the admin panel suite's Worker and D1, `PLAYWRIGHT_PORT` + 3, started with the
mocked provider's test values (`BILLING_PREVIEW_VARS` in `apps/web/e2e/orders-worker.ts`;
orders and claims are on since #133 and #130), because a ninth preview Worker exhausted the CI
runner's memory; the mocked Stripe API listens on `PLAYWRIGHT_PORT` + 8. The badge program
suite's Worker takes the same values for its hourly trigger's sweep). It covers checkout success,
checks failed, confirming then failed, and cancel; webhook replay; upgrade; refunds with a badge
pass and a miss; the `other` rejection refund; and a paid claim.
