/**
 * Promotes `staging` to `main` by fast-forward (#171; serp
 * docs/engineering/standards/git-workflow.md, Promoting Staging to Production), so `main`
 * receives exactly the squash commits Deploy Staging verified. Owner only: agents never run it.
 *
 *   pnpm release:promote
 *
 * It fetches `origin`, then refuses unless
 * - `origin/main` is an ancestor of `origin/staging` (after a hotfix, merge `main` into
 *   `staging` with a merge-commit pull request first; docs/RELEASE_GUARDS.md#hotfixes),
 * - Deploy Staging verified the tip of `origin/staging` (`assertStagingVerified`, the check
 *   Deploy Production repeats before it migrates or deploys), and
 * - the owner, at a terminal, types the first 12 characters of that commit.
 *
 * Then it pushes that exact commit to `main` (`git push origin <sha>:refs/heads/main`, never
 * forced, so git accepts only a fast-forward). The push runs Deploy Production, which waits for
 * the `production` reviewers. It needs the owner's bypass of the `main` ruleset's pull request
 * rule; every other change to `main` still needs a pull request.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  assertStagingVerified,
  type StagingVerification,
  type StagingVerificationOptions,
  stagingWorkflow
} from './staging-verification'

export interface GitResult {
  status: number
  stderr: string
  stdout: string
}

export interface PromoteDependencies {
  /** Asks the owner a question at the terminal and resolves with the answer. */
  confirm(question: string): Promise<string>
  git(args: readonly string[]): Promise<GitResult>
  log(message: string): void
  /** A GitHub token with actions: read and contents: read, for the staging check. */
  token(): Promise<string | undefined>
  verify(options: StagingVerificationOptions): Promise<StagingVerification>
}

const fullSha = /^[0-9a-f]{40}$/u
/** The characters of the staging commit the owner types to confirm. */
export const CONFIRM_LENGTH = 12

async function gitOrThrow(deps: PromoteDependencies, args: readonly string[]): Promise<string> {
  const result = await deps.git(args)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

async function commitOf(deps: PromoteDependencies, ref: string): Promise<string> {
  const sha = await gitOrThrow(deps, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!fullSha.test(sha)) throw new Error(`git rev-parse ${ref} returned ${JSON.stringify(sha)}.`)
  return sha
}

/**
 * Fast-forwards `main` to the verified head of `staging`, or throws a refusal. Resolves with
 * `up-to-date` when `main` already is that commit.
 */
export async function promoteStaging(
  deps: PromoteDependencies
): Promise<'promoted' | 'up-to-date'> {
  await gitOrThrow(deps, ['fetch', '--quiet', 'origin', 'main', 'staging'])
  const main = await commitOf(deps, 'refs/remotes/origin/main')
  const staging = await commitOf(deps, 'refs/remotes/origin/staging')
  if (main === staging) {
    deps.log(
      `main is already at staging (${staging.slice(0, CONFIRM_LENGTH)}); nothing to promote.`
    )
    return 'up-to-date'
  }

  const ancestry = await deps.git(['merge-base', '--is-ancestor', main, staging])
  if (ancestry.status === 1) {
    throw new Error(
      `Refusing: main (${main.slice(0, CONFIRM_LENGTH)}) has commits staging lacks, so main cannot fast-forward. Merge main into staging with a pull request merged with "Create a merge commit", let Deploy Staging verify it, then promote again (docs/RELEASE_GUARDS.md#hotfixes).`
    )
  }
  if (ancestry.status !== 0) {
    throw new Error(
      `git merge-base --is-ancestor failed (exit ${ancestry.status}): ${ancestry.stderr.trim()}`
    )
  }

  let verified: StagingVerification
  try {
    verified = await deps.verify({ sha: staging, token: await deps.token() })
  } catch (error) {
    throw new Error(`Refusing: ${error instanceof Error ? error.message : String(error)}`)
  }

  const commits = await gitOrThrow(deps, [
    'log',
    '--oneline',
    '--no-decorate',
    `${main}..${staging}`
  ])
  deps.log(
    [
      `${stagingWorkflow.name} verified ${staging.slice(0, CONFIRM_LENGTH)}: ${verified.runUrl} (attempt ${verified.runAttempt}).`,
      `Fast-forwarding main from ${main.slice(0, CONFIRM_LENGTH)} adds:`,
      commits,
      'The push runs Deploy Production, which waits for the production reviewers.'
    ].join('\n')
  )
  const expected = staging.slice(0, CONFIRM_LENGTH)
  const answer = (await deps.confirm(`Type ${expected} to fast-forward main to it: `)).trim()
  if (answer !== expected) {
    throw new Error('Refusing: the confirmation did not match; main is unchanged.')
  }

  const push = await deps.git(['push', 'origin', `${staging}:refs/heads/main`])
  if (push.status !== 0) {
    throw new Error(
      `git push to main failed (exit ${push.status}): ${push.stderr.trim()}\nA ruleset rejection means your account is not a bypass actor for pushes on the main ruleset; a non-fast-forward rejection means main moved, so run this again.`
    )
  }
  deps.log(`main is now ${staging}. Deploy Production is running for it.`)
  return 'promoted'
}

/** The promotion needs a person at a terminal: a script or agent cannot confirm it. */
export function assertInteractive(stdinIsTty: boolean | undefined): void {
  if (!stdinIsTty) {
    throw new Error(
      "Refusing: pnpm release:promote is the owner's command and needs a terminal to confirm. Agents never run it."
    )
  }
}

function runGit(args: readonly string[]): Promise<GitResult> {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return Promise.resolve({
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? ''
  })
}

async function githubToken(): Promise<string | undefined> {
  const configured = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (configured) return configured
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

async function askAtTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await terminal.question(question)
  } finally {
    terminal.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  Promise.resolve()
    .then(() => {
      assertInteractive(process.stdin.isTTY)
      return promoteStaging({
        confirm: askAtTerminal,
        git: runGit,
        log: message => {
          console.log(message)
        },
        token: githubToken,
        verify: options => assertStagingVerified({ ...options, apiUrl: process.env.GITHUB_API_URL })
      })
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
