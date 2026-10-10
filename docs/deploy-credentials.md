# Deploy credentials

The Cloudflare API token the protected workflows use, the GitHub environments that hold it, and
what a leaked token reaches. The workflows themselves are in the
[deploy runbook](./deploy-runbook.md#workflows). Cloudflare account: `SERP`,
`cec5f04e1d18bcc65f2be0aefb04f059` (an account ID is not a secret).

## Cloudflare API token

Create an **account-owned** token in the SERP account dashboard:
https://dash.cloudflare.com/cec5f04e1d18bcc65f2be0aefb04f059/api-tokens (Manage Account →
Account API Tokens → Create Token → Custom token). Do not use the user profile page
(`dash.cloudflare.com/profile/api-tokens`). Scope it to the SERP account only, with these
account permissions:

| Account permission | Used by |
|---|---|
| D1 → Edit | `wrangler d1 migrations apply`, `d1 execute` (read-only checks), `d1 time-travel info` bookmarks, and the D1 query API used by the publisher |
| Workers Scripts → Edit | `opennextjs-cloudflare deploy`: Worker upload, static assets, the workers.dev setting, observability |
| Account Settings → Read | Wrangler account lookups during deploy |
| Workers R2 Storage → Edit | the `MEDIA` bucket binding and listing media uploads |

Plus one zone permission, Zone → Workers Routes → Edit on `serp.co` (granted 2026-10-09):
Deploy Staging attaches `staging.best.serp.co`, declared in `env.staging.routes` of
`wrangler.jsonc` (#323), as the staging Worker's Custom Domain, and production's best.serp.co
moves there with #192 (until then it is attached in the dashboard).

Cloudflare's current Workers roles map Workers Scripts → Edit to Workers **Editor**, which
cannot create a Worker. The first production deploy created `best-serp-co-production` with
an account-wide token. Both Workers now exist, so per-Worker Editor scopes are enough.

## GitHub environments

The `staging` and `production` environments exist:

- `production` requires reviewer approval and allows deployments only from `main`.
- `staging` allows deployments only from the `staging` branch and has no reviewers.

Each holds two environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account ID above.
- `CLOUDFLARE_API_TOKEN`: today, **both environments hold the same account-wide token**, with
  Edit on every Worker, D1 database, and R2 bucket (serp.co's `cdn` too). A leak from either
  environment therefore reaches staging and production alike
  ([Security boundary](./credential-guards.md#security-boundary)).

The planned fix, an owner decision (decision b in #42) due now that the cutover is complete
(#310), gives each environment its own token, scoped to its Worker, D1 database, and R2 bucket (production's
also reads `cdn-staging`, the upload's copy source), each proven in its workflow before the
account-wide token goes. Until then, a leak reaches both.

The weekly media check uses a third environment, `production-media-health`, whose token only
reads D1 and R2 ([Media health](./media-health.md#weekly-workflow)).

Without the `staging` secrets, `web.yml`'s `deploy-staging` finishes green with a "Staging
deploy skipped" notice, and that run verifies nothing for production. The release,
publication, and upload workflows fail at their credentials step instead. The
`BETTER_AUTH_SECRET` secret and the `/admin` Access
app: [Accounts](./accounts.md). Error reporting (Sentry) and analytics (GTM, Cloudflare Web
Analytics): [Telemetry](./telemetry.md).
