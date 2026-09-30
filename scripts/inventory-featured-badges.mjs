import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function listCurrentBadgeFiles() {
  const appsRoot = path.resolve(process.cwd(), 'apps');
  if (!fs.existsSync(appsRoot)) {
    return [];
  }

  return fs
    .readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const badgeDir = path.join(appsRoot, entry.name, 'public', 'badge');
      if (!fs.existsSync(badgeDir)) {
        return [];
      }

      return fs
        .readdirSync(badgeDir, { withFileTypes: true })
        .filter((badgeEntry) => badgeEntry.isFile())
        .map((badgeEntry) =>
          path
            .relative(process.cwd(), path.join(badgeDir, badgeEntry.name))
            .split(path.sep)
            .join('/')
        );
    })
    .sort();
}

function readR2TargetSources() {
  const mapPath = path.resolve(process.cwd(), 'scripts/r2-featured-badge-assets.json');
  if (!fs.existsSync(mapPath)) {
    return new Set();
  }

  const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    return new Set();
  }

  return new Set(
    parsed
      .map((entry) => String(entry?.source || '').trim())
      .filter(Boolean)
  );
}

const trackedBadgeFiles = runGit(['ls-files', 'apps/*/public/badge/*']).sort();
const currentBadgeFiles = listCurrentBadgeFiles();
const r2TargetSources = readR2TargetSources();
const trackedSet = new Set(trackedBadgeFiles);

const inventory = {
  generatedAt: new Date().toISOString(),
  trackedExistingBadgeFiles: trackedBadgeFiles,
  currentBadgeFiles,
  r2TargetBadgeFiles: currentBadgeFiles.filter((file) => r2TargetSources.has(file)),
  untrackedCurrentBadgeFiles: currentBadgeFiles.filter((file) => !trackedSet.has(file)),
};

const outputPath = path.resolve(
  process.cwd(),
  'scripts/featured-badge-inventory.json'
);
fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

console.log('Featured badge inventory:');
console.log(`- tracked existing badge files: ${inventory.trackedExistingBadgeFiles.length}`);
console.log(`- current badge files: ${inventory.currentBadgeFiles.length}`);
console.log(`- R2 target badge files: ${inventory.r2TargetBadgeFiles.length}`);
console.log(`- untracked current badge files: ${inventory.untrackedCurrentBadgeFiles.length}`);
console.log(`- wrote ${path.relative(process.cwd(), outputPath)}`);
