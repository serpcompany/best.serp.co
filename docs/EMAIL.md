# Email

best.serp.co sends transactional email through
[Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) from
`SERP Directory <noreply@mail.serp.co>`, with `Reply-To: support@serp.co`, the footer contact.
The sending subdomain `mail.serp.co` keeps this mail's reputation separate from `serp.co`
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

The event key names one occurrence of an event (`submission-created:<submission id>`,
`review-decision:<decision id>`). Parts are `[a-z0-9._-]`, so an address can never be a key.
Keys appear in logs and stay in D1, so build them from non-secret ids only, and never derive
one from a sign-in or claim code (a hash of a 6-digit code is reversed instantly). Every code
email is a new event, and Better Auth's `sendVerificationOTP` receives only
`{ email, otp, type }`, so key each call with
`emailEventKey('sign-in-code', crypto.randomUUID())` (dedupe then stops only a repeat of that
same call), or with an HMAC under a Worker secret. Idempotency is per template and key, so
one event can send the submitter's receipt and the admin notice. Sending one template
to several recipients for one event needs a recipient id in the key (a user id, never the
address). Each template and key sends at most once:

1. Before sending, the service claims the pair in `email_deliveries` with one atomic upsert.
2. A pair that is `sending` or `sent` is a duplicate: a retried request, a re-run cron, or a
   double submit logs `email_duplicate_suppressed` and sends nothing.
3. A `failed` pair (the provider refused the message) is sent again the next time it is
   enqueued, up to 5 attempts; then it logs `email_attempts_exhausted`. Nothing retries on
   its own, and the ledger holds no recipient or input, so only the caller can retry.
4. If the ledger cannot be reached, nothing is sent. If a send's outcome is never recorded
   (the provider accepted it but D1 failed, or the isolate stopped or `send` hung past the
   `waitUntil` budget after the claim), the row stays `sending` and the email is never resent.

The ledger holds the template id, key, provider, status, attempts, provider message id, the
provider error code, and SQLite-format UTC timestamps; never a recipient, subject, or body.
To find stuck and failed sends (read-only, a maintainer after `wrangler login`; use
`best-serp-co-production --env production` for production, or `--local` locally):

```bash
pnpm exec wrangler d1 execute best-serp-co-staging --remote --env staging \
  --config apps/web/wrangler.jsonc --command "SELECT template_id, event_key, status, attempts,
  last_error_code, updated_at FROM email_deliveries WHERE status = 'failed' OR (status =
  'sending' AND updated_at < datetime('now', '-15 minutes')) ORDER BY updated_at DESC LIMIT 100"
```

Every outcome is one JSON log line with the environment, provider, recipient domain (never
the address), and the template id and event key when they are well-formed (otherwise
`[invalid]`); error messages have addresses redacted. Query them in Workers Logs:

| Level | Events |
|---|---|
| info | `email_sent`, `email_duplicate_suppressed` |
| warn | `email_skipped` (staging allowlist), `email_attempts_exhausted` |
| error | `email_send_failed` (with `errorCode`, e.g. `E_RECIPIENT_SUPPRESSED`), `email_rejected`, `email_render_failed`, `email_ledger_failed`, `email_delivery_failed`, `email_wait_until_failed`, `email_disabled`, `email_context_unavailable` |

## Templates

A template is `defineEmailTemplate<Input>({ id, render(input, context) })` returning
`{ subject, text, html }`; `context` holds `environment`, `links`, and `supportAddress`.

- `html` must come from the `html` tag (a real tagged-template call), which escapes every
  interpolated value. Values go in element content or quoted attributes only: never in a
  tag, an unquoted attribute, a comment, `<style>` or `<script>`, a `style` attribute, or an
  `on*` handler. In a URL attribute (`href`, `src`, `background`, `action`, `formaction`,
  `poster`, `cite`, ...) a value is either the whole URL (an absolute `http(s)` URL, or
  `mailto:` with one plain address and no query) or an `encodeURIComponent`-encoded part after
  a scheme the template's literal text fixes. Anything else throws.
- `links.url('/account/')` returns the absolute, canonical URL on the sending environment's
  origin. It refuses anything but a root-relative path, and any whitespace or control
  character.
- Register each template in `registry.ts` under its id, with a test of its rendered subject,
  bodies, and links in every environment.
- Sign-in and claim code emails put the code in the subject (owner decision), for example
  `482913 is your SERP sign-in code`. Subjects and bodies never reach deployed logs, and the
  event key is per call, so the code is stored nowhere by this module.

## Local development

Apply migrations (`pnpm db:migrate:local`) so `email_deliveries` exists, then run
`pnpm dev`. Each email appears in the Worker output as an `email_logged` line with the
recipient, subject, and text body. Nothing is sent locally, even with an `EMAIL` binding.
Local links always use `http://localhost:8787`; a `pnpm worktree:init` worktree serves on
its own port (`pnpm agent:manifest` → `webUrl`), so swap the port when following one.

## Owner prerequisites

These are dashboard and DNS changes in the SERP account; agents do not make them.

**Before merging the pull request that adds the binding**, do steps 1 and 2 and check that
`wrangler email sending list serp.co` lists `mail.serp.co`. Every merge to `staging` deploys
staging; if Cloudflare refuses a `send_email` binding for a domain that is not onboarded,
Deploy Staging would fail for every later merge.

1. **Workers Paid plan.** Email Sending to arbitrary recipients needs it; without it the
   account can send only to its verified destination addresses. Check Workers & Pages →
   Plans in the SERP account dashboard.
2. **Onboard `mail.serp.co`.** Compute → Email Service → Email Sending → Onboard Domain →
   choose `mail.serp.co` (or `wrangler email sending enable mail.serp.co` after
   `wrangler login`). Cloudflare adds MX and SPF (`v=spf1 include:_spf.mx.cloudflare.net
   ~all`) on `cf-bounce.mail.serp.co` and DKIM on `cf-bounce._domainkey.mail.serp.co`.
   Confirm:

   ```bash
   wrangler email sending list serp.co
   wrangler email sending dns get mail.serp.co
   dig TXT cf-bounce.mail.serp.co +short             # v=spf1 include:_spf.mx.cloudflare.net ~all
   dig TXT cf-bounce._domainkey.mail.serp.co +short  # v=DKIM1; h=sha256; k=rsa; p=...
   dig TXT _dmarc.serp.co +short                     # v=DMARC1; p=reject; rua=...; ruf=...; fo=1;
   ```

   **DMARC:** `serp.co` publishes one record, `v=DMARC1; p=reject; rua=...; ruf=...; fo=1;`.
   `mail.serp.co` has no `_dmarc` record of its own and inherits it, reports included; no
   separate record is needed. If onboarding adds `_dmarc.mail.serp.co` (Cloudflare's default
   is `v=DMARC1; p=reject;`), that record applies to the subdomain instead: still
   `p=reject`, but without serp.co's reports. Email Sending → Settings lists the sending
   records as Locked or Unlocked (both are correct).
3. **`support@serp.co` exists** and receives mail (send it a message): every email names it
   in the footer and replies go to it.
4. **Verify DKIM and DMARC** once staging is deployed: trigger an email to an allowlisted
   inbox (the first template, the sign-in code, is #60's acceptance test), or send a one-off
   check yourself with
   `wrangler email sending send --from noreply@mail.serp.co --from-name "SERP Directory" --to <your inbox> --subject "mail.serp.co check" --text "check"`.
   In Gmail, open the message → Show original. It must show `SPF: PASS`,
   `DKIM: 'PASS' with domain mail.serp.co`, and `DMARC: 'PASS'`; the
   `Authentication-Results` header reads `dkim=pass header.d=mail.serp.co`, `spf=pass`, and
   `dmarc=pass header.from=mail.serp.co`. With `p=reject`, a DKIM failure means the message
   is rejected, so check this before production sends. Email Sending → Logs shows each send.

## Follow-ups

- Once `mail.serp.co` is onboarded, also restrict the staging binding at the platform with
  `"allowed_destination_addresses"` equal to `EMAIL_STAGING_ALLOWLIST` (the docs do not say
  whether those addresses must be verified destinations; verifying one is free), with a test
  that keeps the two lists equal.
- Whether decision emails (approved, rejected) need a caller-side retry after
  `email_attempts_exhausted` or a stuck `sending` row is an owner decision.

Pricing: 3,000 emails a month are included with Workers Paid, then $0.35 per 1,000; new
accounts also start with a daily quota that grows with good sending
([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
