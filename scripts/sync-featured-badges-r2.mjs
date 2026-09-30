import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(rawArgs) {
  const args = [...rawArgs]
  const options = {
    apply: false,
    bucket: process.env.R2_BADGE_BUCKET || '',
    publicBaseUrl: process.env.R2_FEATURED_BADGE_PUBLIC_BASE_URL || '',
    remote: true,
    backupPrefix: '',
    confirmCloudWrite: false,
    mapPath: 'scripts/r2-featured-badge-assets.json',
    siteIds: []
  }

  while (args.length > 0) {
    const token = args.shift()

    if (token === '--') {
      continue
    }

    if (token === '--apply') {
      options.apply = true
      continue
    }
    if (token === '--confirm-cloud-write') {
      options.confirmCloudWrite = true
      continue
    }
    if (token === '--local') {
      options.remote = false
      continue
    }
    if (token === '--remote') {
      options.remote = true
      continue
    }
    if (token === '--bucket') {
      options.bucket = String(args.shift() || '').trim()
      continue
    }
    if (token === '--public-base-url') {
      options.publicBaseUrl = String(args.shift() || '').trim()
      continue
    }
    if (token === '--backup-prefix') {
      options.backupPrefix = String(args.shift() || '').trim()
      continue
    }
    if (token === '--map') {
      options.mapPath = String(args.shift() || '').trim()
      continue
    }
    if (token === '--site') {
      options.siteIds.push(String(args.shift() || '').trim())
      continue
    }
    if (token === '-h' || token === '--help') {
      printHelp()
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${token}`)
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-featured-badges-r2.mjs --bucket <name> --public-base-url <url> [options]

Options:
  --apply                  Execute Cloudflare R2 writes. Default is dry-run.
  --confirm-cloud-write    Required with --apply.
  --bucket <name>          R2 bucket name. Can also use R2_BADGE_BUCKET.
  --public-base-url <url>  Public CDN/R2 base URL, for example https://embeds.serp.co.
                           Can also use R2_FEATURED_BADGE_PUBLIC_BASE_URL.
  --remote                 Use remote R2 via Cloudflare API (default).
  --local                  Use local R2 storage instead of remote.
  --backup-prefix <path>   Backup key prefix in the bucket.
  --map <path>             JSON asset map (default: scripts/r2-featured-badge-assets.json)
  --site <site-id>         Only sync one site ID. Can be passed more than once.
  -h, --help               Show this help.

Map JSON format:
[
  {
    "siteId": "serp.software",
    "variant": "light",
    "key": "badge/featured-on-serp.software-light.svg",
    "source": "apps/serp.software/public/badge/featured-on-serp.software-light.svg",
    "contentType": "image/svg+xml",
    "width": 200,
    "height": 50
  }
]`)
}

function requireNonEmpty(value, message) {
  if (!value) {
    throw new Error(message)
  }
}

function validateKey(key) {
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some(part => part === '..' || part === '')
  ) {
    throw new Error(`Invalid R2 object key: ${key}`)
  }
}

function normalizePublicBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid public base URL: ${value}`)
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Public base URL must use https: ${value}`)
  }

  return url.toString().replace(/\/$/, '')
}

function publicUrlForKey(publicBaseUrl, key) {
  return `${publicBaseUrl}/${key
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')}`
}

function loadAssetMap(mapPath) {
  const resolved = path.resolve(process.cwd(), mapPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`R2 badge asset map not found: ${resolved}`)
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`R2 badge asset map must be a non-empty array: ${resolved}`)
  }

  return parsed.map((entry, index) => {
    const key = String(entry?.key || '').trim()
    const source = String(entry?.source || '').trim()
    const siteId = String(entry?.siteId || '').trim()
    const variant = String(entry?.variant || '').trim()

    validateKey(key)

    if (!source || !siteId || !['light', 'dark'].includes(variant)) {
      throw new Error(`Invalid R2 badge asset at index ${index}: ${JSON.stringify(entry)}`)
    }

    if (entry.contentType !== 'image/svg+xml' || entry.width !== 200 || entry.height !== 50) {
      throw new Error(`Invalid fixed badge contract at index ${index}: ${JSON.stringify(entry)}`)
    }

    return {
      key,
      siteId,
      sourcePath: path.resolve(process.cwd(), source),
      sourceRaw: source,
      variant
    }
  })
}

function assertBadgeSvgLooksReady(item) {
  if (!fs.existsSync(item.sourcePath)) {
    throw new Error(`Source file not found for key "${item.key}": ${item.sourcePath}`)
  }

  const svg = fs.readFileSync(item.sourcePath, 'utf8')
  const expectedTitlePrefix = '<title>Featured on '
  const hasAccessibleTitle =
    svg.includes(expectedTitlePrefix) || /<svg\b[^>]*\baria-label="Featured on [^"]+"/.test(svg)

  if (!/<svg\b[^>]*width="200"[^>]*height="50"/.test(svg)) {
    throw new Error(`Badge does not keep the 200x50 contract: ${item.sourceRaw}`)
  }
  if (
    !svg.includes('data-badge-logo="true"') &&
    !/<svg\b[^>]*\baria-hidden="true"/.test(svg) &&
    !/<g\b[^>]*\baria-hidden="true"/.test(svg)
  ) {
    throw new Error(`Badge is missing an inline SVG logo mark: ${item.sourceRaw}`)
  }
  if (svg.includes('textLength=') || svg.includes('lengthAdjust=')) {
    throw new Error(`Badge uses forced SVG text fitting: ${item.sourceRaw}`)
  }
  if (svg.includes('...') || svg.includes('…')) {
    throw new Error(`Badge appears to truncate text: ${item.sourceRaw}`)
  }
  if (!hasAccessibleTitle) {
    throw new Error(`Badge is missing its accessible title: ${item.sourceRaw}`)
  }
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function keyToLocalPath(rootDir, key) {
  return path.join(rootDir, ...key.split('/').filter(Boolean))
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function runWranglerCapture(args) {
  return spawnSync('npx', ['-y', 'wrangler', 'r2', 'object', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  })
}

function runWrangler(args, { apply }) {
  const cmd = ['-y', 'wrangler', 'r2', 'object', ...args]
  const printable = `npx ${cmd.join(' ')}`

  if (!apply) {
    console.log(`[dry-run] ${printable}`)
    return
  }

  const result = spawnSync('npx', cmd, {
    cwd: process.cwd(),
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${printable}`)
  }
}

function backupExistingObject({
  apply,
  backupObjectPath,
  item,
  localBackupFile,
  objectPath,
  storageModeFlag
}) {
  if (!apply) {
    runWrangler(['get', objectPath, storageModeFlag, '--file', localBackupFile], {
      apply
    })

    runWrangler(
      [
        'put',
        backupObjectPath,
        storageModeFlag,
        '--file',
        localBackupFile,
        '--content-type',
        'image/svg+xml'
      ],
      { apply }
    )
    return true
  }

  ensureDirForFile(localBackupFile)

  const getResult = runWranglerCapture([
    'get',
    objectPath,
    storageModeFlag,
    '--file',
    localBackupFile
  ])

  if (getResult.status !== 0) {
    console.log(`- existing object: not found; skipping backup for new key ${item.key}`)
    return false
  }

  runWrangler(
    [
      'put',
      backupObjectPath,
      storageModeFlag,
      '--file',
      localBackupFile,
      '--content-type',
      'image/svg+xml'
    ],
    { apply }
  )
  return true
}

const options = parseArgs(process.argv.slice(2))

requireNonEmpty(options.bucket, 'Missing bucket. Use --bucket <name> or set R2_BADGE_BUCKET.')
requireNonEmpty(
  options.publicBaseUrl,
  'Missing public base URL. Use --public-base-url <url> or set R2_FEATURED_BADGE_PUBLIC_BASE_URL.'
)

if (options.apply && !options.confirmCloudWrite) {
  throw new Error('Refusing to write to R2 without --confirm-cloud-write.')
}

const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl)
const assets = loadAssetMap(options.mapPath).filter(asset => {
  return options.siteIds.length === 0 || options.siteIds.includes(asset.siteId)
})

if (assets.length === 0) {
  throw new Error(
    `No R2 badge assets matched${options.siteIds.length ? ` site filter(s): ${options.siteIds.join(', ')}` : ''}.`
  )
}
const stamp = nowStamp()
const backupPrefix = options.backupPrefix || `_backup/featured-badges/${stamp}`
const localBackupRoot = path.resolve(process.cwd(), 'tmp', 'r2-featured-badge-backups', stamp)
const storageModeFlag = options.remote ? '--remote' : '--local'
const rollbackNotes = []

console.log('R2 featured badge sync plan:')
console.log(`- mode: ${options.remote ? 'remote' : 'local'}`)
console.log(`- apply: ${options.apply}`)
console.log(`- bucket: ${options.bucket}`)
console.log(`- public base URL: ${publicBaseUrl}`)
console.log(`- asset map: ${options.mapPath}`)
console.log(`- backup prefix: ${backupPrefix}`)
console.log(`- local backup dir: ${localBackupRoot}`)
console.log('')

for (const item of assets) {
  assertBadgeSvgLooksReady(item)
}

for (const item of assets) {
  const objectPath = `${options.bucket}/${item.key}`
  const backupObjectPath = `${options.bucket}/${backupPrefix}/${item.key}`
  const localBackupFile = keyToLocalPath(localBackupRoot, item.key)
  const publicUrl = publicUrlForKey(publicBaseUrl, item.key)

  console.log(`Processing ${item.siteId} ${item.variant}`)
  console.log(`- source: ${item.sourceRaw}`)
  console.log(`- key: ${item.key}`)
  console.log(`- public URL: ${publicUrl}`)

  const hasBackup = backupExistingObject({
    apply: options.apply,
    backupObjectPath,
    item,
    localBackupFile,
    objectPath,
    storageModeFlag
  })

  runWrangler(
    [
      'put',
      objectPath,
      storageModeFlag,
      '--file',
      item.sourcePath,
      '--content-type',
      'image/svg+xml'
    ],
    { apply: options.apply }
  )

  rollbackNotes.push(
    hasBackup
      ? `npx -y wrangler r2 object put ${objectPath} ${storageModeFlag} --file ${localBackupFile} --content-type image/svg+xml`
      : `No prior object was backed up for ${item.key}; rollback is to delete ${objectPath} if this was a first-time upload.`
  )

  console.log('')
}

console.log('Complete.')
console.log(options.apply ? 'Changes were applied.' : 'Dry-run only, no R2 changes applied.')
console.log('')
console.log('Rollback commands:')
for (const command of rollbackNotes) {
  console.log(`- ${command}`)
}
