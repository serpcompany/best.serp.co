# Telemetry

What the site reports about itself, and the owner setup each part needs. None of it carries
user data, and none of it runs outside public production except Sentry, which tags each
event with its environment.

## Analytics

Analytics load only on public production: `SITE_ENVIRONMENT=production` on best.serp.co
(`analyticsForRequest` in `apps/web/src/lib/environment/request-environment.ts`;
[Architecture](./ARCHITECTURE.md#environments-and-hosts)). Local, staging, and the production
Worker's workers.dev host render neither tag, and `public-policy.test.tsx` holds that line.

- **Google Tag Manager:** the container in `site.analytics.gtmId`
  (`packages/site-config/src/site.ts`).
- **Cloudflare Web Analytics** (#170): the beacon at the end of `<body>`, once
  `CF_WEB_ANALYTICS_TOKEN` holds the site token.

### Cloudflare Web Analytics setup

Until the token is set, production renders no beacon.

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

Sentry reports errors from the Worker (`apps/web/instrumentation.ts`, server rendering and
route handlers) and the browser (`instrumentation-client.ts`), with the settings and the
scrubber in `apps/web/src/lib/telemetry/sentry.ts`: errors only, with no PII, query strings,
cookies, headers, console output, logger data, sessions, tracing, or replay. Both deploy
builds bake in `NEXT_PUBLIC_SENTRY_DSN` (repo variable `SENTRY_DSN`) and the commit as the
release; with no DSN, Sentry stays off (E2E sets none). `SENTRY_AUTH_TOKEN` (repo secret,
project releases scope) and the `SENTRY_PROJECT` variable only upload source maps. The owner
creates the project and sets all three, then checks that the first staging error's stack
frames resolve. Worker-entry and cron errors are #210.
