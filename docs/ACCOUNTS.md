# Accounts and admin access

Decisions: serpcompany/best.serp.co#59. Implementation: #60, with the sign-in screens,
`/account`, and the header's signed-in state built to the mockups approved in #70. Sign-in code
email is #61.

## Shape

- **Better Auth 1.7.7** for everyone, on the `DB` binding through its Drizzle adapter. Sign-in
  is a **6-digit email code** (email OTP plugin); a first sign-in creates the account. Only
  four endpoints are served (below); every other Better Auth route (passwords, social sign-in,
  account linking, profile updates, deletion, and anything an upgrade adds) answers 404 before
  Better Auth sees it, and `config.test.ts` walks Better Auth's router to prove it.
- **Admins** are signed-in users whose verified email is on the D1 `admin_allowlist`
  (seeded with `devin@serp.co` by migration `0002_better_auth`). Each new session sets
  `users.role` (`user` | `admin`) from the allowlist, and every admin request checks the
  allowlist again, so removing an email revokes access on the next request. Admins add and
  remove each other on `/admin/admins/` (#64); the last admin cannot be removed.
- **`/admin` and `/api/admin`** need Cloudflare Access (production) **and** an admin session.

| Piece | Where |
|---|---|
| Schema, adapter, allowlist, role sync, rate limiter | `apps/web/src/db/{schema,auth}.ts` |
| Better Auth configuration | `apps/web/src/lib/auth/config.ts` |
| Settings per environment (vars, secret) | `apps/web/src/lib/auth/settings.ts` |
| Code delivery (`OtpSender`) | `apps/web/src/lib/auth/{otp-sender,sign-in-code-email}.ts` |
| Limits, code binding, known devices | `apps/web/src/lib/auth/{rate-limits,code-binding,known-device}.ts` |
| `requireUser()` / `requireAdmin()` | `apps/web/src/lib/auth/{guards,server}.ts` |
| Worker gate: Access JWT and session cookie | `apps/web/src/lib/auth/{admin-gate,cloudflare-access}.ts` |
| Endpoints | `apps/web/src/app/api/auth/[...all]/route.ts` (`/api/auth/*`) |
| `/login`, `/account`, header sign-out | `apps/web/src/app/(site)/login/page.tsx`, `apps/web/src/app/(dashboard)/account/page.tsx`, `apps/web/src/components/{auth,account}/` |

## Sign-in over HTTP

1. `POST /api/auth/email-otp/send-verification-otp` `{"email","type":"sign-in"}` answers
   `{"success":true}` and sets the code-binding cookie (below).
2. `POST /api/auth/sign-in/email-otp` `{"email","otp"}`, from the same browser, sets the
   session cookie (`better-auth.session_token`; `__Secure-` on https).
3. `GET /api/auth/get-session`, `POST /api/auth/sign-out`.

Requests that carry cookies must send an `Origin` in the trusted origins. A first sign-in may
set a `name` (at most 80 characters) but never an `image`. A code must be entered in the
browser that requested it.

**Limits** (D1, `apps/web/src/lib/auth/rate-limits.ts`; never isolate memory). A client is its
`cf-connecting-ip` address: an IPv4 address, or an IPv6 address's /64, so one host cannot
rotate through its allocation. `cf-connecting-ipv6` counts only when `cf-connecting-ip` is a
Class E (240.0.0.0/4) Pseudo IPv4 address, the one case where Cloudflare overwrote the header
and set it; anywhere else the client could have sent it. Which limits apply depends on the email:

| Email | Code requests allowed |
|---|---|
| New (no verified account) | 1 a minute and 5 an hour per email; 300 an hour site-wide |
| Member (verified account), browser without its known-device cookie | 1 a minute and 5 an hour per email and client; 20 an hour per email |
| Member with its known-device cookie | 1 a minute and 5 an hour per email and client; 10 an hour per email, apart from the 20 |
| Every request | 5 a minute and 20 an hour per client |

Only the per-client limits answer 429 with `Retry-After`; they are the same for every email. A
per-email or site-wide limit answers exactly like a sent code (200, the same body, a binding
cookie) and sends nothing, so no answer reveals whether an email has an account. Code guesses:
10 a minute and 60 an hour per client (429), plus 3 per code. A code expires after ten
minutes and is stored hashed.

**Code-binding cookie** (`code-binding.ts`). Every code request sets `bsc_code_binding`
(`__Secure-` on https): HttpOnly, SameSite=Strict, `Path=/api/auth`, 15 minutes (the code's ten
plus five, so a late guess still hears "expired"). Its HMAC, under a key derived from
`BETTER_AUTH_SECRET`, covers the email and the stored hash of the code that request created,
the per-send nonce. A guess is refused before Better Auth counts it, with the same 400
`INVALID_OTP` as a wrong code, unless the request holds a binding for the email's latest code.
A request that sends nothing renews a binding the browser already holds for the current code,
else sets a decoy, so the code a browser has keeps working. A sign-in clears the cookie.

**Known-device cookie** (`known-device.ts`). A successful sign-in sets `bsc_known_device`
(`__Secure-` on https): HttpOnly, SameSite=Strict, `Path=/api/auth`, 180 days. It carries the
user id and its issue and expiry times, HMAC-signed with a key derived from
`BETTER_AUTH_SECRET`. It grants no session; it only selects the known-device limits, and only
for the account whose id it carries. Every same-named cookie is checked (a sibling `*.serp.co`
site can plant one that the browser sends first), and any that verifies counts.

**What this guarantees.**
- **Guesses.** Only the browser that requested an email's latest code can guess it, so no
  number of guesses from other clients can use up its three attempts. A client can burn only
  a code it requested itself, and only while that code is the latest.
- **Members with a known-device cookie.** On a browser that has signed in to the account
  before, code requests are never refused because of other clients' requests: only that
  browser's client limits and the known-device ceiling (10 an hour) apply, which no request
  without the cookie can spend. Other clients can still request codes for the email (each goes
  to the member's inbox and replaces the previous code), at most 20 an hour; the member's
  browser then asks for a new one. A stolen cookie gets at most those 10 codes an hour.
- **Members without the cookie** (a new browser or a cleared cookie). The limits keep their
  inbox to 20 codes an hour. An attacker with four or more clients can use up those 20 and
  delay a new browser's code by up to an hour; the member's known-device browsers are
  unaffected.
- **New emails.** Anyone can delay sign-up for a specific address by up to an hour (5 an hour
  per email). Flooding past 300 codes an hour for new addresses pauses new sign-ups for up to
  an hour. That ceiling bounds the mail (cost and sender reputation) and never applies to
  existing accounts. Neither limit tells the requester that it applied.
- **Timing (accepted).** A request a per-email limit denies skips Better Auth's code insert
  and user lookup, so it can answer measurably faster than a sent one, and two requests from
  two clients might still tell a member from a new email by latency. This is accepted: every
  probe spends the email's own budget (1 a minute, 5 an hour for a new email), which rations
  the probes, and the answer itself never differs.

Rate-limit rows hold HMAC-SHA256 digests under a key derived from `BETTER_AUTH_SECRET`
(`HMAC(secret, "best.serp.co/auth-rate-limit/v1")`, `keys.ts`), never an email or address.
`sessions` stores Better Auth's raw `ip_address` and `user_agent` per session.

**Delivery.** Locally, the dev sender logs each code and `GET /api/auth/dev/otp-outbox?email=`
returns the latest one and when it was sent (the endpoint exists only when the dev sender
runs, which is refused outside `local`, and the Worker answers it only on a local host). Staging and production send the code as the
`sign-in-code` email through `enqueueEmail` ([Email](./EMAIL.md)), keyed
`emailEventKey('sign-in-code', crypto.randomUUID())`: every code is a new event, and no key
derives from a code. Only `sign-in` codes are sent. The code's length and lifetime are
defined once, in `apps/web/src/lib/email/sign-in-code.ts`; `rate-limits.ts` configures Better Auth
with them, and the email states the lifetime it is given. The `enqueueEmail` call is typed
against the registered template, so the build fails if its input changes shape. A code
request answers 503 `OTP_DELIVERY_UNAVAILABLE`, and no code is created or logged, when no
template is registered or when this Worker cannot deliver email. The second is checked on every
request, before any limit is counted (`emailDeliveryConfigured`: matching environment vars, the
`DB` binding, a valid `USESEND_BASE_URL` and `USESEND_API_KEY`). So a rotated or missing key
stops sign-in visibly instead of issuing codes that never arrive.

**Copied codes.** The email shows the code as one unbroken run of digits, so copying it yields
`482913`. The `/login` field reads pasted, inserted, and autofilled text with `readCodeText`
(`components/auth/sign-in-api.ts`):
- **One standalone code:** six digits, optionally split 3+3 by one space, NBSP or dash ("Code:
  719208", `482 913`). No digit may touch it, directly or across one such separator, so part of
  a phone number ("Call 555 123 4567") doesn't count. It replaces the slots and is sent at once.
- **A fragment of digits and separators** (` 482 `): its digits go in at the caret.
- **Anything ambiguous** (two different codes, seven digits, digits in another shape): nothing
  changes and nothing is sent, so stray digits can never spend one of the three attempts. This
  includes an autofilled value of more than six plain digits.

The sign-in hook in `config.ts` keeps only the digits of `otp` (`signInCodeDigits`) before Better
Auth checks it. A formatted wrong code still counts as a guess.

Every code adds an `email_deliveries` row, so each send also deletes up to 20 `sign-in-code`
rows older than 24 hours (the provider's idempotency window), oldest first, with one prepared
statement (`pruneEmailDeliveries`), until #66 adds a scheduled job. Like the email, the prune
runs after the response (`waitUntil`), so it never delays a code request or widens the timing
gap above.

On staging, a code for an address outside `EMAIL_STAGING_ALLOWLIST` is skipped
(`email_skipped`) while the request answers 200 like any other, so testers must be on the
allowlist to receive codes. `sign-in-code-delivery.test.ts` runs a staging code request
through Better Auth, the email module, and the D1 ledger with a fake `fetch`.

## Screens

`showAuth` is on (`apps/web/src/lib/site/site.ts`). Signed out, the header offers "Sign up /
Sign in"; signed in, the account menu (`layout/account-menu.tsx`) with Account and Sign out on
desktop, or the mobile menu's Account and Sign out. Sign-out posts to `/api/auth/sign-out` and reloads. The header reads a session only when
the request carries a session cookie, so anonymous pages never load Better Auth or read D1.

- **`/login`** (`components/auth/login-card.tsx`, shadcn login-01): email, then the code
  (InputOTP), then "You're signed in" and a redirect to `?callbackUrl=` (a path on this site,
  else `/account/`; `lib/auth/callback-url.ts`, which checks the path after normalization). The code step says a code is on its way *if*
  the address is valid, because a per-email limit answers like a sent code. It counts wrong
  guesses locally (only this browser can guess its code). After a resend that a per-email limit
  may have dropped, it shows no count and lets the server's `TOO_MANY_ATTEMPTS` end the code. A
  full code is sent as soon as it is typed, pasted, or autofilled, but never the one just
  rejected. It shows the expired, too-many-codes, per-client 429 (with
  `Retry-After`), and 503 `OTP_DELIVERY_UNAVAILABLE` (email delivery not configured) states. Its
  code length, lifetime, and attempts come from `lib/email/sign-in-code.ts`, like Better Auth's.
- **`/account`** (`components/account/account-shell.tsx`, shadcn dashboard-01): the sidebar
  shell without the public header and footer, the user's email and sign-out, and the
  submitter dashboard ([Submitter dashboard](./ACCOUNT_DASHBOARD.md), #65). Signed out, it
  redirects to `/login?callbackUrl=/account/`. Messages (#73) and Settings show a "Soon" badge
  and do not link. The shell is composed from the shared dashboard pieces in
  `apps/web/src/components/dashboard/` (`AppShell`, `SidebarBrand`, `NavMain`, `NavSecondary`,
  `NavUser`, `SiteHeader`, `DashboardPageHeader`), which the admin panel (#64, shadcn
  sidebar-07) reuses with `collapsible="icon"` and `rail`. `NavMain` marks the current page
  from the path; the collapsed off-canvas sidebar is `inert`; and the mobile Sheet returns
  focus to the sidebar trigger when it closes (a local addition to the stock Sidebar in `components/ui/sidebar.tsx`).

Both pages are noindex and bypass the edge cache. `apps/web/e2e/login.spec.ts` covers them
in a browser.

## Admin gate

The Worker entry (`lib/worker/handle-request.ts`) checks every `/admin` and `/api/admin`
path (any case, decoded) before the edge cache and Next.js:

| Condition | Answer |
|---|---|
| Production, `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` unset or malformed | 503 `Access not configured` |
| Access required, `Cf-Access-Jwt-Assertion` missing or invalid (RS256, issuer, AUD, expiry) | 403 |
| No Better Auth session cookie | 401 |

Requests that pass reach pages and handlers, which call `requireAdmin()` (Next.js
`unauthorized()` 401 / `forbidden()` 403, with `experimental.authInterrupts`) or
`authorizeAdminRequest()` (JSON; a state-changing method also needs an `Origin` among the
trusted origins, since every `*.serp.co` site is same-site). `/admin/` redirects admins to
the review queue ([Admin panel](./ADMIN_PANEL.md)). Unknown admin paths are caught by `app/admin/[...path]`
and `app/api/admin/[[...path]]`. `scripts/architecture-guard.test.ts` fails any admin page or
route that does not call the guard, and any Server Action anywhere in `apps/web`
(actions are reachable by id from any path, so no path gate sees them; #64 decided that admin
writes are `/api/admin` route handlers). Access is required in
production (and whenever `SITE_ENVIRONMENT` is not exactly `local` or `staging`); locally and
on staging only with `CF_ACCESS_REQUIRED=on`.

Coverage: `apps/web/e2e/access-lock.spec.ts` runs the built Worker twice more with
`CF_ACCESS_REQUIRED=on` (`LOCAL_PREVIEW_VARS`): without the team domain and AUD tag every admin
path answers 503, and with test values it answers 403 to a missing or malformed JWT, both even
for the signed-in owner; an RS256 token with a `kid` makes the Worker fetch the test team's
JWKS and still answers 403. After each deploy, `scripts/d1-preview-http-gates.ts` requires the
admin paths to answer exactly what `wrangler.jsonc` implies: production 403 now that its
Access values are set (503 fails the deploy), staging 401, or 403/503 if `CF_ACCESS_REQUIRED=on`.
The same gates require `GET /api/auth/get-session` to answer 200 without a redirect, and a
sign-in `POST` with an empty email, from the environment's trusted origin, to answer exactly 400
`INVALID_EMAIL`: the send hook returns before its rate limits for an empty email, so repeated
deploys get the same answer and no code is sent.

The edge HTML cache bypasses `/api`, `/admin`, `/account`, `/login`, and every request that
carries a `better-auth.*` cookie, so pages under auth are never served from or stored in it.

## Configuration

| Name | Kind | local | staging | production |
|---|---|---|---|---|
| `BETTER_AUTH_SECRET` | secret (≥ 32 chars) | `apps/web/.dev.vars`, else ephemeral | Worker secret | Worker secret |
| `BETTER_AUTH_URL` | var | unset (localhost origin) | staging workers.dev origin | `https://best.serp.co` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | var | unset (localhost) | same origin | same origin |
| `CF_ACCESS_TEAM_DOMAIN` | var (public) | unset | empty | `serpcompany.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | var (public) | unset | empty | `a30cbc5f…8b2491` (the `best` app's AUD tag) |
| `CF_ACCESS_REQUIRED` | var (`on`/`off`) | unset (off) | `off` | ignored (always on) |

Staging and production fail closed: a missing or short secret, or a base URL that is not an
https origin, makes `/api/auth/*` answer 503 and grants no session.

### Cloudflare Access application

The production application exists (created by the owner on 2026-10-06): a self-hosted app
named `best` with the destinations `best.serp.co/admin`, `best.serp.co/admin/*`,
`best.serp.co/api/admin`, and `best.serp.co/api/admin/*`, and the policy "Allow Farley and
Devin". Access alone is not enough: someone the policy admits who is not on the D1 allowlist
(Farley today) still gets 403 from `requireAdmin()`.

The team domain (`serpcompany.cloudflareaccess.com`) and the application's AUD tag are public
identifiers, not secrets: Cloudflare sends both in every Access login redirect. They belong in
`env.production.vars` (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) in `apps/web/wrangler.jsonc`,
added by a reviewed pull request; until they are there, production admin routes answer 503.
The Worker accepts only RS256 tokens issued by `https://serpcompany.cloudflareaccess.com`,
signed with a key from `https://serpcompany.cloudflareaccess.com/cdn-cgi/access/certs`, and
carrying that AUD tag.

Staging has no Access application and keeps `CF_ACCESS_REQUIRED=off`. To add one later,
create a second self-hosted app on the staging hostname with the same paths, then set its two
values and `CF_ACCESS_REQUIRED=on` in `env.staging.vars`. A path Access does not cover still
fails closed: the Worker answers 403 without a valid Access JWT.

## Runtime notes (#60)

- Better Auth 1.7.7 declares `next ^16` and `drizzle-orm ^0.45.2`; it runs in the OpenNext
  1.20.6 Worker with `nodejs_compat` (its `AsyncLocalStorage` comes from `node:async_hooks`).
- `better-auth/minimal` keeps Kysely out of the bundle. The Drizzle adapter uses the
  `sqlite` provider without transactions (D1 has no interactive transactions); single-use
  codes are consumed with one `DELETE … RETURNING`.
- Better Auth's built-in rate limiter is off (its default store is per-isolate memory), and
  its origin and CSRF checks are forced on (it skips them under `NODE_ENV=test`).
- Without `.dev.vars`, local runs (and the CI E2E job) use a random per-isolate secret, so
  sessions end when the Worker restarts.
- The session cookie keeps Better Auth's `__Secure-` name rather than `__Host-` (Better Auth
  adds the prefix itself); admin writes rely on the `Origin` check instead. #64 kept this:
  every admin write needs a trusted `Origin` and a JSON body, and a session cookie that a
  sibling `*.serp.co` site plants is the planter's own session, which the allowlist refuses.
