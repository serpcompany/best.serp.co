import { readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { freshMigrationNames } from './d1-drizzle-local'
import { readRemoteApplicationSnapshot } from './d1-preview-snapshot'
import { resolveSiteTarget } from './site-targets'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

async function main(): Promise<void> {
  const [phase, siteValue, output] = process.argv.slice(2)
  if (
    (phase !== 'preflight' &&
      phase !== 'source-preflight' &&
      phase !== 'source' &&
      phase !== 'parity') ||
    !siteValue ||
    !output
  )
    throw new Error(
      'Usage: d1-preview-measure.ts <preflight|source-preflight|source|parity> <site> <output.json>'
    )
  const siteId = resolveSiteTarget(siteValue).siteId
  const source = await readRemoteApplicationSnapshot(required('CLOUDFLARE_D1_PREVIEW_DATABASE_ID'))
  const target = await readRemoteApplicationSnapshot(
    required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')
  )
  const targetRows = Object.values(target.tables).reduce((sum, table) => sum + table.count, 0)
  const sourceRows = Object.values(source.tables).reduce((sum, table) => sum + table.count, 0)
  const exactParity = source.checksum === target.checksum
  if (phase === 'preflight' && targetRows !== 0 && !exactParity)
    throw new Error(
      'Replacement Preview target is neither empty nor an exact trusted prior receipt.'
    )
  if (phase === 'parity' && !exactParity)
    throw new Error('Source and replacement Preview D1 parity differ.')
  const sourcePrivateCounts = {
    capabilityRows: source.tables.listing_submissions.count,
    notificationSecretRows: source.tables.listing_submission_notifications.count,
    rateLimitRows: source.tables.listing_submission_rate_limits.count
  }
  const legacyMigrationNames = readdirSync(resolve('d1/migrations'))
    .filter(name => name.endsWith('.sql'))
    .sort()
  const legacyLedger = source.migrationNames.join('\0') === legacyMigrationNames.join('\0')
  if (phase === 'source-preflight' && Object.values(sourcePrivateCounts).some(count => count !== 0))
    throw new Error('Legacy Preview source contains private state and cannot be controlled.')
  if (
    phase === 'source' &&
    (sourceRows === 0 ||
      !legacyLedger ||
      Object.values(sourcePrivateCounts).some(count => count !== 0))
  )
    throw new Error('Controlled legacy Preview source schema/catalog/privacy verification failed.')
  const expectedLedger = freshMigrationNames()
  const freshLedger = target.migrationNames.join('\0') === expectedLedger.join('\0')
  if (phase === 'parity' && !freshLedger)
    throw new Error('Replacement Preview fresh migration ledger differs.')
  const privateCounts = {
    capabilityRows: target.tables.listing_submissions.count,
    notificationSecretRows: target.tables.listing_submission_notifications.count,
    rateLimitRows: target.tables.listing_submission_rate_limits.count
  }
  writeFileSync(
    resolve(output),
    `${JSON.stringify({ siteId, phase, source, target, sourceRows, sourcePrivateCounts, legacyLedger, targetInitiallyEmpty: targetRows === 0, trustedPriorReceipt: targetRows > 0 && exactParity, exactParity, freshLedger, privateCounts }, null, 2)}\n`
  )
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
