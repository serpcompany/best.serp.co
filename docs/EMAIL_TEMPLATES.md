# Email templates

The emails best.serp.co sends, built to the mockups in serpcompany/best.serp.co#70 (screen
15, revisions 3–5). Sending, environments, and the template contract are in
[Email](./EMAIL.md). Each template lives in `apps/web/lib/email/emails/` and is registered in
`apps/web/lib/email/registry.ts` under the id below.

Template ids are stable: each one is part of every delivery's ledger key and provider
idempotency key, so renaming a template would let an event send again.

## Catalog

| Id | Sent when | To | Button |
|---|---|---|---|
| `sign-in-code` | Better Auth sends a sign-in code (sign-in codes only); code in the subject | the user | none (code) |
| `claim-code` | A claim needs a domain-email code; code in the subject | the work address | none (code) |
| `submission-received` | A free submission's badge is verified and it enters review | submitter | `/account/` |
| `payment-received-in-review` | A paid submission's automatic checks failed; it waits for review | submitter | `/account/` (`/account/submissions/<id>/` after #65) |
| `changes-requested` | A reviewer requests changes (the note is quoted) | submitter | `/account/` (`/account/submissions/<id>/` after #65) |
| `submission-rejected` | A reviewer rejects a submission that may be resubmitted | submitter | `/account/` (`/account/submissions/<id>/` after #65) |
| `submission-rejected-refunded` | A paid submission is rejected and refunded | submitter | `/account/` (`/account/submissions/<id>/` after #65) |
| `submission-rejected-prohibited` | A submission is rejected as prohibited: no resubmission, no refund | submitter | `/contact/` (the account inbox after #73) |
| `listing-approved` | A free listing is approved and live | submitter | `/products/<slug>/` |
| `listing-live-paid` | A paid listing passes the automatic checks and goes live | submitter | `/products/<slug>/` |
| `badge-missing` | The weekly check misses the badge (24h warning) | owner | `/account/listings/<slug>/` |
| `listing-unlisted` | The recheck still misses it; the listing is removed | owner | `/account/listings/<slug>/` |
| `ownership-removed` | A badge claimer's badge is gone; ownership is removed | former owner | `/products/<slug>/` |
| `new-message` | The SERP team replied in a conversation (no message body) | user | `/account/messages/<thread>/` |
| `draft-reminder` | +12h, +48h, +7d, +14d, +21d (`lastReminder`) after a draft | submitter | `/submit/<id>/choose/` or `/submit/<id>/checkout/` |
| `draft-expired` | Day 30: the draft is removed and the URL released | submitter | `/submit/?url=<website>` |
| `admin-review-ready` | A submission or revision is ready for review | admin | `/admin/submissions/<id>/` |
| `admin-new-message` | A submitter sent a message (no message body) | admin | `/admin/inbox/<thread>/` |

- `draft-reminder` has two variants. `choose_plan` shows "Choose a plan". `complete_checkout`
  shows "Complete checkout", for a draft where the paid listing was chosen but not paid. The
  +21d reminder sets `lastReminder`, which changes the subject and adds "This is the last
  reminder".
- `badge-missing` names one of three findings: `nofollow`, `missing`, or `wrong_destination`.
- `admin-review-ready` covers the free plan and both paid states: "(paid, live now)" and
  "(paid, waiting for review)".
- Prices (`priceCents`, `paidCents`, `refundedCents`) and times (`checkedAt`, `recheckAt`,
  `warnedAt`, `badgeVerifiedAt`) are inputs. Times render in UTC
  (`Mon, Oct 5 at 09:14 UTC`).
- Submitter-supplied names in subjects are cut to 80 characters with an ellipsis, and whole
  subjects to 200, so a long name shortens an email instead of stopping it. The admin message
  subject never carries the sender's address: it shows `fromName`, or else their domain.

## Routes the buttons need

Every button opens a page that exists; `apps/web/lib/email/emails/links.test.ts` renders every
sample and fails on a link to a missing page. Until #65 builds `/account/submissions/<id>/`,
submission buttons open `/account/` (`submissionPath`), and until #73 builds the account inbox,
"Message us" opens `/contact/` (`MESSAGE_US_PATH`). The test lists the links still waiting for
their page, all in emails nothing sends yet: `/account/listings/<slug>/` (badge-missing and
unlisted, #65; screen 7 only defines `/account/listings/<slug>/edit`), `/account/messages/...`
and `/admin/inbox/<thread>/` (#73), and the draft reminder's `/submit/<id>/choose/` (#63) and
`/submit/<id>/checkout/` (#68).

## Recipients and footers

- **Admin alerts** go to `EMAIL_ADMIN_RECIPIENT`, which is `email.adminRecipient` in
  `packages/site-config` (`devin@serp.co`, per #59). It is not derived from the admin
  allowlist (#60): that list decides who may sign in to `/admin`, not who gets mail. Adding an
  admin should not silently add a mail recipient. Callers pass it as `to`; no template holds
  an address.
- **Footers** say "This address isn't monitored. Reply from your dashboard: <link>". There
  is no Reply-To.
  - User emails link to `email.dashboardPath` (`/account/`).
  - Admin emails (`audience: 'admin'`) link to `email.adminDashboardPath`, the review queue
    `/admin/submissions/` (#64).
  - When #73 adds the inboxes, switch these to `/account/messages/` and `/admin/inbox/`. The
    TODOs in `site-config` mark this. Until then a footer must not point at a page that
    doesn't exist.
  - `new-message` is sent only once #73 exists. Its footer links to the conversation itself
    (`footerPath`), as the mockup shows.

## Sign-in code wiring

Better Auth (#60) sends sign-in codes through `apps/web/lib/auth/sign-in-code-email.ts`:

```ts
enqueueEmail(SIGN_IN_CODE_TEMPLATE_ID, {
  eventKey: emailEventKey('sign-in-code', crypto.randomUUID()),
  input: { code, expiresInMinutes }, // SignInCodeInput
  to
})
```

- **One definition:** the template id, the code length (6), and the lifetime (600 seconds) live
  in `apps/web/lib/email/sign-in-code.ts`, which imports nothing. `lib/auth/rate-limits.ts`
  configures Better Auth's email OTP plugin with them, and `lib/auth` imports from `lib/email`,
  never the reverse (`boundary.test.ts`). `rate-limits.test.ts` pins the values.
- **Lifetime:** the email states `expiresInMinutes`, which Better Auth's sender derives from the
  lifetime it enforces.
- **Delivery check:** before creating each code, Better Auth calls `emailDeliveryConfigured()`
  (`lib/email/server.ts`, built on `isEmailDeliveryConfigured(env)` in `runtime.ts`). It sends
  nothing and is false whenever `enqueueEmail` would log `email_disabled`. Then the request
  answers 503 `OTP_DELIVERY_UNAVAILABLE` and no code exists.
- **Copyable code:** the sign-in and claim emails show the code as one text node of bare
  digits, spaced only by CSS `letter-spacing`. There's no space, separator, per-digit element or
  zero-width character, so selecting or double-clicking it in Gmail, Apple Mail or Outlook copies
  exactly the code. The text part and the subject carry it unspaced too.
- **Refused input:** the template refuses a code that isn't `SIGN_IN_CODE_LENGTH` digits, or a
  lifetime that isn't 1 to 60 whole minutes. `enqueueEmail` never throws, so a refused code is
  only logged (`email_render_failed`). Better Auth's sender sends `sign-in` codes only; any
  other OTP purpose is refused before it reaches the email module.
- **Staging:** codes for addresses outside `EMAIL_STAGING_ALLOWLIST` are not sent; they are
  logged as `email_skipped` while Better Auth answers 200 as usual. Add testers to the
  allowlist (`env.staging.vars` in `apps/web/wrangler.jsonc`) to receive codes.
- **Evidence:** `lib/auth/sign-in-code-delivery.test.ts` requests a code on staging through
  Better Auth, `enqueueEmail`, the D1 ledger, and the useSend sender with a fake `fetch`, then
  signs in with the emailed code.

## Previews

`pnpm tsx scripts/email-previews.ts <dir> [local|staging|production]` writes every template's
HTML and text with the mockups' sample data (`apps/web/lib/email/emails/samples.ts`), plus an
index. It never sends anything.

## Differences from the mockups (approved)

The owner approved these differences from the #70 mockups, together with Revision 5:

- **Footer links:** the dashboard (`/account/`) and the review queue
  (`/admin/submissions/`) rather than the inboxes, until #73.
- **`admin-review-ready`:** drops the mockup's line about paid subjects. It was a reviewer
  note, and the R5 paid variants leave it out too.
- **`submission-rejected`:** ends with "You can edit the submission and send it again." The
  mockup's sentence was specific to its example.
- **`admin-new-message`:** names the sender or their domain in the subject, not their
  address ("New message from brieflow.ai: …").
- **`draft-expired`:** reads "Your draft for <product> expired 30 days after it was saved, so
  it has been removed." The mockup said "was saved 30 days ago without a plan", which is wrong
  for a `complete_checkout` draft.
- **`payment-received-in-review`:** takes the check problem as input. Only the
  "couldn't load … (the connection timed out)" case is mocked.
