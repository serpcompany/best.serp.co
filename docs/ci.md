# CI

What GitHub Actions runs for this repository: the checks on pull requests and pushes, the staging
deploy, the rulesets, and the runners. Release-time guards are in
[Release guards](./release-guards.md); the release steps are in the
[deploy runbook](./deploy-runbook.md#workflows).

One workflow, `web.yml` (#182), checks pull requests into `staging` (the base branch) and `main`
(`hotfix-*` branches only), checks every push to them, and deploys staging:

- `changes` finds whether a pull request changed anything but `docs/` and Markdown. A
  documentation-only pull request runs `pnpm docs:check` and the tests (they read docs too) and
  skips the build and E2E. A push always runs the full checks on the tree it deploys, and if
  `changes` fails, `check` and `e2e` still run everything, since a skipped required job passes.
- `check` runs `pnpm check`. On a push the staging deploy (or Deploy Production) builds the
  Worker, so `check` skips its build there (`HARNESS_SKIP_BUILD=1`): each commit builds once.
- `e2e` runs Playwright and uploads a `passed-e2e-<tree>` receipt. A push whose tree a pull
  request already tested finds the receipt and skips the suite; a lookup error runs it. On a
  draft pull request `e2e` fails in its first step ("draft: mark ready to run e2e") rather than
  skipping, since a skipped required job passes: a draft force-pushed and then marked ready
  showed CLEAN with no E2E when the concurrency group cancelled the `ready_for_review` run and
  the surviving `synchronize` run skipped it (#246). The step reads the run's event, so a re-run
  of a run that started on a draft fails again; push a commit, or convert the pull request to
  draft and mark it ready again.
- `e2e` runs a resource probe beside Playwright (`scripts/e2e-resource-probe.sh`, #393): every
  15 s it prints memory, swap, memory pressure, OOM kills, disk and the processes holding the most
  memory into the Playwright step's log, which keeps them even when GitHub shuts the runner down and
  skips the later steps. The job then reports the peaks (and any kernel OOM kills) in its summary
  and uploads the samples as `e2e-resource-probe-<attempt>`; neither step can fail `e2e`.
- `tip` runs on a push or dispatch on `staging` once `check` and `e2e` pass, and starts
  `deploy-staging` only if the commit is still the `staging` head, so an older commit (a re-run)
  doesn't build for nothing. A failed lookup fails the job.
- `deploy-staging` waits in `deploy-best-serp-co-staging` with `queue: max`, so nothing joining
  cancels a waiting deploy or catalog publication. It builds, checks the tip again (a partial
  re-run reuses the old `tip` output), then runs the staging release steps
  ([deploy runbook](./deploy-runbook.md#workflows)).
- Right before its Playwright smoke, `deploy-staging` waits until the deployed Worker is ready on
  the workers.dev host the smoke uses (`scripts/worker-readiness.ts`, #417): five probes of
  `/robots.txt` in a row answered 200 by the deployed version in under 2 s, within 3 minutes,
  each one logged. A latency probe (`scripts/smoke-latency-probe.sh`) runs beside the suite, and
  the step after it reports the slow samples without ever failing the job
  ([Staging smoke readiness](#staging-smoke-readiness)).
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
([Release guards](./release-guards.md#promotion)).

After a pull request merges, the push run checks the exact resulting revision again; when it
merged up to date its tree is the one the pull request tested, so only the quick checks repeat.
`deploy-production.yml` releases each `main` push after reviewer approval, and only a tree
`deploy-staging` verified (see [Release guards](./release-guards.md#staging-before-production)).

## Staging smoke readiness

Three staging smokes on 2026-10-11 (runs 38116684327, 38163330039 and 38172083196) timed out on
page loads and API requests (#417). Runs 38163330039 and 38172083196 passed when the deploy job
was re-run, with no code change. Run 38116684327 was never re-run: the next staging deploy
(run 38117027619, #377), whose tree included that commit, passed its smoke.

What the three failures showed:

- **Not a window after the deploy.** The HTTP gates had already had three answers in a row from
  the new version before each smoke, and the timeouts ran from the first tests to the last,
  4.5 to 6.4 minutes after the deploy.
- **Not the Worker.** During run 38163330039's smoke (18:32–18:40Z), Workers Observability
  logged 1,154 invocations with wall time p50 10 ms and p99 535 ms. Most requests that timed out
  after 15 or 30 s never reached the Worker.
- **The runner's path.** All three failing smokes ran on GitHub-hosted runners in Iowa (Azure
  Central US; Observability's `cf.region`), whose requests entered Cloudflare at MSP, at MEM
  and DTW, and at MEM and MCI. The 17 passing smokes checked between 2026-10-10 17:06Z and
  2026-10-11 20:43Z, the two re-runs among them, came from Virginia (IAD), Arizona (LAX),
  California, Washington, Ohio and Illinois, and one from Iowa that entered at ORD.

So the stalls sat between those runners and Cloudflare, outside this repository. What CI does:

- The readiness wait runs just before the smoke, and the HTTP gates wait the same way after each
  staging and production deploy, with three answers in a row (`waitForWorkerReadiness` in
  `scripts/d1-preview-http-gates.ts`). A runner whose path stays slow for 3 minutes fails there,
  with every probe's time in the log, instead of in minutes of timeouts. Re-run the job: a new
  runner usually takes another path. In Deploy Production the new Worker is already live by
  then, so follow [Production gates not ready](./deploy-runbook.md#production-gates-not-ready)
  instead. Each probe gets only the time left before the deadline, and an answer after it doesn't
  count, so the wait never outlasts its 3 minutes.
- The latency probe times `/cdn-cgi/trace`, which Cloudflare answers without the Worker, and
  `/robots.txt`, which runs it, every 5 s with curl's phases and the colo that answered. A slow
  `edge` sample means the network path; a fast edge beside a slow `worker` first byte means the
  Worker or its start-up. The report is in the job summary; compare it with Observability.
  Stopping the probe lets its request in flight finish (curl gives up after 30 s) and records it,
  since a slow or failed request is the sample the report needs most; the smoke step waits for it.
- The smoke keeps two Playwright workers. The stalls hit single requests whatever the load, and
  one worker took 106 s against 47 s for two (the same suite against staging, run from a laptop
  on 2026-10-11): about a minute more per deploy for no expected gain.

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
| Production Dependency Audit, Harness Gardening, Label PRs, Links Checker | PR Issue Link (serp's file, unchanged), Deploy Production, Publish D1 Catalog, Review D1 Submission, Notify Verified D1 Submissions, Check Listing Media Health, Submit GSC Sitemaps |

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

