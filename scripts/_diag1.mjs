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
page.on('console', m => { const t = m.text(); if (/error|warn|hydrat/i.test(t)) console.log('  [console]', t.slice(0,200)) })
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0,200)))
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-mail-row]', { timeout: 180000 })
await page.goto(`${BASE}/mail?q=facture`, { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 6000))
const state = () => page.evaluate(() => ({
  url: location.search,
  buttons: [...document.querySelectorAll('[data-omnibar-scope]')].map(b => {
    const r = b.getBoundingClientRect()
    return { scope: b.dataset.omnibarScope, pressed: b.getAttribute('aria-pressed'), cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2), top: document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.dataset?.omnibarScope ?? document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.tagName }
  }),
  inputValue: document.querySelector('[data-omnibar] input')?.value,
}))
console.log('before', JSON.stringify(await state(), null, 1))
const s0 = await state()
const target = s0.buttons.find(b => b.scope === 'all')
console.log(`clicking scope=all at ${target.cx},${target.cy}`)
await page.mouse.click(target.cx, target.cy)
for (const ms of [500, 1500, 4000, 8000]) {
  await new Promise(r => setTimeout(r, ms === 500 ? 500 : ms - 500))
  const s = await state()
  console.log(`  +${ms}ms url=${s.url} pressed=${s.buttons.map(b=>b.scope+':'+b.pressed).join(',')}`)
}
await browser.close()
