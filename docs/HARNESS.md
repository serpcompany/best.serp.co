# Repository harness

Status: active  
Responsible area: repository harness  
Last verified: 2026-07-30  
Validation: `pnpm harness:fast`

The harness turns repository knowledge into short feedback loops, isolated runtimes,
and evidence an agent can inspect. It is adapted to this existing production product;
it does not copy product-neutral template requirements that would replace the current
application or stack.

## Operating principles

1. The repository is the system of record.
2. `AGENTS.md` is a map; detailed procedures live here, in runbooks, or in skills.
3. Important rules become executable checks with remediation.
4. Untrusted input is parsed at the boundary.
5. Fast feedback runs repeatedly; the full gate runs before completion.
6. Worktrees do not share D1 state, ports, logs, caches, or browser evidence.
7. Runtime state is machine-readable.
8. Failures improve a test, check, document, or tool rather than becoming folklore.
9. Production authority remains separate from local technical capability.

## Feedback loops

### Fast loop

```bash
pnpm harness:fast
```

This runs documentation health, the D1-only architecture guard, shared catalog
data-operation contracts and scan benchmark, fresh Drizzle migration/idempotency
tests, deterministic local D1-to-D1 transfer/parity tests, D1 schema/publication
contract tests,
and TypeScript checks. Each step stops on failure and prints the governing document.
The catalog contract also proves the injected Drizzle client retains per-statement
D1 telemetry and reviewed query-plan bounds.

### Full loop

```bash
pnpm harness:check
# equivalent
pnpm validate
```

The full loop adds a read-only Biome check over committed branch changes plus staged,
unstaged, and untracked local files, followed by repository lint, repository tests,
Wrangler identity validation, and the OpenNext Worker build. The changed-file check
matches the file classes enforced by pull-request CI without requiring unrelated
legacy files to be reformatted. The full loop never deploys or accesses a remote D1
database.

Run a focused test while implementing, the fast loop at milestone boundaries, and the
full loop before a substantial completion claim.

Pull requests into `staging` (the base branch) and `main` (promotions from `staging`, and
`hotfix-*` branches) run `pr-review.yml`. The repository rulesets `staging` and `main` (id
24391799) apply these rules:

- Every change needs a pull request: squash-merged into `staging` (except the merge commit
  that brings a hotfix back from `main`); into `main`, a merge commit for promotions and a
  squash for hotfixes.
- Six checks are required: `Validate Site & Policy`, `Type Check`, `Unit Tests`,
  `OpenNext Worker Build`, and `E2E Tests` from `pr-review.yml`, and `issue-link` from
  `pr-issue-link.yml` (serp's workflow, copied unchanged), which fails a pull request that
  closes no issue. Every `pr-review.yml` job runs on every pull request, because a skipped job
  satisfies a required check; `issue-link` skips only bot, promotion, and merge-back PRs.
- Force pushes and branch deletion are blocked.

The rulesets require no approving review, no up-to-date branch, and no resolved
conversations. Repository admins can bypass them only through a pull request, never with a
direct push. Rulesets cannot restrict a pull request's head branch, so `Validate Site &
Policy` fails a pull request into `main` whose head is not `staging` or `hotfix-*`. That only
catches mis-targeted pull requests; Deploy Production's tree check is the control. Agents
never merge: the owner approves every merge
([Release guards](./RELEASE_GUARDS.md#promotion)).

After a reviewed pull request merges, `main-validation.yml` runs the full loop again
on the exact resulting `staging` or `main` revision. It supplies the before/after push
revisions to the changed-file policy and has read-only repository permission. It does not
deploy, use a protected environment, or access a remote D1 database. This post-merge
result proves the integrated revision independently; it does not replace the required
pre-merge checks. Deployment is separate: `deploy-staging.yml` runs the fast loop and
deploys each `staging` push to staging, and `deploy-production.yml` releases each `main`
push after reviewer approval (see the [deploy runbook](./DEPLOY_RUNBOOK.md#workflows)).

## CI runners

Every job runs on GitHub-hosted `ubuntu-latest` until the repository variable
`CI_RUNNER_LABELS` is set; then the credential-free CI jobs below move to the runner it names.
Its value is JSON: a label array the runner must fully match, or a quoted runner name. A bare
`self-hosted` is not JSON and fails every routed job at `runs-on`.

```bash
gh variable set CI_RUNNER_LABELS --body '["self-hosted","linux","x64"]'
gh variable delete CI_RUNNER_LABELS  # rollback: runs that start later use ubuntu-latest
```

| Follows `CI_RUNNER_LABELS` | Always `ubuntu-latest` |
| --- | --- |
| PR Review: Validate Site & Policy, Type Check, Unit Tests, OpenNext Worker Build | PR Review: E2E Tests (installs Playwright browsers) |
| Main Validation, Production Dependency Audit, Harness Gardening, Label PRs, Links Checker | Deploy Staging (also Playwright smoke), Deploy Production, Bootstrap Production D1, Publish D1 Catalog, Review D1 Submission, Notify Verified D1 Submissions, Check Listing Media Health, Submit GSC Sitemaps |

Routed jobs hold no secret beyond their own `GITHUB_TOKEN` and need no browser, `sudo`, or
`apt`. Jobs with Cloudflare or Google credentials, a protected environment, or a deploy stay on
ephemeral VMs, so no secret, D1 data, or Wrangler session lands on a persistent host.
[`scripts/ci-runners.ts`](../scripts/ci-runners.ts) holds the expression and the routed jobs;
`scripts/ci-runner-workflows.test.ts` fails any other `runs-on` and any hardcoded `self-hosted`.

The fork guard: a pull request whose head repository is not this one (or was deleted) runs on
`ubuntu-latest` whatever the variable says. Fork pull requests still get every check;
same-repository branches, Dependabot's included, use the routed runner.

```yaml
runs-on: ${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || fromJSON(vars.CI_RUNNER_LABELS || '"ubuntu-latest"') }}
```

Label PRs (`pull_request_target`) runs no pull request code. It checks out only
`.github/labeler.yml` from the base commit, so a reused workspace cannot feed it other rules.

Runner prerequisites:

- An organization runner group that allows this repository. While the repository is public the
  group must also allow public repositories; avoid that by setting the variable only after the
  repository is private.
- Linux x64 or arm64 with a glibc recent enough for workerd (Ubuntu 22.04 or newer), bash 4.4+,
  git 2.18+ (otherwise `actions/checkout` downloads a tarball and the diff checks fail), curl,
  and tar, run by an unprivileged user. No browsers, Docker, `sudo`, or global Node or pnpm:
  `actions/setup-node` reads `.nvmrc`, and `pnpm/action-setup` puts pnpm and its store in the
  job's `RUNNER_TEMP`.
- One job per runner process: register several runner instances, each with its own `_work`,
  for parallel checks. No routed job binds a fixed port; local D1 state lives in the workspace
  or a fresh temporary directory, and the install action points `TMPDIR` at `RUNNER_TEMP`.

Rollback is deleting the variable or setting it to `"ubuntu-latest"`. A job already queued for
the self-hosted labels keeps waiting until it is cancelled and re-run. Required check names do
not change, so the rulesets need no edit either way.

## Documentation health

```bash
pnpm docs:check
```

The checker enforces:

- required docs, indexes, and agent configuration exist;
- the root agent map remains concise;
- maps (`AGENTS.md`, `README.md`) stay within 120 lines and leaves under `docs/` within
  300, counted at 100 columns; a doc listed in `DOC_LINE_ALLOWANCES` may shrink but not grow,
  and its entry must go once it fits. serp `main` asks for "a few hundred lines"
  (`docs/engineering/standards/agent-harness.md`); the numbers are from serp's docs-are-maps
  draft, not yet merged;
- local Markdown links resolve;
- lint commands are read-only;
- the root harness command surface remains available.

When it fails, repair the source document or command. Do not weaken the checker to
make stale documentation pass.

## Runtime legibility

```bash
pnpm agent:manifest
pnpm agent:doctor
pnpm agent:dev
pnpm agent:logs
pnpm agent:evidence
pnpm agent:ui:capture -- --name home --path /
```

`agent:manifest` prints URLs, ports, D1 and Wrangler state paths, log/artifact paths,
Git identity, Worker name, D1 binding, and runtime variables as JSON.

`agent:dev` initializes an isolated runtime when needed, builds the Worker, starts its
local D1 preview on the manifest port, and mirrors output into
`.runtime/<instance>/logs/runtime.log`. `agent:logs` returns the last 200 lines.
The agent runtime, canonical local D1 aliases, app preview, and Playwright all resolve
the same `d1/drizzle/` state below the manifest's D1 directory. They do
not inspect or migrate a legacy local state directory.

`agent:evidence` writes a timestamped JSON record containing the commit, dirty paths,
runtime identity, bindings, and validation commands. It does not claim those commands
passed; attach their actual output separately.

`agent:ui:capture` requires a running isolated Worker. It records the final DOM,
full-page screenshot, console events, failed requests, and response metadata under
the runtime artifact directory for a named route journey.

For broader browser behavior, use the existing Playwright smoke suite:

```bash
pnpm test:e2e:smoke
```

Playwright retains traces, screenshots, and video on failure. A running isolated
Worker may be supplied through `PLAYWRIGHT_BASE_URL` and
`PLAYWRIGHT_WEB_SERVER_COMMAND`.

## Worktree isolation

Create a worktree from a clean controlling checkout:

```bash
pnpm worktree:new -- feature-name
```

The command:

1. creates sibling worktree `best.serp.co-worktrees/feature-name`;
2. creates branch `codex/feature-name`;
3. installs the frozen lockfile;
4. allocates a deterministic, worktree-specific port;
5. creates isolated D1, Wrangler, cache, log, artifact, and browser directories;
6. writes `.runtime/manifest.json`;
7. prints the exact directory from which to open Codex.

Inside an existing manually created worktree:

```bash
pnpm worktree:init -- feature-name
pnpm worktree:doctor
```

Remove only a registered harness worktree:

```bash
pnpm worktree:destroy -- feature-name
```

Destroy preserves `codex/feature-name` for recovery. It refuses paths outside the
managed sibling directory. Runtime material is ignored by Git.

The local D1 guard reads the worktree manifest and passes that instance’s state path
to Wrangler. No worktree receives preview or production credentials automatically,
and `.env` files are deliberately not copied.

## Migration harness

The one-time import reads the legacy json-directory-template checkout in place:

```bash
pnpm migration:preflight -- \
  --source-root /absolute/path/to/json-directory \
  --site-id serp.co
pnpm migration:generate -- --source-root /absolute/path/to/json-directory --site-id serp.co
```

The preflight reports source hashes, counts, and integrity issues; the generator
writes the ignored `d1/artifacts/` SQL and must reproduce the committed parity
report. `pnpm migration:compare -- <origin>` compares sampled pages between
https://best.serp.co and a candidate origin.

## Issue-driven planning and review

GitHub Issues hold active specs, decision maps, implementation tickets, blocking
relationships, and acceptance evidence. Follow the planning workflow in
[`AGENTS.md`](../AGENTS.md), review the complete diff, run targeted checks, run the
full harness, collect runtime evidence where behavior changed, and record remaining
risk on the governing ticket before closing it.

## Harness maintenance

- Add a focused regression test when a failure exposes a missing guardrail.
- Keep checks deterministic, read-only, and local unless their name explicitly says
  otherwise.
- Give every custom failure a violated rule, why it matters, approved remediation,
  and documentation path.
- Garden docs when paths, commands, responsibilities, or external assumptions change.

Run the deterministic garden locally with `pnpm docs:garden`. The scheduled
`.github/workflows/harness-gardening.yml` repeats documentation, architecture,
migration-fixture, worktree-fixture, and fast-loop checks without write or deployment
permission.

## Known boundaries

- The repository serves exactly one site, best.serp.co; it is not a multi-site
  platform or starter.
- Named route capture is available; scripted before/after interaction sequences remain
  a future improvement.
- Local logs are file-queryable; a local metrics/tracing backend is not yet included.
- `pnpm format` is intentionally mutating. Review its diff; validation uses read-only
  lint instead.
