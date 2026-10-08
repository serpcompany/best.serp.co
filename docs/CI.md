# CI

What GitHub Actions runs for this repository: the checks on pull requests and pushes, the staging
deploy, the rulesets, and the runners. Release-time guards are in
[Release guards](./RELEASE_GUARDS.md); the release steps are in the
[deploy runbook](./DEPLOY_RUNBOOK.md#workflows).

One workflow, `web.yml` (#182), checks pull requests into `staging` (the base branch) and `main`
(`hotfix-*` branches only), checks every push to them, and deploys staging:

- `changes` finds whether a pull request changed anything but `docs/` and Markdown. A
  documentation-only pull request runs `pnpm docs:check` and the tests (they read docs too) and
  skips the build and E2E. A push always runs the full checks on the tree it deploys, and if
  `changes` fails, `check` and `e2e` still run everything, since a skipped required job passes.
- `check` runs `pnpm check`. On a push the staging deploy (or Deploy Production) builds the
  Worker, so `check` skips its build there (`HARNESS_SKIP_BUILD=1`): each commit builds once.
- `e2e` runs Playwright and uploads a `passed-e2e-<tree>` receipt. A push whose tree a pull
  request already tested finds the receipt and skips the suite; a lookup error runs it. Draft
  pull requests skip `e2e` until they are marked ready for review.
- `tip` runs on a push or dispatch on `staging` once `check` and `e2e` pass, and starts
  `deploy-staging` only if the commit is still the `staging` head, so an older commit (a re-run)
  doesn't build for nothing. A failed lookup fails the job.
- `deploy-staging` waits in `deploy-best-serp-co-staging` with `queue: max`, so nothing joining
  cancels a waiting deploy or catalog publication. It builds, checks the tip again (a partial
  re-run reuses the old `tip` output), then runs the staging release steps
  ([deploy runbook](./DEPLOY_RUNBOOK.md#workflows)).
- `changes` compares with `--no-renames`, so code moved into `docs/` still counts as code.

Three branch rulesets apply: `staging` (24491650), `main pull requests` (24716331), and `main`
(24391799), which blocks deletion and force pushes for everyone:

- Every change needs a pull request: squash-merged into `staging` (except the merge commit
  that brings a hotfix back from `main`) and into `main` for hotfixes. The one exception is
  the owner's fast-forward promotion of `staging` (`pnpm release:promote`), a bypass push.
- `check` and `e2e` from `web.yml` are `staging`'s required checks, and a pull request must be
  up to date with `staging` to merge. `main pull requests` still requires the old
  `pr-review.yml` checks until the owner swaps them at the next promotion. `issue-link` from
  `pr-issue-link.yml` (serp's workflow, copied unchanged) runs on every pull request and fails
  one that closes no issue; it is not a required check yet. Neither required job is
  path-filtered, because a skipped job satisfies a required check. `issue-link` skips bot PRs
  and PRs whose head and base are `staging` and `main`; a merge-back from any other branch needs
  a `No issue: <reason>` line.
- Force pushes and branch deletion are blocked, with no bypass.

The rulesets require no approving review and no resolved conversations. Admins can bypass
`staging` only through a pull request. The owner's fast-forward promotion
(`pnpm release:promote`, #171) is a direct push to `main`, and a bypass covers a whole ruleset,
so `main`'s pull request and check rules sit in `main pull requests`, which admins may bypass,
and `main` keeps the deletion and force-push blocks nobody can bypass. Agents never push. Rulesets cannot restrict
a pull request's head branch, so `check` fails a pull request into `main` whose
head is not a `hotfix-*` branch. That only catches mis-targeted pull requests; Deploy
Production's tree check is the control. Agents never merge: the owner approves every merge
([Release guards](./RELEASE_GUARDS.md#promotion)).

After a pull request merges, the push run checks the exact resulting revision again; when it
merged up to date its tree is the one the pull request tested, so only the quick checks repeat.
`deploy-production.yml` releases each `main` push after reviewer approval, and only a tree
`deploy-staging` verified (see [Release guards](./RELEASE_GUARDS.md#staging-before-production)).

## Runners

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
| Web: check | Web: changes, e2e (installs Playwright browsers), tip, deploy-staging (credentials, Playwright smoke) |
| Production Dependency Audit, Harness Gardening, Label PRs, Links Checker | PR Issue Link (serp's file, unchanged), Deploy Production, Bootstrap Production D1, Publish D1 Catalog, Review D1 Submission, Notify Verified D1 Submissions, Check Listing Media Health, Submit GSC Sitemaps |

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

