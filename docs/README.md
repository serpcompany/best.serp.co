# Documentation index

| Document | Covers |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Runtime boundaries and responsibilities |
| [Data model](./DATA_MODEL.md) | D1 schema, eligibility, caching, the initial import |
| [Development](./DEVELOPMENT.md) | Local catalog, Worker preview, schema changes |
| [Submission flow](./SUBMISSION_FLOW.md) | Public intake, badge verification, review |
| [Email](./EMAIL.md) | Transactional email, environments, owner prerequisites |
| [Email templates](./EMAIL_TEMPLATES.md) | Every email, its trigger, recipient, and link |
| [Submitter dashboard](./ACCOUNT_DASHBOARD.md) | `/account`: statuses, edits, revisions, the badge panel |
| [Accounts](./ACCOUNTS.md) | Better Auth sign-in codes, admins, Cloudflare Access |
| [Admin panel](./ADMIN_PANEL.md) | `/admin` screens, decisions, the production-write exception |
| [Deploy runbook](./DEPLOY_RUNBOOK.md) | Environments, release flow, cutover checklist |
| [D1 recovery](./D1_RECOVERY.md) | Undoing a production write with D1 Time Travel |
| [Release guards](./RELEASE_GUARDS.md) | `db:*` commands by target, staging before production |
| [Harness](./HARNESS.md) | Validation loops, runtime evidence, worktrees |
| [Dependency security](./DEPENDENCY_SECURITY.md) | Production dependency audit |
| [Issue tracker](./agents/issue-tracker.md) | Agent issue workflow configuration |
| [Triage labels](./agents/triage-labels.md) | Label conventions |
| [Domain docs](./agents/domain.md) | Shared vocabulary configuration |

Root navigation and non-negotiable rules live in [`AGENTS.md`](../AGENTS.md). Planning
lives in GitHub Issues on `serpcompany/best.serp.co`.
