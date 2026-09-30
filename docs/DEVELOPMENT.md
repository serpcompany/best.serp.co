# Development

Install dependencies with Node 24 and `pnpm install`.

Generate a migration from the shared schema with the target-neutral, credential-free
command:

```bash
pnpm d1:generate
```

Review generated SQL—including D1 `STRICT`, trigger, check, collation, and
partial-index companion details—before committing it. Never use `drizzle-kit push`
for a shared environment.

For deterministic transfer from a reviewed, disposable legacy local D1 export into
an empty fresh local database, use `pnpm d1:replatform:local --` with explicit Site,
source/target paths, and registered local database IDs. The source is opened
read-only; the target path must remain inside the selected Site's harness-owned fresh
D1 state root and contain only the exact fresh schema with no application rows. See
[D1 replacement-database transfer](./D1_REPLATFORM.md) for the complete inventory,
guards, parity contract, and recovery behavior.

Initialize and verify the isolated local database:

```bash
pnpm d1:local:migrate
pnpm d1:local:import
pnpm d1:local:verify
```

Those aliases target `serp.software`. For the second site:

```bash
pnpm d1:pornvideodownloaders:local:migrate
pnpm d1:pornvideodownloaders:local:import
pnpm d1:pornvideodownloaders:local:verify
```

The aliases call the canonical guard with an explicit registered site:

```bash
pnpm tsx scripts/d1-local-guard.ts <migrate|import|verify|publish> \
  --site <site-id>
```

The underlying command has no default tenant and rejects unknown site IDs.
Both Sites' canonical commands, OpenNext previews, agent runtimes, and Playwright
defaults use their checked-in local Wrangler config, the `d1/drizzle/` migration
history, a fresh synthetic local database ID, and the same isolated state root. A
second migration and a repeated initial import are no-ops after exact parity is
established. The old local state is not read or upgraded; discard it if it is no
longer needed.

`verify` recomputes canonical row checksums for all 17 application tables against the
reviewed bootstrap artifacts; the publication checksum and summary counts are not a
substitute for that proof. Direct app `preview:worker` commands also pass through the
canonical config validator before opening the same state, so they cannot bypass the
Site, app-path, asset-path, fresh-ID, or migration-history guards.

Start the local OpenNext Worker:

```bash
pnpm dev
```

Use `pnpm preview:pornvideodownloaders` for the
`pornvideodownloaders.com` Worker.

The local guard pins the local Worker name, D1 name, fresh synthetic D1 ID,
`d1/drizzle/` migration directory, Wrangler config, isolated state path, and
`--local` mode. It refuses to select the legacy migration history or overwrite a
catalog with a different publication checksum. Checked-in Worker templates are grouped by site under
`configs/wrangler/<site-id>/`; generated state remains outside that source area.

For code changes, run:

```bash
pnpm harness:fast
pnpm harness:check
```

Add public catalog queries once to `packages/data-ops/`, not to a site adapter or
Client Component. Keep `apps/<site-id>/lib/catalog/repository.ts` as the server-only
binding, site-identity, cache, observer, and request-deduplication adapter. A future
site must instantiate the shared operations rather than copy SQL.

Add Submission database behavior once to `packages/data-ops/src/submissions.ts`.
Site Submission adapters may only acquire and validate the OpenNext `DB` binding,
runtime environment, and explicit Site identity. Protected approval/notifier scripts
may consume pure plans from `submission-plans.ts`, but credentials and remote API
execution must remain in those guarded scripts. Every conditional transition and
matching event/audit write belongs in one guarded D1 batch. Keep public/local-host
URL policy in `packages/data-ops/src/public-url.ts`; intake and badge verification
must use the same environment-neutral validator.

Construct the shared Site-explicit Drizzle client with `createSiteDatabase` before
creating Catalog operations. Prefer schema-backed Drizzle builders. Typed,
parameterized raw SQL is reserved for statements whose D1 metadata or reviewed
query plan cannot be preserved by the builder; those statements still execute
through the shared client and must keep their telemetry and benchmark coverage.

Run the focused shared contract and scan benchmark with:

```bash
pnpm --filter @serpdirectory/data-ops test
pnpm --filter @serpdirectory/data-ops benchmark
```

Add justified schema changes to the shared schema and generate a reviewed fresh D1
migration. Do not edit the released legacy `d1/migrations/0001`-`0009` lineage. Use a
reviewed publication manifest for catalog changes. Do not add a default site selection
or a file-backed catalog path.

For an agent-readable isolated runtime:

```bash
pnpm worktree:init -- task-name
pnpm agent:manifest
pnpm agent:dev
```

The default aliases above are explicit `serp.software` commands. Use the
`agent:pornvideodownloaders:*` variants for the second Worker.

See [HARNESS.md](./HARNESS.md) for worktree, log, evidence, and review workflows.
Inspecting another legacy site starts with [MIGRATION_SOP.md](./MIGRATION_SOP.md);
the preflight is read-only; activation still requires the complete per-site runtime,
data, release, and isolation work.
