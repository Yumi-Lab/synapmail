import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 900 })
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
await page.waitForSelector('[data-mail-row]', { timeout: 20000 })
await new Promise(r => setTimeout(r, 700))
const rr = await page.evaluate(() => { const n = [...document.querySelectorAll('[data-mail-row]')].filter(n => n.getBoundingClientRect().width>0)[2]; const r = n.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height } })
await page.mouse.click(Math.round(rr.x+rr.w/2), Math.round(rr.y+rr.h/2))
await new Promise(r => setTimeout(r, 1500))
const census = await page.evaluate(() => {
  const vis = n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const btns = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(vis)
  const named = btns.map(b => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean)
  const dataHooks = [...document.querySelectorAll('[data-reading-flag],[data-reading-action],[data-mail-toolbar] *')].filter(vis).length
  return { visibleButtons: btns.length, names: named.slice(0, 30), dataHooks,
    listVisible: [...document.querySelectorAll('[data-mail-row]')].some(vis) }
})
console.log(JSON.stringify(census, null, 1))
await browser.close()
