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
   none.

## Error reporting (Sentry)

Sentry reports errors from the browser (`instrumentation-client.ts`) on every page, and from
the Worker (`apps/web/src/instrumentation.ts`, server rendering and route handlers) on the
signed-in and operational surfaces only: `/admin`, `/account`, `/submit`, `/login`, `/claims`
and `/api` (#355). The settings and the scrubber are in `apps/web/src/lib/telemetry/sentry.ts`:
errors only, with no PII, query strings, cookies, headers, console output, logger data,
sessions, tracing, or replay. Both deploy builds bake in `NEXT_PUBLIC_SENTRY_DSN` (repo variable
`SENTRY_DSN`) and the commit as the release; with no DSN, Sentry stays off (E2E sets none).
`SENTRY_AUTH_TOKEN` (repo secret, project releases scope) and the `SENTRY_PROJECT` variable
only upload source maps. The owner creates the project and sets all three, then checks that the
first staging error's stack frames resolve. Worker-entry and cron errors are #210.

### Public pages: Worker logs, not Sentry

Every other path never loads the Worker's Sentry SDK: the home page, the catalog, search, the
sitemaps and RSS, the other public pages, and unknown paths. This is the owner's decision in
#355: the SDK cost about 110 ms of CPU in each fresh isolate (#334), and search crawlers mostly
see uncached public pages in fresh isolates.

A server error on a public page is one JSON line on `console.error`, which Workers Observability
keeps. Find it by filtering the Worker's logs on `request_error`. The line has:
- the method, the path without its query string, the route, the route type and the render
  source;
- the error's name, message, stack and digest.

Next.js can report one error twice, when a page and its metadata await the same failed read; it
is logged once, as Sentry captures it once. Next.js also prints the error itself, as before.

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
  `instrumentation-client.ts` and `server-sentry.ts` may have one.
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
- **`onRequestError` routes by path.** A reporting path goes to `Sentry.captureRequestError`.
  Any other path, or a reporting one whose SDK failed to load or start, is logged as
  `request_error`. Only the first segment of the pathname counts, even in an absolute URL.
  `server-errors.test.ts` walks the top-level routes in `apps/web/src/app` and fails on one that
  is neither a surface (`SERVER_SENTRY_SURFACES`) nor in its list of public segments.
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
started. A later public request in that isolate still logs its request errors rather than
reporting them, because `onRequestError` routes by path.

**The Worker entry outside `openNextWorker.fetch` and `scheduled()`** still report to no Sentry
at all, as before (#210). A wrapper there, such as `@sentry/cloudflare`'s `withSentry`, would load
the SDK for every request and undo this split, so #210 must keep it off public pages.
