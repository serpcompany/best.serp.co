# Email templates

The emails best.serp.co sends, built to the mockups the owner approved in
serpcompany/best.serp.co#70 (screen 15). Sending, environments, and the template contract are
in [Email](./EMAIL.md). Each template lives in `apps/web/lib/email/emails/` and is registered
in `apps/web/lib/email/registry.ts` under the id below.

Template ids are stable: each one is part of every delivery's ledger key and provider
idempotency key, so renaming a template would let an event send again.

## Catalog

| Id | Sent when | To | Button |
|---|---|---|---|
| `sign-in-code` | Better Auth sends a sign-in code; the code is in the subject | the user | none (code) |
| `claim-code` | A claim needs a domain-email code; the code is in the subject | the work address | none (code) |
| `submission-received` | A free submission's badge is verified and it enters review | submitter | `/account/` |
| `changes-requested` | A reviewer requests changes (the note is quoted) | submitter | `/account/submissions/<id>/` |
| `submission-rejected` | A reviewer rejects a submission that may be resubmitted | submitter | `/account/submissions/<id>/` |
| `submission-rejected-refunded` | A paid submission is rejected and refunded | submitter | `/account/submissions/<id>/` |
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

`draft-reminder` has two variants: `choose_plan` ("Choose a plan") and `complete_checkout`
("Complete checkout", the paid listing chosen but not paid). The +21d reminder sets
`lastReminder`, which changes the subject and adds "This is the last reminder".

Prices (`priceCents`, `paidCents`, `refundedCents`) and times (`checkedAt`, `recheckAt`,
`warnedAt`, `badgeVerifiedAt`) are inputs. Times render in UTC (`Mon, Oct 5 at 09:14 UTC`).

## Recipients and footers

- **Admin alerts** go to `EMAIL_ADMIN_RECIPIENT`, which is `email.adminRecipient` in
  `packages/site-config` (`devin@serp.co`, per #59). It is not derived from the admin
  allowlist (#60): that list decides who may sign in to `/admin`, not who gets mail. Adding an
  admin should not silently add a mail recipient. Callers pass it as `to`; no template holds
  an address.
- **Footers** say "This address isn't monitored. Reply from your dashboard: <link>". There
  is no Reply-To. User emails link to `email.dashboardPath` (`/account/`) and admin emails
  (`audience: 'admin'`) to `email.adminDashboardPath` (`/admin/`). When #73 adds the inboxes,
  switch them to `/account/messages/` and `/admin/inbox/`; the TODOs in `site-config` mark
  this. Until then the footer must not point at a page that doesn't exist yet.

## Sign-in code wiring (#72)

Better Auth's `sendVerificationOTP` receives only `{ email, otp, type }`, so the OTP sender
enqueues:

```ts
await enqueueEmail(SIGN_IN_CODE_TEMPLATE /* 'sign-in-code' */, {
  eventKey: emailEventKey('sign-in-code', crypto.randomUUID()),
  input: { code: otp, expiresInMinutes: 10 }, // the configured OTP lifetime
  to: email
})
```

The template accepts exactly six digits and refuses anything else (logged as
`email_render_failed`).

## Previews

`pnpm tsx scripts/email-previews.ts <dir> [local|staging|production]` writes every template's
HTML and text with the mockups' sample data (`apps/web/lib/email/emails/samples.ts`), plus an
index. It never sends anything.

## Not covered by the mockups

These cases have no approved mockup. They use the closest approved wording; changing them
needs approval in #70.

- `submission-rejected` ends with "You can edit the submission and send it again." (the
  mockup's sentence was specific to its example). Prohibited rejections, which can't be
  resubmitted, have no mockup and must not use this template.
- `badge-missing` names three findings: `nofollow` (mocked), `missing` ("We couldn't find
  the badge on the page."), and `wrong_destination` ("The badge is there, but its link
  doesn't point to your listing.").
- `admin-review-ready` for paid submissions uses "(paid, live now)" (named in the mockup
  notes) and "(paid, waiting for review)", with Plan rows "Paid. Live now" and "Paid. Waiting
  for review".
- The last `complete_checkout` reminder joins the last-reminder sentence and the checkout
  paragraph.
- `submission-received` covers the free (badge) path only. A paid submission that waits for
  review has no mocked "received" email.
