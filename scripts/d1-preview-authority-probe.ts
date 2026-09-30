import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createReplatformPreviewCapability } from '@serpdirectory/data-ops/replatform-preview-capability'
import { BADGE_VERIFIER_USER_AGENT } from '@serpdirectory/web-core/forms/submission-contract'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

async function status(url: string, badge: boolean): Promise<number> {
  return (await fetch(url, { headers: badge ? { 'User-Agent': BADGE_VERIFIER_USER_AGENT } : {} }))
    .status
}

async function main(): Promise<void> {
  const [operation, journalPath] = process.argv.slice(2)
  if ((operation !== 'before' && operation !== 'after') || !journalPath)
    throw new Error('Usage: d1-preview-authority-probe.ts <before|after> <journal.json>')
  if (operation === 'before') {
    const base = new URL(required('PREVIEW_BASE_URL'))
    const token = await createReplatformPreviewCapability({
      expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
      runId: required('REPLATFORM_PREVIEW_RUN_ID'),
      secret: required('REPLATFORM_PREVIEW_SIGNING_SECRET'),
      slug: base.hostname
    })
    const badge = new URL('/api/replatform/badge-fixture', base)
    badge.searchParams.set('slug', base.hostname)
    badge.searchParams.set('token', token)
    const attestation = new URL('/api/replatform/attestation', base)
    attestation.searchParams.set('token', token)
    const evidence = {
      badgeUrl: badge.toString(),
      attestationUrl: attestation.toString(),
      expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
      beforeBadgeStatus: await status(badge.toString(), true),
      beforeAttestationStatus: await status(attestation.toString(), false)
    }
    if (evidence.beforeBadgeStatus !== 200 || evidence.beforeAttestationStatus !== 200)
      throw new Error('Transient Preview authority was not valid before cleanup.')
    writeFileSync(resolve(journalPath), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    return
  }
  const evidence = JSON.parse(readFileSync(resolve(journalPath), 'utf8')) as Record<string, unknown>
  if (Number(evidence.expiresAt) <= Math.floor(Date.now() / 1000))
    throw new Error('Authority cleanup probe token expired before negative verification.')
  const afterBadgeStatus = await status(String(evidence.badgeUrl), true)
  const afterAttestationStatus = await status(String(evidence.attestationUrl), false)
  if (afterBadgeStatus !== 404 || afterAttestationStatus !== 404)
    throw new Error('Transient Preview authority remains usable after cleanup.')
  writeFileSync(
    resolve(journalPath),
    `${JSON.stringify({ ...evidence, afterBadgeStatus, afterAttestationStatus }, null, 2)}\n`,
    { mode: 0o600 }
  )
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
