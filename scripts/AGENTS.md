# Script rules

Scripts are repository boundaries and must fail with remediation-oriented messages.

- Parse CLI arguments and external files before acting.
- Default inspection and planning commands to read-only behavior.
- Separate mutating commands from checks and name them explicitly.
- Pin local D1 commands to the local Wrangler identity and isolated state path.
- Never add a local route to preview or production D1.
- Export pure functions where a deterministic unit test can exercise the contract.
- Do not hide subprocess output or convert a failed check into a warning.

Migration scripts may read catalog files only from an explicit external source path.
They must not copy those files into this repository or become runtime adapters.

See [Harness](../docs/HARNESS.md) and [Migration SOP](../docs/MIGRATION_SOP.md).
