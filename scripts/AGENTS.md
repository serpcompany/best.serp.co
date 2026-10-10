# Script rules

Scripts are repository boundaries and must fail with remediation-oriented messages.

- Parse CLI arguments and external files before acting.
- Default inspection and planning commands to read-only behavior.
- Separate mutating commands from checks and name them explicitly.
- Read the single deployment target from `project.ts` and the public site shape from
  `apps/web/src/lib/site`; never reintroduce `--site` arguments or site IDs.
- Pin local D1 commands to the local Wrangler identity and isolated state path.
- Never add a local route to staging or production D1.
- Export pure functions where a deterministic unit test can exercise the contract.
- Do not hide subprocess output or convert a failed check into a warning.

No script reads the real catalog as local or test data: local D1 is the fixture seed, and the
one-time migration tooling is archived in `.archive/` (#315). Catalog checks read an
environment's D1 read-only (`pnpm media:health`, `pnpm catalog:domains`).

See [Harness](../docs/HARNESS.md) and [Data model](../docs/DATA_MODEL.md).
