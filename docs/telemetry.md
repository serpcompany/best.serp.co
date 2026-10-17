# Telemetry

What the site reports about itself, and the owner setup each part needs. None of it carries
user data, and none of it runs outside public production except Sentry, which tags each
event with its environment.

## Analytics

Analytics load only on public production: `SITE_ENVIRONMENT=production` on best.serp.co
(`analyticsForRequest` in `apps/web/src/lib/environment/request-environment.ts`;
[Architecture](./architecture.md#environments-and-hosts)). Local, staging, and the production
Worker's workers.dev host render neither tag, and `public-policy.test.tsx` holds that line.

- **Google Tag Manager:** the container in `site.analytics.gtmId`
  (`apps/web/src/lib/site/site.ts`).
- **Cloudflare Web Analytics** (#170): the beacon at the end of `<body>`, once
  `CF_WEB_ANALYTICS_TOKEN` holds the site token.

### Cloudflare Web Analytics setup

The token is set: the site `best.serp.co` in the SERP account's Web Analytics (added 2026-10-09
as a JS-snippet site, so Cloudflare injects nothing itself). Without a token, production renders
no beacon.

1. In the Cloudflare dashboard, open Web Analytics and add the site `best.serp.co`. Cloudflare
   turns on automatic setup for a hostname it proxies; switch it to the JS snippet (Manage
   site → Enable with JS Snippet installation). The Worker renders the beacon itself, so
   automatic injection would add a second one.
2. Copy the `token` from the snippet (32 hex characters; public, not a secret) into
   `env.production.vars.CF_WEB_ANALYTICS_TOKEN` in `apps/web/wrangler.jsonc`, through a pull
   request. Staging and local never set it.
3. After the production deploy, best.serp.co's HTML ends with a
   `static.cloudflareinsights.com/beacon.min.js` script; the workers.dev host and staging have
   none. Deploy Production's HTTP gates check best.serp.co and the workers.dev host, and Deploy
   Staging's gates check staging (`scripts/d1-preview-http-gates.ts`, #272): while production
   has a site token, best.serp.co without the beacon fails the deploy.

## Error reporting (Sentry)

Sentry reports errors from the browser (`instrumentation-client.ts`) on every page, and from
the Worker (`apps/web/src/instrumentation.ts`, server rendering and route handlers) on the
signed-in and operational surfaces only: `/admin`, `/account`, `/submit`, `/login`, `/claims`
and `/api` (#355), apart from `/api/search`, which logs like a public page
([below](#public-pages-worker-logs-not-sentry), #401). The Worker entry adds the errors
Next.js never sees, from those same surfaces and from the cron jobs
([below](#worker-entry-and-cron-errors)). The settings and the scrubber are in
`apps/web/src/lib/telemetry/sentry.ts`: errors only, with no PII, free-text error messages, query
strings, cookies, headers, console output, logger data, sessions, tracing, or replay. Both deploy builds bake in
`NEXT_PUBLIC_SENTRY_DSN` (repo variable `SENTRY_DSN`) and the commit as the release; with no DSN,
Sentry stays off (E2E sets none).
`SENTRY_AUTH_TOKEN` (repo secret, project releases scope) and the `SENTRY_PROJECT` variable
only upload source maps. The owner creates the project and sets all three, then checks that the
first staging error's stack frames resolve.

### Stable error codes, not messages

serp's
[telemetry standard](https://github.com/serpcompany/serp/blob/main/docs/engineering/technology/telemetry.md#required-defaults-for-every-project)
asks for stable error codes, not arbitrary error strings (#211). A message can hold what a
visitor typed, a validation error can echo a field, and Drizzle adds a failed statement's bound
values to its message. So:
- **Sentry gets a code or nothing.** `scrubEvent` keeps an event's message, and each exception's
  in the chain (an error's `cause` included), only when it is exactly one of `ERROR_CODES` in
  `sentry.ts`. Anything else becomes `[redacted]`, from the logger, `onRequestError`, the
  browser's global handlers or `global-error.tsx`. The error's type, stack and route stay, so
  issues still group and point at the code.
- **The browser drops its noise before that** (#422). Sentry's inbound filters for chunk-load
  and hydration errors match the message, which now arrives redacted. So the browser's
  `browserSentryOptions` drops them itself, before `beforeSend`: `ignoreErrors` (chunk-load,
  React hydration and `ResizeObserver` errors) match the raw message, and `denyUrls` (extension
  scripts) the script's URL. `beforeSend` then drops a stack that starts in an injected
  `<anonymous>` script and every error from an automated browser (`navigator.webdriver`).
  React error 419 is still sent: it is a server render failure, and the browser's report is its
  only trace in Sentry; its cause is in Workers Logs. The Worker keeps `sentryOptions`.
- **The shared logger takes a code.** `logger.error` (`apps/web/src/lib/logging`) accepts one of
  `ERROR_CODES` or an `Error`. The caught error goes in `cause`, so Sentry gets its type and
  stack under the code, with its message redacted; context goes in `data`, which stays in the
  browser console. A new code joins `ERROR_CODES`. `sentry-events.test.ts` runs the SDK with its
  default integrations and checks what it sends.
- **Worker log lines carry a code too.** Where a caught error can hold user input, the JSON line
  spreads in `errorFields(error)` (`lib/telemetry/error-fields.ts`): `code` is an allowlisted
  message, the error's own `code`, or `d1ErrorCode` (`SQLITE_ERROR:missing_table`), else
  `UNKNOWN`; `name` is the error's class. Errors with their own code are `BillingProviderError`,
  `SubmissionError`, and `CodedError` (`lib/telemetry/coded-error.ts`), which the fixed
  configuration and billing-invariant failures throw with one of `FAILURE_CODES`
  (`d1_binding_missing`, `billing_secrets_missing`, `refund_paid_order_missing`, and so on), as
  does a page's account guard that could not decide (`auth_guard_failed`, #389): it could not
  read the session or the allowlist, because D1 failed or accounts are misconfigured (a missing
  `DB`, a bad auth secret or URL), and its `auth_guard_error` line names the cause. A code never
  holds an id. A `CodedError`'s code is for Worker logs only: on a surface that reports to
  Sentry, an uncaught `CodedError` arrives as `Error: [redacted]` with its stack. The lines that
  spread in `errorFields` are `request_error`, `claim_failed`,
  `submission_request_failed`, `admin_decision_failed`, `admin_refund_failed`,
  `admin_rejection_email_failed` (a recorded refund's email retry, #499),
  `auth_guard_error`, `billing_webhook_failed`, `billing_webhook_fulfilment_failed` (a
  payment's fulfilment after the webhook answered; also logged, at warn with its `outcome`, when
  it ended without applying: `retry_later` or `unknown_order`, #481), the billing service's
  failures,
  `legacy_root_lookup_failed`, `scheduled_job_failed`, and the media failures
  (`submission_media_error`, `revision_media_error`, `media_settle_error`, `media_forget_failed`).
- **Configuration failures keep their message.** `billing_unavailable`, `auth_unavailable`,
  `site_environment_error`, `server_sentry_start_failed`, `routes_manifest_invalid`,
  `media_cron_disabled` and the other `*_media_disabled` lines catch only a missing binding,
  variable or SDK, whose fixed message names the setting to fix; `sign_in_code_prune_failed`
  binds only a date and a limit. The email logs keep `redactedErrorMessage` beside `errorCode`
  (`lib/email/senders.ts`).

### One failure, one event

Errors are Sentry's most expensive category, so a failure that repeats is reported once (#401):
- **Search** (`components/search/use-search.ts`): the browser reports only the failures the
  server can't see, as `search_failed`, at most once per kind per page session: `network` (no
  answer, or one cut off) and `parse` (an answer that doesn't parse or fit the contract). Keyed by
  kind, a flaky connection can't hide a later parse failure, the sign of a tab older than a
  deploy. An error status is never reported from the browser: `/api/search` answers only 200 or a
  server error, which the Worker logs and doesn't send to Sentry
  ([below](#public-pages-worker-logs-not-sentry)), and a 4xx comes from in front of it (a 429
  throttle, a challenge, staging's password). So an outage of the route itself sends Sentry
  nothing; each failed search is a `request_error` line in Workers Logs.
- **Search entries** (`use-search-helpers.ts`): the entries one response fails on are one report,
  the first failure's code, with every failed entry in the console line's `data`.
- **Error pages** (`error-content.tsx`, `global-error.tsx`): an error with a Next.js `digest` came
  from the server, and on a path that reports to Sentry `onRequestError` already sent it
  (`reportedByServer` in `lib/telemetry/server-errors.ts`), so the page sends nothing. A public
  page's server error is still reported from the browser.

### Public pages: Worker logs, not Sentry

Every other path never loads the Worker's Sentry SDK: the home page, the catalog, search, the
sitemaps and RSS, the other public pages, and unknown paths. This is the owner's decision in
#355: the SDK cost about 110 ms of CPU in each fresh isolate (#334), and search crawlers mostly
see uncached public pages in fresh isolates.

**The search API logs the same way** (#401, the owner's option 1). `/api/search` is under `/api`,
but every public page's search box calls it on each pause in typing, so during an outage of the
route (D1's `Network connection lost`) Sentry got one event per search, and each fresh isolate
started the SDK to serve it. `LOG_ONLY_ROUTES` in `lib/telemetry/server-errors.ts` takes the
route, and every path under it, out of the surfaces: its errors are `request_error` lines only,
and a search never starts the SDK. The browser doesn't report its error statuses either, so the
line is the error's only record. Every other `/api` route still reports to Sentry.

### Every request error is in the Worker logs

A server error on any path, a public page or a surface Sentry reports, is one JSON line on
`console.error`, which Workers Observability keeps (#204). Find it by filtering the Worker's logs
on `request_error`. The line has:
- the method, the path without its query string, the route, the route type and the render
  source;
- the error's code, name, stack frames and digest, but not its message (#211): the stack drops
  the header that repeats the message, however many lines it spans.

The digest is the id a browser's "error occurred in the Server Components render" (React #441)
carries, so a browser error leads to its cause. The line is written before Sentry is tried, so
it is there with no DSN (local, E2E) or an SDK that fails to load.

Next.js can report one error twice, when a page and its metadata await the same failed read; it
is logged once, as Sentry captures it once. Next.js also prints the error itself, as before.

Locally the line doesn't print: `opennextjs-cloudflare preview` runs Wrangler under `spawnSync`
and holds its stderr, where the Worker's `console.error` and `console.warn` go, until it exits.
Wrangler keeps them in its local observability store; read the errors there with
`curl -X POST <preview origin>/cdn-cgi/local/explorer/api/local/observability/query -H
'content-type: application/json' -d '{"sql":"SELECT ts_ms, message FROM logs WHERE level =
\"error\""}'`.

### How the split works on the Worker

One build serves every environment and every route, and OpenNext ships the whole app as one
Worker bundle. So the split can't be a build setting or a separate bundle for public pages. It
is made per request, at run time, by which modules the isolate evaluates.

- **Only a dynamic import reaches the SDK.** `apps/web/src/lib/telemetry/server-sentry.ts` is
  the only server module that imports `@sentry/nextjs`, and `src/instrumentation.ts` reaches it
  through `await import()`. Turbopack puts it in a chunk of its own. OpenNext still bundles that
  chunk into `.open-next/worker.js`: its Turbopack patch replaces reading chunk files, which
  workerd can't do, with a static `requireChunk` switch. A chunk's modules run only when first
  required, though, so an isolate that never imports the SDK carries its code but never
  evaluates it. `server-errors.test.ts` scans `apps/web/src` and `apps/web/worker.ts` for any
  static import, re-export, bare import or `require` of an `@sentry/*` package: only
  `instrumentation-client.ts`, `server-sentry.ts` and the Worker entry's `worker-sentry.ts`
  ([below](#worker-entry-and-cron-errors)) may have one.
- **Two bundles share one switch.** The Worker entry (`apps/web/worker.ts`, bundled by Wrangler)
  sees every request first. Next.js runs `register()` once per isolate: OpenNext's
  instrumentation patch requires the built `instrumentation.js` statically, and Next.js awaits
  `register()` while it prepares the isolate's first request, before rendering it. The two
  bundles share only `globalThis`, so `server-errors.ts` keeps a switch there,
  `Symbol.for('best.serp.co/server-sentry')`:
  - the Worker entry marks a request that reports to Sentry (`startServerSentryFor`);
  - `register()` leaves the starter (`registerServerSentryStarter`);
  - whichever runs second starts the SDK, once per isolate.

  So a reporting request always renders with Sentry started, as before (#48), and a public
  request never starts it.
- **`onRequestError` routes by path.** Every error is logged as `request_error` first; a
  reporting path also goes to `Sentry.captureRequestError`, and one whose SDK fails to load or
  start is only logged. Only the first segment of the pathname counts, even in an absolute URL,
  apart from `LOG_ONLY_ROUTES`, which match by whole segments (`/api/search/…`, not
  `/api/searchx`). `server-errors.test.ts` walks the top-level routes in `apps/web/src/app` and
  fails on one that is neither a surface (`SERVER_SENTRY_SURFACES`) nor in its list of public
  segments, and holds every route folder in `src/app/api` but `search` to reporting.
- **`global-error.tsx` imports `captureException` when it shows**
  (`lib/telemetry/report-global-error.ts`). Every page's server render loads that component,
  and its static import used to load a second, server-rendering copy of the SDK. In the
  browser, the import reaches the SDK that `instrumentation-client.ts` already started, so the
  error page still reports, as before. If that import fails (offline, or a tab left open across
  a deploy), the error is rethrown outside React and that SDK's global handler reports it. The
  browser's chunks change with it:
  - every page loads the SDK as one chunk instead of two, about 4 KB smaller gzipped, so it has
    one `<script>` tag fewer;
  - the error page alone loads one more SDK chunk, about 110 KB gzipped, before it reports.
- **Nothing depends on the environment.** The deploy build bakes in the DSN, and each event
  takes its environment from `SITE_ENVIRONMENT` (`sentryOptions`). Staging and production split
  the same way, and a local build with no DSN runs the same code with Sentry off.

**Once an isolate has started the SDK** for a signed-in or operational request, it stays
started. A later public request in that isolate still only logs its request errors, because
`onRequestError` routes by path.

### Worker-entry and cron errors

Next.js reports only what happens inside it. Two kinds of error never reach `onRequestError`, so
the Worker entry reports them itself (#210, `apps/web/src/lib/telemetry/worker-errors.ts`):
- **A request's error that escapes the Worker's `fetch`:** the redirects, the staging and admin
  gates, the edge HTML cache and the gone-listing render. It goes to Sentry only from the
  signed-in and operational surfaces, as above, sent in `waitUntil`, and is rethrown either
  way, so the response doesn't change. On a public page, the runtime's own log of the exception
  stays its only record, as before.
- **A cron job's failure** (`lib/worker/scheduled.ts`): one event per failed job, named
  `<job> (cron <expression>)`, sent before the invocation ends. It is still logged as
  `scheduled_job_failed` first. A cron isolate never starts Next.js, so before this it had no
  Sentry at all. The jobs' modules load when a trigger fires (`lib/worker/run-scheduled.ts`,
  #424), so a failure to load them is reported and logged the same way, as the job
  `load-scheduled-jobs`, and rethrown.

Each event has the error's type and stack, mechanism `cloudflare.fetch` or
`cloudflare.scheduled`, and the same DSN, release, environment and scrubber as the Next.js
side: `worker-sentry.ts` builds its client from `sentryOptions`. Its frames point into
Wrangler's bundle, which isn't minified but whose source maps go only to Cloudflare.

How it keeps #355's split:
- **The SDK loads only to report.** `worker-errors.ts` imports no package; it reaches
  `worker-sentry.ts`, which holds `@sentry/core`, through `import()` once there is an error to
  report. Wrangler keeps that module's code behind a lazy initializer, so a public page, a cron
  run that succeeds, and a build without a DSN never evaluate it. The code itself adds about
  195 KiB (43 KiB gzipped) to the Worker's upload. `server-errors.test.ts` fails on a static
  import of the SDK, or of either gated module, anywhere else.
- **A client of its own.** It is never installed globally and adds no integration that patches
  `fetch` or `console`, so it can't replace the Next.js server SDK's client in a shared isolate
  or slow the isolate's later requests.
- **Never twice.** OpenNext answers Next.js's own errors with the error page, so they don't
  reach the Worker entry. One that did, after `onRequestError` reported it, carries the SDK's
  captured marker on the error object, which every copy of the SDK reads and skips.
- **The DSN and commit come from the build.** Next.js inlines them into its bundle at build
  time, but Wrangler bundles the Worker entry later, at deploy or preview, without them. So
  `pnpm worker:build` writes them to `.open-next/worker-sentry.json`
  (`scripts/worker-sentry-build.ts`), and `worker-build-output.js` imports it. Without a DSN the
  Worker entry reports nothing and loads nothing.
- **Telemetry never fails the Worker.** A report that fails is logged as `worker_sentry_failed`
  (code and name only), and the original error still throws.
