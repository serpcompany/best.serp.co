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
The catalog contract also proves both Sites use one injected Site-bound Drizzle
client while retaining per-statement D1 telemetry and reviewed query-plan bounds.

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

Pull requests targeting protected `main` run `pr-review.yml`. Its repository policy,
type, test, Worker-build, and conditional browser jobs are required before merge.
The branch must be current with `main`, conversations must be resolved, and neither
administrators nor agents may bypass the pull-request requirement with a direct or
force push.

After a reviewed pull request merges, `main-validation.yml` runs the full loop again
on the exact resulting `main` revision. It supplies the before/after push revisions
to the changed-file policy and has read-only repository permission. It does not
deploy, use a protected environment, or access a remote D1 database. This post-merge
result proves the integrated revision independently; it does not replace the required
pre-merge checks.

## Documentation health

```bash
pnpm docs:check
```

The checker enforces:

- required docs, indexes, agent configuration, and repository skills exist;
- the root agent map remains concise;
- local Markdown links resolve;
- migration SOP phase headings remain intact;
- every active registry site appears in the core multisite operating documents;
- retired single-site assertions do not return;
- skill frontmatter supports progressive disclosure;
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

These root aliases select `serp.software`. The
`agent:pornvideodownloaders:{manifest,doctor,dev,logs,evidence}` aliases select the
second Worker. The underlying runtime command rejects a missing or unknown site.

Run `pnpm test:e2e:pornvideodownloaders` for the dedicated browser smoke suite. The
command explicitly selects the Porn Video Downloaders app, local D1 identity, port,
parity counts, representative listing, and representative category.

`agent:manifest` prints URLs, ports, D1 and Wrangler state paths, log/artifact paths,
Git identity, Worker name, D1 binding, and runtime variables as JSON.

`agent:dev` initializes an isolated runtime when needed, builds the Worker, starts its
local D1 preview on the manifest port, and mirrors output into
`.runtime/<instance>/logs/runtime.log`. `agent:logs` returns the last 200 lines.
The agent runtime, canonical local D1 aliases, app preview, and Playwright all resolve
the same Site-specific `d1/drizzle/` state below the manifest's D1 directory. They do
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

1. creates sibling worktree `directory-platform-d1-worktrees/feature-name`;
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

The preflight reads a legacy site in place and writes nothing unless an explicit
report path is supplied:

```bash
pnpm migration:preflight -- \
  --source-root /absolute/path/to/json-directory \
  --site-id example.com
```

It reports source hashes, listing/category counts, supporting files, slug/category
integrity, structural issues, and warnings. Passing means the source is coherent
enough to map; it does not activate or deploy a site.

Follow [the migration SOP](./MIGRATION_SOP.md) and the
[migration skill](../.agents/skills/migrate-json-directory-site/SKILL.md).
After a site is registered, use only its explicit local aliases or the canonical
`--site <site-id>` commands. When the migration is merged and evidenced, remove its
registered worktree with `pnpm worktree:destroy -- <name>` and delete the merged
branch when no recovery work remains.

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
- Update [the quality score](./QUALITY_SCORE.md) when evidence or known gaps change.
- Garden docs when paths, commands, responsibilities, or external assumptions change.

Run the deterministic garden locally with `pnpm docs:garden`. The scheduled
`.github/workflows/harness-gardening.yml` repeats documentation, architecture,
migration-fixture, worktree-fixture, and fast-loop checks without write or deployment
permission.

## Known boundaries

- The repository has two explicit production sites; it is not a product-neutral
  starter and has no default tenant.
- Named route capture is available; scripted before/after interaction sequences remain
  a future improvement.
- Local logs are file-queryable; a local metrics/tracing backend is not yet included.
- `pnpm format` is intentionally mutating. Review its diff; validation uses read-only
  lint instead.
