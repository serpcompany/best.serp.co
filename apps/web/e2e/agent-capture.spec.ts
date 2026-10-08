import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test('capture an agent-readable route journey', async ({ page }) => {
  const captureDirectory = process.env.AGENT_CAPTURE_DIRECTORY
  const journeyName = process.env.AGENT_JOURNEY_NAME || 'home'
  const journeyPath = process.env.AGENT_JOURNEY_PATH || '/'
  if (!captureDirectory) throw new Error('AGENT_CAPTURE_DIRECTORY is required.')
  mkdirSync(captureDirectory, { recursive: true })

  const consoleEvents: Array<{ text: string; type: string }> = []
  const failedRequests: Array<{ error: string | null; method: string; url: string }> = []
  const responses: Array<{ method: string; status: number; url: string }> = []
  page.on('console', message => consoleEvents.push({ text: message.text(), type: message.type() }))
  page.on('requestfailed', request =>
    failedRequests.push({
      error: request.failure()?.errorText || null,
      method: request.method(),
      url: request.url()
    })
  )
  page.on('response', response =>
    responses.push({
      method: response.request().method(),
      status: response.status(),
      url: response.url()
    })
  )

  const response = await page.goto(journeyPath, { waitUntil: 'networkidle' })
  expect(response?.ok(), `Journey ${journeyName} did not return a successful document.`).toBe(true)
  await page.screenshot({ fullPage: true, path: resolve(captureDirectory, 'after.png') })
  writeFileSync(resolve(captureDirectory, 'dom.html'), await page.content())
  writeFileSync(
    resolve(captureDirectory, 'evidence.json'),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        consoleEvents,
        failedRequests,
        finalUrl: page.url(),
        journeyName,
        journeyPath,
        responses
      },
      null,
      2
    )}\n`
  )
})
