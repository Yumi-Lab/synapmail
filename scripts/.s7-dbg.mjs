import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
for (const f of ['.env', '.env.local']) {
  const u = new URL(`../${f}`, import.meta.url)
  if (!existsSync(u)) continue
  for (const line of readFileSync(u, 'utf8').split('\n')) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim() }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const p = await b.newPage()
await p.setViewport({ width: 390, height: 844 })
p.setDefaultNavigationTimeout(180000)
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await p.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
await p.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('[data-mail-row]', { timeout: 180000 })
await new Promise(r => setTimeout(r, 800))
console.log(JSON.stringify(await p.evaluate(() => {
  const row = document.querySelector('[data-mail-row]')
  const chain = []
  let el = row
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 70), disp: cs.display, vis: cs.visibility, rect: [Math.round(r.width), Math.round(r.height)] })
    el = el.parentElement
  }
  return { rows: document.querySelectorAll('[data-mail-row]').length, chain }
}), null, 1))
await b.close()
