# Email

best.serp.co sends transactional email through [useSend](https://usesend.com) (open source,
backed by Amazon SES), using the hosted instance at `https://app.usesend.com`. This replaces
the "Cloudflare Email Sending" choice in serpcompany/best.serp.co#59 (owner decision). Staging
and production both send from `SERP Directory <noreply@mail.serp.co>`, with **no Reply-To**
(owner decision: the staging useSend key is restricted to `mail.serp.co`). Staging mail is
marked by a `[staging]` subject prefix and goes only to its allowlist. The dedicated sending
subdomain keeps this mail's reputation separate from `serp.co`.

Nothing receives mail for these emails. Receiving at a best.serp.co address would break
serp.co's Gmail MX, and `support@serp.co` is not used. So every footer says the address isn't
monitored and links to the dashboard, for example "This address isn't monitored. Reply from
your dashboard: https://best.serp.co/account/". Two-way conversation moves to an inbox in the
dashboard (serpcompany/best.serp.co#73). The emails themselves (sign-in code, submission
received, changes requested, approved, rejected, badge missing, unlisted, claim verification
code, and the admin review notice) follow the mockups approved in #70.

## Module

`apps/web/src/lib/email/` owns sending. Only `server.ts` touches Next.js; the rest also runs in a
Worker handler outside Next.js.

| File | Owns |
|---|---|
| `server.ts` | `enqueueEmail(templateId, { eventKey, to, input })` for route handlers and actions (`server-only`) |
| `runtime.ts` | `createWorkerEmailService({ env, context, templates })` from Worker bindings; `isEmailDeliveryConfigured(env)` |
| `service.ts` | Validation, environment policy, rendering, the ledger claim, one send, logs; `emailEventKey` |
| `config.ts` | Environment policy, senders, link origins, the staging allowlist, useSend settings |
| `senders.ts` | Providers behind one interface: useSend (API), log (local), capture (tests) |
| `templates.ts` | Template contract: `defineEmailTemplate`, the escaping `html` tag, `css`, absolute links |
| `registry.ts` | The site's 18 emails, built to #70; catalog in [Email templates](./EMAIL_TEMPLATES.md) |

The idempotency ledger lives in `packages/data-ops/src/email-deliveries.ts` (table
`email_deliveries`), like every other SQL statement. The sender and the dashboard paths come
from `packages/site-config` (`email.from`, `email.dashboardPath`, `email.adminDashboardPath`).

## Environments

| | local | staging | production |
|---|---|---|---|
| Delivery | written to the Worker log, never sent | useSend API | useSend API |
| From | (logged as `noreply@mail.serp.co`) | `noreply@mail.serp.co` | `noreply@mail.serp.co` |
| Recipients | anyone (logged only) | only `EMAIL_STAGING_ALLOWLIST` | anyone |
| Subject | as rendered | `[staging] ` + subject | as rendered |
| Link origin | `http://localhost:8787` | `https://best-serp-co-staging.serpcompany.workers.dev` | `https://best.serp.co` |

Configuration, per deployed environment:

- `USESEND_BASE_URL`: a non-secret var in `env.staging.vars` and `env.production.vars` of
  `apps/web/wrangler.jsonc`, set to `https://app.usesend.com`. It is pinned to that origin
  (`USESEND_ORIGINS` in `config.ts`): any other value disables email rather than sending the
  key as a Bearer token to an unknown host.
- `USESEND_API_KEY`: a **Worker secret** (name only in `apps/web/.dev.vars.example`; never
  commit a value). Local development does not need one.
- `EMAIL_STAGING_ALLOWLIST`: a non-secret var in `env.staging.vars`. Comma-separated plain
  addresses, matched case-insensitively. Empty or missing sends to nobody, and a malformed
  entry disables staging email. Change it with a pull request.

Email fails closed. In each of these cases every enqueue sends nothing and logs
`email_disabled`:

- `SITE_ENVIRONMENT` and `D1_RUNTIME_ENV` don't name the same known environment;
- the `DB` binding is missing;
- (staging, production) `USESEND_BASE_URL` is missing or not `https://app.usesend.com`;
- (staging, production) `USESEND_API_KEY` is missing.

So deploying without the secret is safe.

**useSend API.** `POST https://app.usesend.com/api/v1/emails` with `Authorization: Bearer
<key>` and a JSON body: `from`, `to`, `subject`, `text`, `html`, and `headers`
(`Auto-Submitted: auto-generated`). No `replyTo` is sent.
([send email](https://docs.usesend.com/api-reference/emails/send-email),
[authentication](https://docs.usesend.com/api-reference/introduction)).

- **Idempotency.** Each request carries
  `Idempotency-Key: <environment>:<template id>:<event key>`, SHA-256 hashed if over 256
  characters. useSend returns the original `emailId` for a repeated key and body for 24
  hours, so a retry after a lost response never sends twice. This is on top of the ledger.
  - **Why the environment prefix.** useSend's idempotency keys are **team-wide**, and staging
    and production use two keys in one team. Event ids overlap across environments (imported
    listing ids, autoincrement rows), and a staging body never matches production's (From,
    `[staging]` subject, links). Without the prefix, a staging send would make every
    production attempt with the same key fail with 409 `NOT_UNIQUE` for 24 hours.
  - **The ledger needs no prefix.** Each environment has its own D1 database, so its
    `(template_id, event_key)` rows never meet another environment's.
- **Errors.** useSend errors (`{ error: { code, message } }`) are logged as
  `email_send_failed`, with the API key and any `Bearer …` or `us_…` token scrubbed from the
  message, and with this code: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`,
  `NOT_UNIQUE`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`. An unreadable error body is logged
  as `HTTP_<status>`, an unreachable API as `NETWORK_ERROR`, and a request that takes over 10
  seconds as `TIMEOUT`.

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

- **No secrets in keys.** Keys appear in logs, stay in D1, and are sent to useSend. Build them
  from non-secret ids only, and never derive one from a sign-in or claim code (a hash of a
  6-digit code is reversed instantly).
- **Code emails.** Every code email is a new event, and Better Auth's `sendVerificationOTP`
  receives only `{ email, otp, type }`. Key each call with
  `emailEventKey('sign-in-code', crypto.randomUUID())` (dedupe then stops only a repeat of that
  same call), or with an HMAC under a Worker secret.
- **Several emails per event.** Idempotency is per template and key, so one event can send
  the submitter's receipt and the admin notice. Sending one template to several recipients
  for one event needs a recipient id in the key (a user id, never the address).

Each template and key sends at most once:

1. Before sending, the service claims the pair in `email_deliveries` with one atomic upsert.
2. A pair that is `sending` or `sent` is a duplicate: a retried request, a re-run cron, or a
   double submit logs `email_duplicate_suppressed` and sends nothing.
3. A `failed` pair (the provider refused the message, or the request failed) is sent again
   the next time it is enqueued, up to 5 attempts; then it logs `email_attempts_exhausted`.
   Nothing retries on its own, and the ledger holds no recipient or input, so only the caller
   can retry.
4. If the ledger cannot be reached, nothing is sent.
5. If a send's outcome is never recorded, the row stays `sending` and the email is never
   resent. That happens when useSend accepted it but D1 failed, or when the isolate stopped or
   the request hung past the `waitUntil` budget after the claim.

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

Every outcome is one JSON log line with the environment, provider, and recipient domain
(never the address), plus the template id and event key when they are well-formed (otherwise
`[invalid]`). Error messages have addresses redacted, and the API key is never logged. Query
them in Workers Logs:

| Level | Events |
|---|---|
| info | `email_sent`, `email_duplicate_suppressed` |
| warn | `email_skipped` (staging allowlist), `email_attempts_exhausted` |
| error | `email_send_failed` (with `errorCode`, e.g. `RATE_LIMITED`), `email_rejected`, `email_render_failed`, `email_ledger_failed`, `email_delivery_failed`, `email_wait_until_failed`, `email_disabled`, `email_context_unavailable` |

## Templates

A template is `defineEmailTemplate<Input>({ id, audience?, footerPath?, render })` returning
`{ subject, text, html }`. `context` holds `environment`, `links`, `recipient`, and
`dashboardUrl`: the template's own `footerPath`, or else the absolute `/account/` URL
(`/admin/submissions/` for `audience: 'admin'`). Every registered email and its inputs are
listed in [Email templates](./EMAIL_TEMPLATES.md); they share the layout in
`apps/web/src/lib/email/emails/layout.ts`.

- **Footer.** Every email says the address isn't monitored and links to `dashboardUrl`;
  `renderEmail` refuses a template whose text or HTML body lacks that link.
- **`html` tag.** HTML must come from the `html` tag (a real tagged-template call), which
  escapes every interpolated value. Values go in element content or quoted attributes only.
  They are refused in a tag, an unquoted attribute, a comment, `<style>` or `<script>`, an
  `on*` handler, `<svg>` or `<math>`, and `<meta>`, `<base>`, `<link>`, `<object>`, or
  `<embed>`.
- **Links.** In a URL attribute (`href`, `src`, `background`, `action`, `formaction`,
  `poster`, `cite`, ...) a value is one of three things:
  - the whole URL: an absolute `http(s)` URL, or `mailto:` with one plain address and no query;
  - the address after a literal `mailto:`;
  - an `encodeURIComponent`-encoded part after a literal `http:`, `https:`, or `mailto:`.

  A literal `javascript:` or `data:` never takes a value. Each `srcset` candidate is a whole
  `http(s)` URL: `srcset="${a} 1x, ${b} 2x"`.
- **Inline styles.** A `style` value must be `css({ color: tokens.ink, padding: '12px 24px' })`
  output, at the start or after a literal `;`. `css` allows common email properties and value
  shapes: hex colours, lengths, numbers, keywords, and quoted font stacks. Anything with
  `url()`, `expression()`, parentheses, or a second declaration is refused; literal style
  text in the template is fine.
- **Buttons.** Outlook conditional comments (VML buttons) are not supported, because values
  are refused in comments. Use a bulletproof table button: a `<table role="presentation">`
  cell with `bgcolor` and padding, holding an `<a>` styled with
  `css({ display: 'inline-block', padding: ..., color: ... })`. It renders in Outlook without
  VML, apart from rounded corners.
- `links.url('/account/')` returns the absolute, canonical URL on the sending environment's
  origin. It refuses anything but a root-relative path, and any whitespace or control
  character.
- Register each template in `registry.ts` under its id, with a test of its rendered subject,
  bodies, and links in every environment.
- Sign-in and claim code emails put the code in the subject (owner decision), for example
  `482913 is your SERP sign-in code`. This module never logs or stores a subject, body, or
  code (keys are per call), but others can keep them:
  - Hosted useSend stores every sent email (recipients, subject, text, and HTML) for its
    dashboard. Codes, addresses, and reviewer notes are therefore held by useSend, under its
    retention.
  - serp.co's DMARC record has `ruf=mailto:abuse@serp.co; fo=1`, so a receiver that sends
    forensic reports may include a failing message's headers, subject (and code) included.

## Local development

Apply migrations (`pnpm db:migrate:local`) so `email_deliveries` exists, then run
`pnpm dev`. Each email appears in the Worker output as an `email_logged` line with the
sender, recipient, subject, and text body. Nothing is sent locally, even with a useSend key.
The local Worker also keeps the last 30 minutes of messages in memory for end-to-end tests:
`GET /api/dev/email-outbox?to=<address>` returns their subjects and text, and answers 404
anywhere but a local Worker reached on a local host.
Local links always use `http://localhost:8787`; a `pnpm worktree:init` worktree serves on
its own port (`pnpm agent:manifest` → `webUrl`), so swap the port when following one.

## Owner prerequisites

These are useSend dashboard and Cloudflare secret changes; agents do not make them. Merging
before they are done is safe: email is then disabled and logged.

1. **Done (2026-10-06): `USESEND_API_KEY`.** One API key per environment, created in
   app.usesend.com → Developer settings → API keys and set as a Worker secret on
   `best-serp-co-staging` and `best-serp-co-production`
   (`wrangler secret put USESEND_API_KEY --env staging` and `--env production`, from
   `apps/web`). Rotate a key the same way.
   - **Restrict each key to `mail.serp.co`**, the only sending domain, in useSend (API keys can
     be limited to one domain). The staging key is. Because staging and production share the
     domain, what keeps a staging Worker from emailing real people is `EMAIL_STAGING_ALLOWLIST`;
     the `[staging]` prefix and environment-scoped idempotency keys keep its mail apart.
2. **Done: `USESEND_BASE_URL`.** The owner chose the hosted instance; `apps/web/wrangler.jsonc`
   sets it to `https://app.usesend.com` for both environments.
3. **Confirm the sending domain is verified** in app.usesend.com → Domains: `mail.serp.co`,
   with DKIM at `usesend._domainkey.mail.serp.co` and SES MAIL FROM `mail.mail.serp.co`.
4. **Verify DKIM and DMARC** once staging is deployed and the first template (#60's sign-in
   code) sends to an allowlisted inbox. In Gmail, open the message → Show original. It must
   show `SPF: PASS`, `DKIM: 'PASS'` with domain `mail.serp.co`, and `DMARC: 'PASS'`. Both
   environments send from that domain, so this also checks production's signing.

**DMARC.** `serp.co` publishes one record, `v=DMARC1; p=reject; rua=...; ruf=...; fo=1;`, with
no `sp=`. `mail.serp.co` has no `_dmarc` record of its own, so it inherits `p=reject` with the
reports, and no separate record is needed. useSend signs with DKIM `d=mail.serp.co` in both
environments, which aligns with the From domain.
The SES MAIL FROM `mail.mail.serp.co` aligns SPF under relaxed alignment. Under `p=reject`, a
message that fails both is rejected, so check step 4 before production sends.

```bash
dig TXT _dmarc.serp.co +short                      # v=DMARC1; p=reject; rua=...; ruf=...; fo=1;
dig TXT usesend._domainkey.mail.serp.co +short     # the DKIM key useSend shows
```

## Follow-ups

- Whether decision emails (approved, rejected) need a caller-side retry after
  `email_attempts_exhausted` or a stuck `sending` row is an owner decision.
