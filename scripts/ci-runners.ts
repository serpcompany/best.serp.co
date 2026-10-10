/**
 * Where CI jobs run (docs/ci.md#runners).
 *
 * A routed job runs where the repository variable `CI_RUNNER_LABELS` points: JSON, either a
 * label array such as `["self-hosted","linux","x64"]` or a quoted runner name. While the
 * variable is unset the job runs on `ubuntu-latest`. A pull request whose head repository is
 * not this repository always runs on `ubuntu-latest`, whatever the variable says, so a
 * self-hosted runner never executes a fork's code; a deleted head repository compares as
 * different and fails safe. `github.event.pull_request` is checked first so that pushes,
 * schedules, and dispatches, which carry no pull request, still follow the variable.
 *
 * Every other job, including E2E and anything holding credentials or deploying, is pinned to
 * the GitHub-hosted runner. scripts/ci-runner-workflows.test.ts enforces both lists.
 */

export const githubHostedRunner = 'ubuntu-latest'

export const routedRunsOn = `\${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || fromJSON(vars.CI_RUNNER_LABELS || '"ubuntu-latest"') }}`

/** `<workflow file>:<job id>` for every job that follows `CI_RUNNER_LABELS`. */
export const routedJobs = [
  'dependency-security.yml:audit',
  'harness-gardening.yml:deterministic-audit',
  'labels.yml:triage',
  'link-checker.yml:links-checker',
  'web.yml:check'
]
