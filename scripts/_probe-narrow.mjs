import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
for (const line of readFileSync(new URL('/Users/nicolasmichaut/Documents/GitHub/synapmail-lanes/search/.env', import.meta.url), 'utf8').split('\n')) {
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
for (const width of [1440, 1200, 1024, 900, 780, 390]) {
  await page.setViewport({ width, height: 900 })
  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  try { await page.waitForSelector('[data-mail-row]', { timeout: 20000 }) } catch { console.log(`${width}px: NO ROW AT ALL`); continue }
  await new Promise(r => setTimeout(r, 600))
  const geo = await page.evaluate(() => {
    const row = document.querySelector('[data-mail-row]')
    const r = row.getBoundingClientRect()
    const cs = getComputedStyle(row)
    // who is on top at the row's centre?
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    const chain = []
    for (let n = hit; n && n !== document.body; n = n.parentElement) chain.push(`${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.split(/\s+/).slice(0,3).join('.') : ''}`)
    const listCol = row.closest('div[style*="--synap-list-w"]')
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: cs.display, visibility: cs.visibility, pe: cs.pointerEvents,
      hitIsRow: !!hit?.closest('[data-mail-row]'), hitChain: chain.slice(0, 5),
      listColClass: listCol?.className ?? null, listColDisplay: listCol ? getComputedStyle(listCol).display : null,
      rowCount: document.querySelectorAll('[data-mail-row]').length }
  })
  const cx = Math.round(geo.rect.x + geo.rect.w / 2), cy = Math.round(geo.rect.y + geo.rect.h / 2)
  await page.mouse.click(cx, cy, { button: 'right' })
  await new Promise(r => setTimeout(r, 400))
  const menu = await page.evaluate(() => {
    const m = document.querySelector('[data-mail-context-menu]')
    if (!m) return null
    const r = m.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  console.log(`${width}px rows=${geo.rowCount} row=${JSON.stringify(geo.rect)} display=${geo.display} hitIsRow=${geo.hitIsRow} listColDisplay=${geo.listColDisplay} MENU=${menu ? JSON.stringify(menu) : 'NONE'}`)
  if (!menu) console.log(`   hitChain: ${geo.hitChain.join(' < ')}`)
  await page.keyboard.press('Escape')
}
await browser.close()
