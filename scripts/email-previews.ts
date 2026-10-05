/**
 * Renders every registered email (apps/web/lib/email/registry.ts) with the mockup sample data
 * to a directory, for review against serpcompany/best.serp.co#70 screen 15. Read-only: it never
 * sends anything and touches no database.
 *
 *   pnpm tsx scripts/email-previews.ts <output directory> [local|staging|production]
 *
 * Writes `<id>[-<n>].html` and `.txt` per sample, plus `index.html` linking them all.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMAIL_SAMPLES, renderAppEmail } from '../apps/web/lib/email/emails/samples'
import { parseSiteEnvironment } from '../apps/web/lib/environment/site-environment'

function escapeText(value: string): string {
  return value.replace(/[&<>"]/gu, character => `&#${character.charCodeAt(0)};`)
}

function main(): void {
  const [outputArgument, environmentArgument = 'production'] = process.argv
    .slice(2)
    .filter(argument => argument !== '--')
  const environment = parseSiteEnvironment(environmentArgument)
  if (!outputArgument || !environment) {
    throw new Error(
      'Usage: pnpm tsx scripts/email-previews.ts <output directory> [local|staging|production]'
    )
  }
  const output = resolve(outputArgument)
  mkdirSync(output, { recursive: true })
  const entries: string[] = []
  for (const [templateId, samples] of Object.entries(EMAIL_SAMPLES)) {
    samples.forEach((sample, index) => {
      const name = samples.length > 1 ? `${templateId}-${index + 1}` : templateId
      // Each sample's input matches its template id; the record type keeps them paired.
      const email = renderAppEmail(
        templateId as keyof typeof EMAIL_SAMPLES,
        sample.input as never,
        {
          environment,
          to: sample.to
        }
      )
      writeFileSync(resolve(output, `${name}.html`), email.html)
      writeFileSync(resolve(output, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`)
      entries.push(
        `<li><a href="${name}.html">${escapeText(email.subject)}</a> · <a href="${name}.txt">text</a> · <code>${name}</code> (mockup #s15-${sample.mockup})</li>`
      )
    })
  }
  writeFileSync(
    resolve(output, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Email previews (${environment})</title><h1>Email previews (${environment})</h1><ol>${entries.join('')}</ol>`
  )
  console.log(`Wrote ${entries.length} email previews (${environment}) to ${output}`)
}

main()
