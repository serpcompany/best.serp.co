# Dependency security and upgrade plan

Status: active

Responsible area: repository and release engineering

Last verified: 2026-09-26

Validation: `pnpm security:audit:production`

## Automated maintenance

Dependabot checks the pnpm workspace and GitHub Actions weekly. Minor and patch
updates are grouped by production or development scope; major updates remain
separate so their migration and rollback risk stays visible. Pull-request limits
bound review load. Dependabot security updates are a repository setting, not a YAML
setting: enable them only after this configuration and its checks are merged and
reviewed.

The Production Dependency Audit runs for pull requests, weekly, and on demand. It
executes `pnpm audit --prod --json`, considers only high and critical findings, and
compares advisory-plus-package identities with the reviewed baseline in
`security/production-audit-baseline.json`.

- A new advisory or a severity escalation fails the check.
- Existing baseline debt remains visible as warnings; a pass is not a clean bill of
  health.
- The baseline has a real calendar generation date and a review deadline no more
  than 45 days later. Invalid dates, duplicate identities, uncovered package
  families, and expired baselines fail closed; `9999`-style permanent renewals are
  rejected.
- If the baseline file is absent, the command reports all findings without failing
  so a baseline can be prepared. Repository policy tests require the reviewed file,
  preventing deletion from silently disabling the gate on this repository.
- Low and moderate findings remain in the raw pnpm report but do not gate this staged
  high/critical policy.

Do not refresh the baseline mechanically. `reviewGroups` record why each coupled
package family remains and identify its issue/batch target. Every advisory's batch
and module must match exactly one group. A baseline change must remove fixed entries
or explicitly re-review the remaining family with a near-term date.

## Upgrade batches

Dependency upgrades are deliberately separate from this automation change and run
in this order:

1. **Framework and runtime:** Node/pnpm constraints, Next.js, React, OpenNext,
   Cloudflare/Wrangler, and tightly coupled runtime packages. Validate type checks,
   unit tests, both Worker builds, both local D1-backed apps, Preview deployment, and
   representative route/search/submission smoke tests.
2. **Authentication:** Auth.js/NextAuth, Clerk, adapters, and session/cookie
   dependencies. Validate signed-out behavior, protected preview capabilities,
   cookie/session boundaries, and both Sites independently before Production.
3. **Product libraries:** UI, forms, validation, parsing, image, feed, and other
   runtime libraries. Validate targeted package tests, full harness, browser smoke,
   sitemap/RSS output, and submission behavior.
4. **Build and developer tooling:** TypeScript, Turbo, Vitest, Playwright, Biome,
   ESLint, generators, and test-only packages. Validate the full harness from a clean
   install and confirm generated output and CI behavior are unchanged.

For each batch, update the lockfile with a frozen reinstall check, run focused tests,
run `pnpm harness:check`, and inspect `pnpm security:audit:production`. Use Preview
for runtime-affecting batches and preserve the protected Production release gates.
Remove resolved baseline entries in the same batch; never add a new entry merely to
make CI green.

## Triage and exceptions

Treat exploitability and reachability analysis as additional context, not a reason
to hide a finding. A temporary exception belongs in the baseline only after review
and must retain its severity, affected package, rationale, upgrade batch, and review
deadline. Critical findings receive immediate triage. High findings are scheduled
into the earliest safe batch. Newly disclosed findings remain blocking until fixed
or explicitly reviewed through a baseline change.
