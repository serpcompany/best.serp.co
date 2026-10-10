import { chromium } from '@playwright/test'
const browser = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: (process.env.ARGS || '').split(' ').filter(Boolean) })
browser.on('disconnected', () => console.log('BROWSER DISCONNECTED', Date.now() - t0))
const t0 = Date.now()
const page = await browser.newPage()
await page.goto(process.argv[2])
for (let i = 0; i < 12; i += 1) {
  await new Promise(r => setTimeout(r, 4000))
  console.log(i, Date.now() - t0, await page.title().catch(e => String(e).slice(0, 60)))
}
await browser.close()
