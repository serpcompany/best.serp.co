import { chromium } from '@playwright/test'
const base = 'http://127.0.0.1:9249'
const browser = await chromium.launch()
const context = await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.18.9.77' } })
const headers = { origin: base }
const email = `probe-${Date.now()}@example.com`
let r = await context.request.post(`${base}/api/auth/email-otp/send-verification-otp`, { data: { email, type: 'sign-in' }, headers })
const { otp } = await (await context.request.get(`${base}/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)).json()
r = await context.request.post(`${base}/api/auth/sign-in/email-otp`, { data: { email, otp }, headers })
console.log('signin', r.status())
const site = `probe-${Date.now()}.example`
r = await context.request.post(`${base}/api/submissions`, { headers, data: { categorySlug: 'design-tools', content: '', description: 'A probe.', logoUrl: `${base}/badge/featured-on-serp.co-light.svg`, name: 'Probe', website: `https://${site}/` } })
console.log('draft', r.status(), (await r.text()).slice(0, 200))
await browser.close()
