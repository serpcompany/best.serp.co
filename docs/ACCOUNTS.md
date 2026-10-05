# Accounts and admin access

Decisions: serpcompany/best.serp.co#59. Implementation: #60 (this backend), with the sign-in
screens, `/account`, and the header's signed-in state following the mockups approved in #70.
Sign-in code email is #61.

## Shape

- **Better Auth 1.7.7** for everyone, on the `DB` binding through its Drizzle adapter. Sign-in
  is a **6-digit email code** (email OTP plugin); a first sign-in creates the account. Only
  four endpoints are served (below); every other Better Auth route (passwords, social sign-in,
  account linking, profile updates, deletion, and anything an upgrade adds) answers 404 before
  Better Auth sees it, and `config.test.ts` walks Better Auth's router to prove it.
- **Admins** are signed-in users whose verified email is on the D1 `admin_allowlist`
  (seeded with `devin@serp.co` by migration `0002_better_auth`). Each new session sets
  `users.role` (`user` | `admin`) from the allowlist, and every admin request checks the
  allowlist again, so removing an email revokes access on the next request. Until the admin
  panel (#64) manages the allowlist, add or remove admins with a reviewed migration.
- **`/admin` and `/api/admin`** need Cloudflare Access (production) **and** an admin session.

| Piece | Where |
|---|---|
| Schema, adapter, allowlist, role sync, rate limiter | `packages/data-ops/src/{schema,auth}.ts` |
| Better Auth configuration | `apps/web/lib/auth/config.ts` |
| Settings per environment (vars, secret) | `apps/web/lib/auth/settings.ts` |
| Code delivery (`OtpSender`) | `apps/web/lib/auth/otp-sender.ts` |
| `requireUser()` / `requireAdmin()` | `apps/web/lib/auth/{guards,server}.ts` |
| Worker gate: Access JWT and session cookie | `apps/web/lib/auth/{admin-gate,cloudflare-access}.ts` |
| Endpoints | `apps/web/app/api/auth/[...all]/route.ts` (`/api/auth/*`) |

## Sign-in over HTTP

1. `POST /api/auth/email-otp/send-verification-otp` `{"email","type":"sign-in"}`
2. `POST /api/auth/sign-in/email-otp` `{"email","otp"}` sets the session cookie
   (`better-auth.session_token`; `__Secure-` on https).
3. `GET /api/auth/get-session`, `POST /api/auth/sign-out`.

Requests that carry cookies must send an `Origin` in the trusted origins. A first sign-in may
set a `name` (at most 80 characters) but never an `image`.

**Limits** (D1, `apps/web/lib/auth/rate-limits.ts`; never isolate memory). A client is its
`cf-connecting-ipv6` address if present (it survives Pseudo IPv4 header overwriting), else
`cf-connecting-ip`: an IPv4 address, or an IPv6 address's /64, so one host cannot rotate
through its allocation. Which limits apply depends on the email:

| Email | Code requests allowed |
|---|---|
| New (no verified account) | 1 a minute and 5 an hour per email; 300 an hour site-wide |
| Member (verified account), browser without its known-device cookie | 1 a minute and 5 an hour per email and client; 20 an hour per email |
| Member with its known-device cookie | 1 a minute and 5 an hour per email and client |
| Every request | 5 a minute and 20 an hour per client |

Code guesses: 10 a minute and 60 an hour per client, plus 3 per code. A code expires after ten
minutes and is stored hashed. Limited requests get 429 with `Retry-After`.

**Known-device cookie** (`known-device.ts`). A successful sign-in sets `bsc_known_device`
(`__Secure-` on https): HttpOnly, SameSite=Strict, `Path=/api/auth`, 180 days. It carries the
user id and its issue and expiry times, HMAC-signed with a key derived from
`BETTER_AUTH_SECRET`. It grants no session; it only selects the known-device limits, and only
for the account whose id it carries.

**What this guarantees.**
- **Members with a known-device cookie.** On a browser that has signed in to the account
  before, the next code cannot be stopped by any number of requests from other clients. Only
  that browser's own client limits apply.
- **Members without the cookie** (a new browser or a cleared cookie). The limits keep their
  inbox to 20 codes an hour. An attacker with four or more clients can use up those 20 and
  delay a new browser's code by up to an hour; the member's known-device browsers are
  unaffected.
- **New emails.** Anyone can delay sign-up for a specific address by up to an hour (5 an hour
  per email). Flooding past 300 codes an hour for new addresses pauses new sign-ups for up to
  an hour. That ceiling bounds the mail (cost and sender reputation) and never applies to
  existing accounts.

Rate-limit rows hold HMAC-SHA256 digests under a key derived from `BETTER_AUTH_SECRET`
(`HMAC(secret, "best.serp.co/auth-rate-limit/v1")`, `keys.ts`), never an email or address.
`sessions` stores Better Auth's raw `ip_address` and `user_agent` per session.

**Delivery.** Locally, the dev sender logs each code and `GET /api/auth/dev/otp-outbox?email=`
returns the latest one (the endpoint exists only when the dev sender runs, which is refused
outside `local`). Staging and production have no sender until #61, so a code request answers
503 `OTP_DELIVERY_UNAVAILABLE` and no code is created or logged.

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
trusted origins, since every `*.serp.co` site is same-site). `/admin/` itself is a 204 for
admins until #70 approves a screen. Unknown admin paths are caught by `app/admin/[...path]`
and `app/api/admin/[[...path]]`. `scripts/architecture-guard.test.ts` fails any admin page or
route that does not call the guard, and any Server Action anywhere in `apps/web` or `packages/`
(actions are reachable by id from any path, so no path gate sees them) until #64 decides. Access is required in
production (and whenever `SITE_ENVIRONMENT` is not exactly `local` or `staging`); locally and
on staging only with `CF_ACCESS_REQUIRED=on`.

Coverage: `apps/e2e/tests/access-lock.spec.ts` runs the built Worker twice more with
`CF_ACCESS_REQUIRED=on` (`LOCAL_PREVIEW_VARS`): without the team domain and AUD tag every admin
path answers 503, and with test values it answers 403 to a missing or malformed JWT, both even
for the signed-in owner; an RS256 token with a `kid` makes the Worker fetch the test team's
JWKS and still answers 403. After each deploy, `scripts/d1-preview-http-gates.ts` requires the
admin paths to answer exactly what `wrangler.jsonc` implies: production 403 now that its
Access values are set (503 fails the deploy), staging 401, or 403/503 if `CF_ACCESS_REQUIRED=on`.

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
  adds the prefix itself); admin writes rely on the `Origin` check instead. Revisit in #64.
