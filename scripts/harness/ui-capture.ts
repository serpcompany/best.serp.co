import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRuntimeManifest, repositoryRoot } from './worktree.ts'

interface CaptureOptions {
  name: string
  path: string
}

function parseArguments(args: string[]): CaptureOptions {
  const values = args.filter(value => value !== '--')
  const valueFor = (flag: string): string | undefined => {
    const index = values.indexOf(flag)
    return index === -1 ? undefined : values[index + 1]
  }
  const name = valueFor('--name') || 'home'
  const path = valueFor('--path') || '/'
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(name)) {
    throw new Error('Journey name must use lowercase letters, numbers, or hyphens.')
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Journey path must be an absolute application path beginning with one slash.')
  }
  return { name, path }
}

async function main(): Promise<void> {
  const root = repositoryRoot()
  const options = parseArguments(process.argv.slice(2))
  const manifest = readRuntimeManifest(root)
  if (!manifest) {
    throw new Error('No runtime manifest. Run pnpm worktree:init -- <name>, then pnpm agent:dev.')
  }
  try {
    const response = await fetch(manifest.webUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    throw new Error(
      `Runtime is not reachable at ${manifest.webUrl}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const captureDirectory = resolve(manifest.artifactDirectory, 'ui', options.name)
  mkdirSync(captureDirectory, { recursive: true })
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      'e2e',
      'exec',
      'playwright',
      'test',
      'tests/agent-capture.spec.ts',
      '--project=chromium'
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AGENT_CAPTURE_DIRECTORY: captureDirectory,
        AGENT_JOURNEY_NAME: options.name,
        AGENT_JOURNEY_PATH: options.path,
        PLAYWRIGHT_BASE_URL: manifest.webUrl,
        PLAYWRIGHT_WEB_SERVER_COMMAND: 'node -e "process.exit(1)"'
      },
      stdio: 'inherit'
    }
  )
  if (result.status !== 0) process.exitCode = result.status || 1
  else if (existsSync(resolve(captureDirectory, 'evidence.json'))) console.log(captureDirectory)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
