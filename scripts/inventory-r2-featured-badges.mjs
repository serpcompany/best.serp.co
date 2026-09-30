import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(rawArgs) {
  const args = [...rawArgs];
  const options = {
    bucket: process.env.R2_BADGE_BUCKET || '',
    mapPath: 'scripts/r2-featured-badge-assets.json',
  };

  while (args.length > 0) {
    const token = args.shift();

    if (token === '--') {
      continue;
    }
    if (token === '--bucket') {
      options.bucket = String(args.shift() || '').trim();
      continue;
    }
    if (token === '--map') {
      options.mapPath = String(args.shift() || '').trim();
      continue;
    }
    if (token === '-h' || token === '--help') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.bucket) {
    throw new Error('Missing bucket. Use --bucket <name> or set R2_BADGE_BUCKET.');
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/inventory-r2-featured-badges.mjs --bucket <name>

Options:
  --bucket <name>  R2 bucket name. Can also use R2_BADGE_BUCKET.
  --map <path>     R2 target asset map (default: scripts/r2-featured-badge-assets.json)
  -h, --help       Show this help.

The script is read-only. It probes expected badge keys and writes
scripts/featured-badge-r2-inventory.json.`);
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadR2MapKeys(mapPath) {
  const resolved = path.resolve(process.cwd(), mapPath);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => String(entry?.key || '').trim())
    .filter(Boolean);
}

function filenameFromBadgePath(filePath) {
  return filePath.split('/').at(-1);
}

function buildCandidateKeys(mapPath) {
  const keys = new Set(['serp-dr-small.svg']);

  for (const key of loadR2MapKeys(mapPath)) {
    keys.add(key);
  }

  for (const filePath of runGit(['ls-files', 'apps/*/public/badge/*'])) {
    const filename = filenameFromBadgePath(filePath);
    if (!filename) {
      continue;
    }

    keys.add(filename);
    keys.add(`badge/${filename}`);
  }

  return [...keys].sort();
}

function objectExists(bucket, key) {
  const result = spawnSync(
    'npx',
    ['-y', 'wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }
  );

  return result.status === 0;
}

const options = parseArgs(process.argv.slice(2));
const candidateKeys = buildCandidateKeys(options.mapPath);
const existingKeys = [];
const missingKeys = [];

console.log(`Probing ${candidateKeys.length} candidate R2 badge key(s) in ${options.bucket}...`);

for (const key of candidateKeys) {
  if (objectExists(options.bucket, key)) {
    existingKeys.push(key);
    console.log(`  exists  ${key}`);
  } else {
    missingKeys.push(key);
  }
}

const inventory = {
  bucket: options.bucket,
  generatedAt: new Date().toISOString(),
  candidateKeys,
  existingKeys,
  missingKeys,
};
const outputPath = path.resolve(
  process.cwd(),
  'scripts/featured-badge-r2-inventory.json'
);

fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

console.log('');
console.log('R2 featured badge inventory:');
console.log(`- bucket: ${options.bucket}`);
console.log(`- candidate keys probed: ${candidateKeys.length}`);
console.log(`- existing keys: ${existingKeys.length}`);
console.log(`- missing keys: ${missingKeys.length}`);
console.log(`- wrote ${path.relative(process.cwd(), outputPath)}`);
