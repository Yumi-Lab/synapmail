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

const shot = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-mail-row]')]
  const vis = rows.filter(n => n.getBoundingClientRect().width > 0)
  const back = [...document.querySelectorAll('button')].find(b => /retour/i.test(b.textContent || ''))
  return { visRows: vis.length, hasBack: !!back && back.getBoundingClientRect().width > 0,
    backRect: back ? (r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(back.getBoundingClientRect()) : null,
    paneActions: document.querySelectorAll('[data-reading-flag]').length }
})

await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
await page.waitForSelector('[data-mail-row]', { timeout: 20000 })
await new Promise(r => setTimeout(r, 700))
console.log('900px, list view :', JSON.stringify(await shot()))

// open a message
const r0 = await page.evaluate(() => { const r = document.querySelectorAll('[data-mail-row]')[2].getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
await page.mouse.click(Math.round(r0.x + r0.w / 2), Math.round(r0.y + r0.h / 2))
await new Promise(r => setTimeout(r, 1200))
const openState = await shot()
console.log('900px, message open:', JSON.stringify(openState))

// the documented mobile path back to the list
if (openState.backRect) {
  await page.mouse.click(Math.round(openState.backRect.x + openState.backRect.w / 2), Math.round(openState.backRect.y + openState.backRect.h / 2))
  await new Promise(r => setTimeout(r, 700))
  const afterBack = await shot()
  const rr = await page.evaluate(() => { const n = [...document.querySelectorAll('[data-mail-row]')].find(n => n.getBoundingClientRect().width > 0); const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await page.mouse.click(Math.round(rr.x + rr.w / 2), Math.round(rr.y + rr.h / 2), { button: 'right' })
  await new Promise(r => setTimeout(r, 350))
  const menu = await page.evaluate(() => { const m = document.querySelector('[data-mail-context-menu]'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  console.log('900px, after Retour :', JSON.stringify(afterBack), 'MENU=', JSON.stringify(menu))

  // now measure the "Move to" panel flip at a right-hand right-click, 900px
  await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 200))
  const nearRight = { x: Math.round(rr.x + rr.w - 12), y: Math.round(rr.y + rr.h / 2) }
  await page.mouse.click(nearRight.x, nearRight.y, { button: 'right' })
  await new Promise(r => setTimeout(r, 350))
  const moveGeo = await page.evaluate(() => {
    const m = document.querySelector('[data-mail-context-menu]'); if (!m) return null
    const items = [...m.querySelectorAll('button,[role="menuitem"]')]
    const mv = items.find(b => /déplacer|move/i.test(b.textContent || ''))
    if (!mv) return { menu: (r => ({ x: r.x, w: r.width }))(m.getBoundingClientRect()), moveFound: false, labels: items.slice(0,12).map(b => (b.textContent||'').trim()) }
    const r = mv.getBoundingClientRect()
    return { menu: (r2 => ({ x: r2.x, w: r2.width }))(m.getBoundingClientRect()), moveFound: true, mv: { x: r.x, y: r.y, w: r.width, h: r.height } }
  })
  console.log('900px near-right menu:', JSON.stringify(moveGeo))
  if (moveGeo?.moveFound) {
    await page.mouse.move(Math.round(moveGeo.mv.x + moveGeo.mv.w / 2), Math.round(moveGeo.mv.y + moveGeo.mv.h / 2))
    await new Promise(r => setTimeout(r, 600))
    const panel = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('[data-move-panel],[data-submenu-panel]')]
      const el = cands[0] ?? null
      if (!el) return { found: false, attrs: [...document.querySelectorAll('div[role="menu"]')].length }
      const r = el.getBoundingClientRect(); return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, vw: window.innerWidth }
    })
    console.log('900px move panel:', JSON.stringify(panel))
  }
}
await browser.close()
