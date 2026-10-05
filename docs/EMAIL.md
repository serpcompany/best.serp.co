# Email

best.serp.co sends transactional email through
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) from
`SERP Directory <noreply@mail.serp.co>`. The footer contact is `support@serp.co`. The sending
subdomain `mail.serp.co` keeps this mail's reputation separate from `serp.co`
(serpcompany/best.serp.co#59). The emails themselves (sign-in code, submission received,
changes requested, approved, rejected, badge missing, unlisted, claim verification code, and
the admin review notice) follow the mockups approved in #70.

## Module

`apps/web/lib/email/` owns sending. Only `server.ts` touches Next.js; the rest also runs in a
Worker handler outside Next.js.

| File | Owns |
|---|---|
| `server.ts` | `enqueueEmail(templateId, { eventKey, to, input })` for route handlers and actions (`server-only`) |
| `runtime.ts` | `createWorkerEmailService({ env, context, templates })` from Worker bindings |
| `service.ts` | Validation, environment policy, rendering, the ledger claim, one send, logs; `emailEventKey` |
| `config.ts` | Environment policy, link origins, the staging allowlist; sender and support address from `packages/site-config` |
| `senders.ts` | Providers: Cloudflare (`EMAIL` binding), log (local), capture (tests) |
| `templates.ts` | Template contract: `defineEmailTemplate`, the escaping `html` tag, absolute links |
| `registry.ts` | The site's templates, empty until #70 is approved |

The idempotency ledger lives in `packages/data-ops/src/email-deliveries.ts` (table
`email_deliveries`), like every other SQL statement.

## Environments

| | local | staging | production |
|---|---|---|---|
| Delivery | written to the Worker log, never sent | `EMAIL` binding | `EMAIL` binding |
| Recipients | anyone (logged only) | only `EMAIL_STAGING_ALLOWLIST` | anyone |
| Subject | as rendered | `[staging] ` + subject | as rendered |
| Link origin | `http://localhost:8787` | `https://best-serp-co-staging.serpcompany.workers.dev` | `https://best.serp.co` |

`apps/web/wrangler.jsonc` declares the binding in `env.staging` and `env.production` only:

```jsonc
"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["noreply@mail.serp.co"] }]
```

`EMAIL_STAGING_ALLOWLIST` is a non-secret var in `env.staging.vars`: comma-separated plain
addresses, matched case-insensitively. Empty or missing sends to nobody; a malformed entry
disables staging email. Change it with a pull request.

Email fails closed. Unless `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` name the same known
environment, the `DB` binding exists, and (staging, production) the `EMAIL` binding exists,
every enqueue sends nothing and logs `email_disabled`.

## Sending

```ts
import { emailEventKey, enqueueEmail } from '@/lib/email/server'

await enqueueEmail('<template id>', {
  eventKey: emailEventKey('<event name>', occurrenceId),
  input: templateInput,
  to: recipientAddress
})
```

`enqueueEmail` schedules delivery with the request's `ctx.waitUntil` and returns; it never
throws and never fails the request. A cron or other Worker handler calls
`createWorkerEmailService` with its own `env` and `ExecutionContext`.

The event key names one occurrence of an event (`submission-received:<submission id>`,
`review-decision:<decision id>`). Parts are `[a-z0-9._-]`, so an address can never be a key;
hash anything secret (a sign-in code) first. One key sends at most once:

1. Before sending, the service claims the key in `email_deliveries` with one atomic upsert.
2. A key that is `sending` or `sent` is a duplicate: a retried request, a re-run cron, or a
   double submit logs `email_duplicate_suppressed` and sends nothing.
3. A `failed` key (the provider refused the message) is sent again the next time the same key
   is enqueued, up to 5 attempts. Nothing retries on its own.
4. If the ledger cannot be reached, nothing is sent. If a sent email's outcome cannot be
   recorded, the row stays `sending` and the email is never resent.

The ledger holds the key, template id, provider, status, attempts, provider message id, and
the provider error code; never a recipient, subject, or body.

Every outcome is one JSON log line with the event key, template id, environment, provider,
and recipient domain (never the address): `email_sent`, `email_send_failed` (with
`errorCode`, for example `E_RECIPIENT_SUPPRESSED`), `email_duplicate_suppressed`,
`email_skipped` (staging allowlist), `email_rejected`, `email_render_failed`,
`email_ledger_failed`, `email_disabled`. Query them in Workers Logs for the environment.

## Templates

A template is `defineEmailTemplate<Input>({ id, render(input, context) })` returning
`{ subject, text, html }`; `context` holds `environment`, `links`, and `supportAddress`.
`html` must come from the `html` tag, which escapes every interpolated value.
`links.url('/account/')` returns the absolute, canonical URL on the sending environment's
origin and refuses anything but a root-relative path. Register each template in
`registry.ts` under its id, with a test of its rendered subject, bodies, and links in every
environment.

## Local development

Apply migrations (`pnpm db:migrate:local`) so `email_deliveries` exists, then run
`pnpm dev`. Each email appears in the Worker output as an `email_logged` line with the
recipient, subject, and text body. Nothing is sent locally, even with an `EMAIL` binding.

## Owner prerequisites

These are dashboard and DNS changes in the SERP account; agents do not make them.
Do steps 1-3 before merging the pull request that adds the binding: Cloudflare may refuse
to deploy a Worker whose `send_email` binding names a sender domain that is not onboarded.

1. **Workers Paid plan.** Email Sending to arbitrary recipients needs it; without it the
   account can send only to its verified destination addresses. Check Workers & Pages →
   Plans in the SERP account dashboard.
2. **Onboard `mail.serp.co`.** Compute → Email Service → Email Sending → Onboard Domain →
   choose `mail.serp.co` (or `wrangler email sending enable mail.serp.co` after
   `wrangler login`). Cloudflare adds to the `serp.co` zone: MX and SPF
   (`v=spf1 include:_spf.mx.cloudflare.net ~all`) on `cf-bounce.mail.serp.co`, DKIM on
   `cf-bounce._domainkey.mail.serp.co`, and DMARC on `_dmarc.mail.serp.co`. Review the DMARC
   policy it proposes (`p=none` to monitor first, or `p=reject`) and whether to add a `rua`
   report address. Then confirm:

   ```bash
   wrangler email sending list serp.co
   wrangler email sending dns get mail.serp.co
   dig TXT cf-bounce.mail.serp.co +short             # v=spf1 include:_spf.mx.cloudflare.net ~all
   dig TXT cf-bounce._domainkey.mail.serp.co +short  # v=DKIM1; h=sha256; k=rsa; p=...
   dig TXT _dmarc.mail.serp.co +short                # v=DMARC1; p=...
   ```

   Email Sending → Settings lists the same records as Locked or Unlocked (both are correct).
3. **`support@serp.co` exists** and receives mail (send it a message).
4. **Verify DKIM and DMARC** once staging is deployed: trigger an email to an allowlisted
   inbox (the first template, the sign-in code, is #60's acceptance test), or send a one-off
   check yourself with
   `wrangler email sending send --from noreply@mail.serp.co --from-name "SERP Directory" --to <your inbox> --subject "mail.serp.co check" --text "check"`.
   In Gmail, open the message → Show original. It must show `SPF: PASS`,
   `DKIM: 'PASS' with domain mail.serp.co`, and `DMARC: 'PASS'`; the
   `Authentication-Results` header reads `dkim=pass header.d=mail.serp.co`, `spf=pass`, and
   `dmarc=pass header.from=mail.serp.co`. Email Sending → Logs shows each send's status.

Pricing: 3,000 emails a month are included with Workers Paid, then $0.35 per 1,000; new
accounts also start with a daily quota that grows with good sending
([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
