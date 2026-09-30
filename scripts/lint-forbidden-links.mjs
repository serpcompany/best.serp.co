import { existsSync, statSync } from 'node:fs'
import { ESLint } from 'eslint'
import { isProtectedListingSurface } from './eslint-rules/no-forbidden-listing-links.mjs'

const DEFAULT_PATTERNS = [
  'sites/**/*.{json,jsonc,md,mdx,ts,tsx}',
  'apps/*/app/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/components/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/lib/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/public/**/*.{html,json,js,txt,xml}',
  'packages/site-contract/src/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'packages/web-core/src/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'packages/content/data/**/*.{json,jsonc,md,mdx}'
]

function readOption(name) {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function readExplicitFiles() {
  const optionNames = new Set(['--site'])

  return process.argv.slice(2).filter((argument, index, allArguments) => {
    if (argument.startsWith('--')) {
      return false
    }

    return !optionNames.has(allArguments[index - 1])
  })
}

function existingProtectedFiles(paths) {
  return paths.filter(path => {
    if (!isProtectedListingSurface(path) || !existsSync(path)) {
      return false
    }

    return statSync(path).isFile()
  })
}

const siteId = readOption('--site')
const explicitFiles = existingProtectedFiles(readExplicitFiles())
const targets =
  explicitFiles.length > 0
    ? explicitFiles
    : hasFlag('--generated')
      ? [
          siteId
            ? `dist/sites/${siteId}/**/*.{html,json,js,txt,xml}`
            : 'dist/sites/**/*.{html,json,js,txt,xml}'
        ]
      : DEFAULT_PATTERNS
const eslint = new ESLint({
  errorOnUnmatchedPattern: false,
  overrideConfigFile: 'eslint.config.mjs'
})
const results = await eslint.lintFiles(targets)
const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)

if (output) {
  console.log(output)
}

const hasFailures = results.some(result => result.errorCount > 0 || result.fatalErrorCount > 0)

if (hasFailures) {
  process.exitCode = 1
}
