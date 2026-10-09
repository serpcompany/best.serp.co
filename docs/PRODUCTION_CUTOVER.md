# Production cutover

The cutover moved best.serp.co from GitHub Pages to the production Worker and is complete:
best.serp.co is the Worker's Custom Domain, `CANONICAL_HOST_REDIRECT` is `on`, and GitHub Pages
and its `legacy-static` branch are gone. This is the record of the order the steps had to
happen in, and why. Ongoing releases: [Deploy runbook](./DEPLOY_RUNBOOK.md).

Before it, the production Worker answered only at its noindex workers.dev review URL, and Deploy
Production gated the Worker there while best.serp.co still answered with `server: GitHub.com`.

## Checklist

1. Staging passes `pnpm migration:compare -- <staging-origin> --sample 60` with zero
   differences, a full sitemap crawl with zero non-200s, and the smoke suite.
2. Stop `json-directory-template` from deploying serp.co (its deploy would overwrite
   this repository's `main`). Done.
3. Bootstrap production D1 ([Production D1 bootstrap](./PRODUCTION_BOOTSTRAP.md)), then run
   Deploy Production, which gates the Worker on the review URL while GitHub Pages still serves
   best.serp.co.
4. Attach the Custom Domain `best.serp.co` to the production Worker (it replaces the GitHub
   Pages CNAME), confirm `curl -I https://best.serp.co` no longer shows `server: GitHub.com`,
   and re-run Deploy Production so its gates run in production mode: through the workers.dev
   host, then on best.serp.co. Then check best.serp.co by hand with the two commands in
   [After a deploy](./DEPLOY_RUNBOOK.md#after-a-deploy). If either fails, roll the Custom
   Domain back to GitHub Pages before investigating. Then submit `sitemap-index.xml` in Search
   Console.
5. Only after step 4, switch the platform host to the canonical host. Merge a reviewed pull
   request into `staging` that sets `env.production.vars.CANONICAL_HOST_REDIRECT` to `"on"` in
   `apps/web/wrangler.jsonc`, wait for Deploy Staging to go green, then promote it
   ([Production release](./DEPLOY_RUNBOOK.md#production-release)). That push runs Deploy
   Production, whose gates then also require the workers.dev host to answer one 308 to
   best.serp.co.
   - Promote; don't dispatch. A Deploy Production dispatch before the promotion is pushed
     would release the `main` head with the switch still `off` and never check the 308.
   - Never before step 4. A flip is live as soon as the deploy finishes (the review URL sends
     every visitor to GitHub Pages), and the gates fail only afterwards. Recover by rolling the
     Worker back, then set the switch back to `"off"` with a `hotfix-*` pull request into
     `main` ([Release guards](./RELEASE_GUARDS.md#hotfixes)) or a change promoted from
     `staging`.
6. Submission review moves in-app ([Admin panel](./ADMIN_PANEL.md));
   `submit-gsc-sitemaps.yml` stays manual-only.
7. Disable GitHub Pages and delete the `legacy-static` branch (done 2026-10-05).
8. Remove only serp.co pieces from `json-directory-template`; it still serves other sites.
