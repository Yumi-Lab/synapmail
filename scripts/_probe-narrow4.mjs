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
const ok = await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  const res = await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
  return res.ok
}, { base: BASE, email: EMAIL, password: PASSWORD })
if (!ok) { console.error('HARNESS: login failed'); process.exit(2) }

for (const width of [900, 780, 390]) {
  await page.setViewport({ width, height: 900 })
  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-mail-row]', { timeout: 20000 })
  await new Promise(r => setTimeout(r, 700))
  const rr = await page.evaluate(() => { const n = [...document.querySelectorAll('[data-mail-row]')].filter(n => n.getBoundingClientRect().width > 0)[3]; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  // right-click as close to the RIGHT edge of the row as a mouse can land
  const px = Math.round(rr.x + rr.w - 6), py = Math.round(rr.y + rr.h / 2)
  await page.mouse.click(px, py, { button: 'right' })
  await new Promise(r => setTimeout(r, 350))
  const mv = await page.evaluate(() => {
    const m = document.querySelector('[data-mail-context-menu]'); if (!m) return null
    const mr = m.getBoundingClientRect()
    const rows = [...m.querySelectorAll('[data-menu-item],div,button')]
    const hit = rows.find(n => /^(déplacer vers|move to)/i.test((n.textContent || '').trim()) && n.querySelector('svg'))
    const r = hit?.getBoundingClientRect()
    return { menu: { x: mr.x, right: mr.right, w: mr.width }, vw: window.innerWidth,
      mvFound: !!hit, mv: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }
  })
  if (!mv?.mvFound) { console.log(`${width}px: menu=${JSON.stringify(mv?.menu)} — "Déplacer vers" row NOT found`); await page.keyboard.press('Escape'); continue }
  await page.mouse.move(Math.round(mv.mv.x + mv.mv.w / 2), Math.round(mv.mv.y + mv.mv.h / 2))
  await new Promise(r => setTimeout(r, 700))
  const panel = await page.evaluate(() => {
    const el = document.querySelector('[data-menu-panel="move"]')
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    return { found: true, x: r.x, right: r.right, w: r.width, top: r.top, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight }
  })
  const inWin = panel.found && panel.x >= 0 && panel.right <= panel.vw
  const flipped = panel.found && panel.x < mv.menu.x
  console.log(`${width}px menu=[${mv.menu.x.toFixed(0)},${mv.menu.right.toFixed(0)}] vw=${mv.vw} panel=${JSON.stringify(panel)} IN_WINDOW=${inWin} FLIPPED_LEFT=${flipped}`)
  await page.keyboard.press('Escape')
}
await browser.close()
