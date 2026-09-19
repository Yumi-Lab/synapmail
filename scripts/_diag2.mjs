import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
for (const f of ['.env', '.env.local']) {
  const u = new URL(`../${f}`, import.meta.url)
  if (!existsSync(u)) continue
  for (const line of readFileSync(u, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.setDefaultNavigationTimeout(180000)
let phase = 'boot'
let count = 0
let firstTrace = null
page.on('console', async m => {
  const t = m.text()
  if (!/Maximum update depth/.test(t)) return
  count++
  if (!firstTrace) {
    firstTrace = { phase, stack: m.stackTrace?.() ?? m.stackTrace, text: t }
    const args = m.args()
    try { firstTrace.full = await args[0]?.jsonValue() } catch {}
  }
})
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
for (const [label, url] of [['plain /mail', `${BASE}/mail`], ['q=facture', `${BASE}/mail?q=facture`], ['q=facture&scope=all', `${BASE}/mail?q=facture&scope=all`]]) {
  phase = label; count = 0
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-mail-row]', { timeout: 180000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 5000))
  console.log(`${label}: ${count} loop warning(s)`)
}
if (firstTrace) console.log('FIRST at phase', firstTrace.phase, '\n', String(firstTrace.full ?? firstTrace.text).slice(0, 2500))
await browser.close()
