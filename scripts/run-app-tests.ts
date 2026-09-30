#!/usr/bin/env tsx

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

type PackageScripts = {
  test?: string
  'test:related'?: string
}

type AppPackage = {
  dir: string
  name: string
  scripts: PackageScripts
}

function getAppPackages(): AppPackage[] {
  const appsDir = path.join(process.cwd(), 'apps')

  if (!fs.existsSync(appsDir)) {
    return []
  }

  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(appsDir, entry.name)
      const packageJsonPath = path.join(dir, 'package.json')

      if (!fs.existsSync(packageJsonPath)) {
        return null
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        name?: string
        scripts?: PackageScripts
      }

      return {
        dir,
        name: packageJson.name ?? entry.name,
        scripts: packageJson.scripts ?? {},
      }
    })
    .filter((app): app is AppPackage => app !== null)
}

function runInApp(app: AppPackage, command: string, args: string[]): void {
  const result = spawnSync('pnpm', [command, ...args], {
    cwd: app.dir,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function runRelatedTests(files: string[]): void {
  const appPackages = getAppPackages()

  for (const app of appPackages) {
    if (!app.scripts['test:related']) {
      continue
    }

    const appPrefix = `${path.relative(process.cwd(), app.dir)}${path.sep}`
    const appFiles = files
      .filter(file => file.startsWith(appPrefix))
      .map(file => path.relative(app.dir, file))

    if (appFiles.length === 0) {
      continue
    }

    runInApp(app, 'test:related', appFiles)
  }
}

function runAllAppTests(): void {
  const appPackages = getAppPackages()

  for (const app of appPackages) {
    if (!app.scripts.test) {
      continue
    }

    runInApp(app, 'test', [])
  }
}

function main(): void {
  const files = process.argv.slice(2)

  if (files.length > 0) {
    runRelatedTests(files)
    return
  }

  runAllAppTests()
}

main()
