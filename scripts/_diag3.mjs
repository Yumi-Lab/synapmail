import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
for (const f of ['.env', '.env.local']) {
  const u = new URL(`../${f}`, import.meta.url); if (!existsSync(u)) continue
  for (const line of readFileSync(u, 'utf8').split('\n')) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim() }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.setDefaultNavigationTimeout(180000)
let done = false
page.on('console', async m => {
  if (done || !/Maximum update depth/.test(m.text())) return
  done = true
  const args = m.args()
  const vals = []
  for (const a of args) { try { vals.push(await a.jsonValue()) } catch { vals.push('?') } }
  console.log('ARGS:', JSON.stringify(vals).slice(0, 3000))
  console.log('STACK:', JSON.stringify(m.stackTrace?.()?.slice?.(0, 12) ?? m.stackTrace, null, 1).slice(0, 3000))
})
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
await page.goto(`${BASE}/mail?q=facture`, { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 12000))
await browser.close()
