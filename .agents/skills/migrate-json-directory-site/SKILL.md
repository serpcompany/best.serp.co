---
name: migrate-json-directory-site
description: Plan, audit, implement, or review a legacy JSON-directory site migration into this Cloudflare D1 platform. Use whenever a user mentions bringing over another directory site, importing legacy products/categories, cloning a site into this repo, multisite onboarding, catalog cutover, or JSON-to-D1 parity—even if they ask only for “the next site.”
---

# Migrate a JSON-directory site

Use the repository migration SOP as the authority. The legacy source is evidence, not
a supported runtime input.

## Required reading

Read these files completely before changing code:

1. `AGENTS.md`
2. `docs/MIGRATION_SOP.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/DEPLOY_RUNBOOK.md`
6. `docs/agents/issue-tracker.md`
7. `docs/agents/triage-labels.md`
8. `docs/agents/domain.md`

Read the relevant source repository’s `AGENTS.md`, site README, configuration, content,
and catalog schema in place. Do not copy catalog files into this repository.

## Workflow

1. Inspect the current worktree and confirm whether another migration is already
   active.
2. Identify the external source root, site ID, source branch/commit, and intended
   cutoff.
3. Run the read-only preflight:

   ```bash
   pnpm migration:preflight -- \
     --source-root /absolute/path/to/json-directory \
     --site-id example.com
   ```

4. Explain every issue and warning. Do not normalize silently.
5. Determine whether the requested deployment is:
   - an independent site repository based on this platform; or
   - another app/tenant in this monorepo.
6. If it is another app/tenant, audit hard-coded site, Worker, D1, artifact, and
   workflow boundaries. Extend `scripts/site-targets.ts` exhaustively and treat the
   existing tenant columns or two-site implementation as insufficient proof that a
   new site is isolated.
7. If key decisions remain unclear, use `wayfinder`. Otherwise use `to-spec`, then
   use `to-tickets` to publish independently verifiable vertical slices and their
   blocking relationships to GitHub Issues.
8. Build a field map and evidence checklist before a generator or SQL artifact.
9. Parse external data into precise types at the migration boundary.
10. Extend and run `pnpm migration:generate` to produce deterministic SQL and parity
    evidence without retaining intermediate catalog files or adding runtime adapters.
11. Prove local D1 parity and public-route behavior independently.
12. Before the first Cloudflare mutation, verify the scoped credential and account
    identity through read-only calls; never confuse the account ID with the API
    token.
13. Provision and mutate Cloudflare only with explicit authority through protected
    workflows.
14. Run the protected preview release from empty state, then repeat it from populated
    state to prove the matching publication checksum produces an import no-op.
15. Capture desktop and real mobile route evidence, including element containment
    rather than relying only on document-level scroll width.
16. Remove legacy runtime paths only after parity and the observation window.
17. Run the full harness, review the diff, record acceptance evidence and residual
    risks on the governing ticket, and safely remove the registered migration
    worktree after merge.

## Stop conditions

Stop and request a decision when:

- the tenancy/deployment option is unspecified and changes the implementation;
- source authority or cutoff commit cannot be established;
- records would be dropped or merged without an approved rule;
- production credentials, confirmation, or protected environment approval is absent;
- rollback evidence or a retained backup is missing.
- the authenticated Cloudflare account or scoped resource identity cannot be proven
  before mutation.

Do not stop merely because source data has correctable validation errors. Report them
and continue with non-mutating analysis.

## Output

For planning or audit requests, return:

- source identity and preflight counts/checksums;
- issues, warnings, and mapping decisions;
- tenancy/platform prerequisites;
- exact evidence required for parity;
- risks, rollback conditions, and next authorized action.

For implementation requests, keep the governing GitHub issue and tickets current and
preserve all required evidence paths from `docs/MIGRATION_SOP.md`.
