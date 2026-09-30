# Confidence system

Status: active map; not an implementation backlog

Responsible area: product and release engineering

Last verified: 2026-08-13

Validation: `pnpm docs:check`

This document maps how the repository can obtain confidence while a change moves
from an idea to production. It intentionally does not enumerate every possible test
or require every layer to be built now.

The expected Visitor behavior is inventoried in
[`CAPABILITIES.md`](./CAPABILITIES.md). The point-in-time production evidence is in
[`LIVE_VISITOR_BASELINE.md`](./LIVE_VISITOR_BASELINE.md). Detailed commands remain in
the [harness](./HARNESS.md), [build pipeline](./BUILD_PIPELINE.md), and
[deploy runbook](./DEPLOY_RUNBOOK.md).

## Status vocabulary

- **Existing**: available and used today.
- **Next**: the smallest additional feedback loop justified by a current risk.
- **Later**: potentially valuable after the Next work produces evidence.
- **Possibly unnecessary**: an idea to revisit only if a concrete problem justifies
  its ongoing cost.

Items marked Later or Possibly unnecessary belong in this map, not in separate
GitHub issues. Create an issue only when the Maintainer chooses an area for a current
decision or independently verifiable implementation slice.

## Design principles

1. Agree on the public seam before adding a test. Tests describe behavior visible
   through an interface and must survive internal refactoring.
2. Grow confidence through tracer bullets: one small vertical journey, exercised
   immediately, before expanding breadth.
3. Enforce architectural invariants and dependency direction mechanically without
   prescribing incidental implementation details.
4. Keep fast feedback fast. A focused check, the fast harness, the full harness, and
   browser or live evidence have different jobs.
5. Treat a clean build, a deployed Worker, and verified production behavior as
   separate evidence.
6. Keep external outcomes such as rankings, impressions, traffic, and field Core Web
   Vitals outside deterministic build claims.
7. Add a recurring check only after a real failure mode or accepted invariant proves
   that its maintenance cost is worthwhile.

These principles apply test-driven development at stable seams, vertical tracer
bullets, deep modules with small interfaces, mechanical architecture enforcement,
and low-latency isolated agent environments.

## Candidate evidence seams

Confirm the relevant seam on the governing issue before creating new tests.

| Seam | Observable interface | Representative evidence |
| --- | --- | --- |
| Shared catalog module | Site-bound catalog operations and returned DTOs | Data-operation contract tests against local D1 |
| D1 publication | Schema, publication version, checksum, eligibility, and isolation | Migration, publisher, and parity tests |
| Worker HTTP | Status, headers, redirects, response bodies, and Site identity | Route probes against an OpenNext Worker |
| Rendered Visitor journey | Visible content, navigation, interaction, metadata, and responsive behavior | Playwright through public pages and controls |
| Protected release | Exact Site/environment selection, artifact, database compatibility, and confirmation | GitHub Actions job and retained release evidence |
| Live canonical Site | Production route, transport, SEO, sitemap, feed, and isolation behavior | Bounded read-only post-deployment probes |
| External observation | Search indexing, traffic, rankings, and field performance | Search Console, analytics, and field datasets |

Internal functions and collaborator call sequences are not additional public seams
merely because they are convenient to test.

## Feedback-loop map

| Layer | Status | Trigger and purpose | Current mechanism | Evidence or gap |
| --- | --- | --- | --- | --- |
| Design and specification | Existing | Before a substantial change, define the behavior and identify its seam. | GitHub Wayfinders, specs, and tickets plus `CONTEXT.md`. | Tickets do not yet consistently name the seam being changed. |
| TDD tracer bullet | Existing practice | During implementation, prove one thin vertical slice before expanding it. | A focused test at the chosen seam, followed by the minimum implementation that makes it pass. | This is a working discipline, not a separate global command or coverage campaign. |
| Focused local check | Existing | Run after each small edit for immediate, behavior-specific feedback. | Direct Vitest, Playwright, typecheck, or repository command selected for the changed seam. | The governing ticket should record the command and result. |
| Fast local harness | Existing | Run at milestone boundaries to protect foundational repository contracts. | `pnpm harness:fast`. | Covers documentation, architecture, shared catalog operations, D1 contracts, and types. |
| Full local harness | Existing | Run before claiming a substantial change complete. | `pnpm harness:check`. | Adds changed-file policy, lint, repository tests, Worker configuration, and both builds. It does not include the general `pnpm test` or Playwright suite. |
| Pull-request CI | Existing | Prevent an unvalidated change from entering protected `main`. | `.github/workflows/pr-review.yml` supplies five strict required checks: repository/Site policy, types, unit tests, both Worker builds, and conditional local Playwright. | Pull requests must be current with `main`, required checks must complete, and conversations must be resolved. The checks do not yet exercise a deployed preview. |
| Integrated `main` revision | Existing | Independently validate the exact revision produced by merging a reviewed pull request without deploying it. | Every push created by a merge runs `pnpm harness:check` on a clean GitHub-hosted runner with the exact push range. | This detects integration or clean-runner drift after merge; production release remains separate and manual. |
| Release preflight | Existing | Prove the exact reviewed revision, Site, environment, configuration, and D1 compatibility before mutation. | Manually dispatched protected production workflows. | SERP and PVD have separate confirmation and environment contracts. |
| Required pull-request preview | Next | Prevent broken Visitor behavior or discoverability from entering `main` by exercising each changed Site on an isolated live preview. | PVD has preview Worker and D1 identities, but PR CI does not create a unique preview or run required live checks against it. | Settle preview isolation, concurrent PR naming, bounded Visitor/SEO checks, fork security, and cleanup; then implement the smallest PVD-first vertical slice. |
| Isolated preview target | Available for both Sites | Exercise a deployable Worker away from production. | Each Site has one protected active replacement Preview D1 and Worker; the temporary Issue #72 source Preview databases were deleted with retained evidence. | These shared Preview identities are not sufficient for concurrent PRs; do not create substitutes without explicit platform authority. |
| Proven-candidate promotion | Later | Promote the exact artifact or version that passed pre-production proof. | No required preview-to-production promotion contract exists. | Reconsider only after required PR previews produce useful evidence; do not make this the first implementation slice. |
| Post-deployment smoke | Later; secondary only | Detect production-only routing, binding, DNS, or edge drift after release. | Manual runbook checks only. | Detection after mutation cannot prevent a bad deploy. Reconsider only as confirmation after the pre-production gate exists. |
| Continuous live monitoring | Later | Detect production drift after a release window. | No repository-owned live monitor exists. | Define only after post-deployment checks reveal stable, worthwhile invariants. |
| Periodic repository gardening | Existing | Detect documentation and architectural drift independently of feature work. | Weekly and manual `harness-gardening.yml` plus `pnpm docs:garden`. | Future checks require deterministic rules and a demonstrated source of entropy. |
| Architecture deepening survey | Later | Find recently changing shallow modules whose complexity should move behind a smaller interface. | Maintainer-invoked review using the installed architecture workflow. | Keep periodic and judgment-led; do not turn every candidate into a ticket. |
| Coverage threshold | Possibly unnecessary | Reveal unexercised implementation after seam-based tests are healthy. | No configured coverage gate. | Do not adopt a percentage target until its value and resistance to tautological tests are demonstrated. |
| External outcome observation | Later | Learn whether discovery and growth improve over time. | External analytics, Search Console, ranking, and field-performance sources. | Inform prioritization; do not present these lagging outcomes as deterministic release proof. |

## Initial investment boundary

The map authorizes no implementation by itself. The recommended sequence is:

1. Preserve the existing focused, fast, full, pull-request, release, and gardening
   loops.
2. Preserve the protected pull-request gate and the non-deployment validation attached
   to merged `main` revisions.
3. Define the smallest PVD pull-request preview contract: unique isolation, preview
   D1 safety, a bounded Visitor and discoverability journey, fork security, and
   cleanup.
4. Make that live preview result a required merge check. Apply the pattern to SERP
   only after PVD produces operational evidence. Reconsider exact artifact promotion
   and post-deployment confirmation later.

Do not open implementation issues for Later or Possibly unnecessary rows. When a row
becomes current, first decide its seam and expected evidence, then create the smallest
independently verifiable vertical-slice ticket.

## Influences

- [Tracer Bullets: Keeping AI Slop Under Control](https://www.aihero.dev/tracer-bullets)
- [The improve-codebase-architecture Skill](https://www.aihero.dev/skills-improve-codebase-architecture)
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [AI Is Forcing Us To Write Good Code](https://bits.logic.inc/p/ai-is-forcing-us-to-write-good-code)
