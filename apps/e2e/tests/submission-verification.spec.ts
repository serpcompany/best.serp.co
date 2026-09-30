import { expect, test } from '@playwright/test'

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'a'.repeat(43)
const WEBSITE = 'https://unreachable.example/'

test('verification explains an unreachable website and preserves the diagnosis', async ({
  page
}) => {
  let lastVerificationError: string | null = null
  let verificationRequests = 0

  await page.route('**/api/submissions/**', async route => {
    const request = route.request()
    const isVerification = request.url().endsWith(`/api/submissions/${SUBMISSION_ID}/verify`)
    if (isVerification) {
      verificationRequests += 1
      lastVerificationError = 'site_unreachable'
      await route.fulfill({
        body: JSON.stringify({
          id: SUBMISSION_ID,
          lastVerificationError,
          name: 'Unreachable Example',
          status: 'pending_badge',
          verificationAttempts: 0,
          website: WEBSITE
        }),
        contentType: 'application/json',
        status: 422
      })
      return
    }

    await route.fulfill({
      body: JSON.stringify({
        id: SUBMISSION_ID,
        lastVerificationError,
        name: 'Unreachable Example',
        status: 'pending_badge',
        verificationAttempts: 0,
        website: WEBSITE
      }),
      contentType: 'application/json',
      status: 200
    })
  })

  await page.goto(`/submit/#submission=${SUBMISSION_ID}&token=${TOKEN}`)
  const dialog = page.getByRole('dialog', { name: 'Step 2 of 2 — Install and verify your badge' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`URL checked: ${WEBSITE}`)).toBeVisible()

  await dialog.getByRole('button', { name: 'Verify installed badge' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Website could not be reached')
  await expect(dialog.getByRole('alert')).toContainText(
    'Confirm the URL is public and that its firewall or bot protection allows verification requests'
  )
  await expect(page.getByText('fetch_failed')).toHaveCount(0)
  expect(verificationRequests).toBe(1)

  await dialog.getByRole('button', { name: 'Close for now' }).click()
  await expect(
    page.getByRole('region', { name: 'Submission saved' }).getByRole('alert')
  ).toContainText('Website could not be reached')

  await page.reload()
  await expect(dialog.getByRole('alert')).toContainText('Website could not be reached')
  await expect(page.getByText('fetch_failed')).toHaveCount(0)
})
