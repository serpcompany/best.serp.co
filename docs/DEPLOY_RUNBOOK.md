# Deploy runbook

Status (serpcompany/best.serp.co#34):

- **Staging** is live at https://best-serp-co-staging.serpcompany.workers.dev (D1
  `best-serp-co-staging`, catalog imported and verified against the parity report). Every
  `*.workers.dev` response carries `X-Robots-Tag: noindex, nofollow`.
- **Production** D1 `best-serp-co-production` exists with no data; the production Worker
  is not deployed.
- **best.serp.co** is still served by GitHub Pages from the `legacy-static` branch, whose
  deploy workflow runs on pushes to that branch.

Manual commands used so far (from `apps/web`, authenticated with `wrangler login`):

```bash
pnpm exec wrangler d1 migrations apply best-serp-co-staging --remote --env staging
pnpm exec wrangler d1 execute best-serp-co-staging --remote --env staging \
  --file ../../d1/artifacts/best-serp-co-v1.sql --yes
pnpm build:worker && pnpm exec opennextjs-cloudflare deploy --env staging
```

The single-file import applies all 3,422 listings in about 30 seconds.

## Target shape

- Workers `best-serp-co-staging` (workers.dev) and `best-serp-co-production` (no
  workers.dev), declared as `env.staging` / `env.production` in `apps/web/wrangler.jsonc`.
- D1 databases `best-serp-co-staging` and `best-serp-co-production` (IDs committed in
  `wrangler.jsonc`; they are not secrets), `D1_RUNTIME_ENV` `staging` / `production`.
- Production served through a Worker Custom Domain on the `serp.co` zone for
  `best.serp.co`.
- GitHub environments `staging` and `production` holding `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN`; production requires reviewer approval.

## Release flow (to be implemented)

1. Push to `main` runs validation, builds the Worker, applies pending D1 migrations to
   staging, deploys staging, and runs the Playwright smoke suite against it.
2. Production is a manual `workflow_dispatch` from `main` with a typed confirmation:
   export a D1 backup, apply migrations, deploy the Worker, smoke test.
3. The one-time catalog import runs once per environment from the generated artifacts
   (about 420 batches) and is verified against the parity report.

## Cutover checklist

1. Staging passes `pnpm migration:compare -- <staging-origin> --sample 60` with zero
   differences, a full sitemap crawl with zero non-200s, and the smoke suite.
2. Stop `json-directory-template` from deploying serp.co (its deploy would overwrite
   this repository's `main`).
3. Attach the Custom Domain `best.serp.co` to the production Worker (replaces the
   GitHub Pages CNAME), confirm `curl -I https://best.serp.co` no longer shows
   `server: GitHub.com`, and submit `sitemap-index.xml` in Search Console.
4. Disable GitHub Pages and delete the `legacy-static` branch.
5. Remove `apps/serp.co` and `sites/serp.co` from `json-directory-template`.

Production database or Worker operations require explicit maintainer confirmation;
a passing local harness never grants deployment authority.
