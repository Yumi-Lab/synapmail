import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
const ok = await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  const res = await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
  return res.ok
}, { base: BASE, email: EMAIL, password: PASSWORD })
if (!ok) { console.error('HARNESS: login failed'); process.exit(2) }

// Scenario the human lived: browse WIDE, open a message (as S7's bench does), THEN narrow the window.
await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
await page.waitForSelector('[data-mail-row]', { timeout: 20000 })
await new Promise(r => setTimeout(r, 600))
const r0 = await page.evaluate(() => { const r = document.querySelectorAll('[data-mail-row]')[2].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
await page.mouse.click(Math.round(r0.x + r0.w / 2), Math.round(r0.y + r0.h / 2))
await new Promise(r => setTimeout(r, 900))
console.log('opened a message at 1440px; rows now =', await page.$$eval('[data-mail-row]', e => e.length))

for (const width of [1440, 1200, 1024, 900, 780, 390]) {
  await page.setViewport({ width, height: 900 })
  await new Promise(r => setTimeout(r, 500))
  const geo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-mail-row]')]
    const visible = rows.filter(n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0)
    const listCol = document.querySelector('div[style*="--synap-list-w"]')
    const probe = visible[2] ?? visible[0]
    const r = probe?.getBoundingClientRect()
    return { total: rows.length, visible: visible.length,
      listColDisplay: listCol ? getComputedStyle(listCol).display : null,
      rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }
  })
  let menu = null
  if (geo.rect) {
    await page.mouse.click(Math.round(geo.rect.x + geo.rect.w / 2), Math.round(geo.rect.y + geo.rect.h / 2), { button: 'right' })
    await new Promise(r => setTimeout(r, 350))
    menu = await page.evaluate(() => { const m = document.querySelector('[data-mail-context-menu]'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    await page.keyboard.press('Escape')
  }
  console.log(`${width}px rowsTotal=${geo.total} rowsVisible=${geo.visible} listColDisplay=${geo.listColDisplay} probeRect=${JSON.stringify(geo.rect)} MENU=${menu ? JSON.stringify(menu) : 'NONE'}`)
}
await browser.close()
