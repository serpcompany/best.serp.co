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

Every other path (the home page, the catalog, search, the sitemaps and RSS, and the other
public pages) never loads the Worker's Sentry SDK, which cost about 110 ms of CPU in each fresh
isolate (#334, #355). A server error there is one JSON line on `console.error`, which Workers
Observability keeps: `event: "request_error"`, with the method, the path without its query
string, the route, the render source, and the error's name, message, stack and digest. Find
them by filtering the Worker's logs on `request_error`.

`apps/web/src/lib/telemetry/server-errors.ts` holds the split. The Worker entry starts the SDK
just before Next.js renders an isolate's first request that reports to Sentry, so those
requests run with it from the start, as before. `global-error.tsx` imports the SDK only when
it catches an error in the browser, so a page's server render doesn't load it either.
