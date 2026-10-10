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
tests, the fixture seed's tests, D1 schema/publication contract tests,
and TypeScript checks. Each step stops on failure and prints the governing document.
The catalog contract also proves the injected Drizzle client retains per-statement
D1 telemetry and reviewed query-plan bounds.

### Full loop: the finish gate

```bash
pnpm check
# equivalent
pnpm harness:check
```

`pnpm check` is the finish gate (#179), and pull-request CI runs it. It adds `pnpm lint`
(read-only `biome check .` over the whole repository and the forbidden-link guard),
`pnpm db:check` (`drizzle-kit check` on the migration history), the repository tests,
Wrangler identity validation, a check that `apps/web/cloudflare-env.d.ts` is current for
`wrangler.jsonc` and the installed Wrangler (`pnpm cf-typegen` regenerates it), and the OpenNext
Worker build. It never writes files, never deploys, and never accesses a remote D1 database;
`pnpm lint:fix` and `pnpm format` are the commands that write.

Run a focused test while implementing, the fast loop at milestone boundaries, and the
full loop before a substantial completion claim.

## CI

[CI](./CI.md) covers `web.yml` (the required checks and the staging deploy), the repository
rulesets, and where CI jobs run (`CI_RUNNER_LABELS`).

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

`agent:dev` initializes an isolated runtime when needed, seeds its local D1 with fixtures
(`pnpm db:seed:local`) when it has none yet, builds the Worker, starts its local D1 preview on
the manifest port, and mirrors output into `.runtime/<instance>/logs/runtime.log`. `agent:logs` returns the last 200 lines.
The agent runtime, canonical local D1 aliases, app preview, and Playwright all resolve
the same `apps/web/drizzle/` state below the manifest's D1 directory. They do
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
Worker may be supplied through `PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_EXTERNAL_SERVER=1` (or
`PLAYWRIGHT_WEB_SERVER_COMMAND`). E2E data is the fixture seed: by default Playwright reseeds local
D1 and specs assert the seed's facts (`apps/web/e2e/seed-facts.ts`); only the smoke run against a
deployed Worker reads the live catalog ([E2E data](../apps/web/e2e/README.md#data)).

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
7. prints the seed command for its local D1 (`pnpm db:seed:local`) and the directory from
   which to open Codex.

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

## Migration harness (retired)

The one-time json-directory-template import and its harness (`migration:preflight`,
`migration:generate`, `migration:compare`, `migration:legacy-media`) are archived in
[`.archive/`](../.archive/README.md) (#315). `.archive/` is history: no check, lint, typecheck,
test, or workflow reads it.

## Sibling checkouts

A few repository tests compare a committed copy with its source in another repository's
checkout: `scripts/network-brands.test.ts` reads devinschumacher.com's brand list (`/brands/`,
#193) and serpcompany/serp's shared brand data. They look for the checkouts under
`SERP_REPOS_ROOT` (default `~/dev/repos`, for example `~/dev/repos/devinschumacher.com`), read
a commit the test or source constant records with `git show`, never a working tree, and skip
when the checkout or that commit is missing, as in CI. After updating a copy, record its new
source commit.

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
worktree-fixture, and fast-loop checks without write or deployment permission.

## Known boundaries

- The repository serves exactly one site, best.serp.co; it is not a multi-site
  platform or starter.
- Named route capture is available; scripted before/after interaction sequences remain
  a future improvement.
- Local logs are file-queryable; a local metrics/tracing backend is not yet included.
- `pnpm format` is intentionally mutating. Review its diff; validation uses read-only
  lint instead.
