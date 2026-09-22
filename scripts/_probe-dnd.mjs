import puppeteer from 'puppeteer-core'
import './bench-imap.mjs'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
const CARD = '[data-dashboard-card]'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1440, height: 1000 } })
const page = await browser.newPage()
page.on('console', m => console.log('PAGE>', m.text()))
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate(async ({ base, email, password }) => {
  const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
  await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
}, { base: BASE, email: EMAIL, password: PASSWORD })
await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(s => document.querySelectorAll(s).length >= 9, { timeout: 120000, polling: 150 }, CARD)
await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ dashboard_card_order: null }) }))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(s => document.querySelectorAll(s).length >= 9, { timeout: 120000, polling: 150 }, CARD)
const read = () => page.$$eval(CARD, els => els.map(e => e.getAttribute('data-dashboard-card')))
const origin = await read()
console.log('origin:', origin.join(' > '))
const moved = origin[origin.length-1], target = origin[0]


const box = async sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })

// ARM 2: exactly the bench sequence, instrumented at each step.
await page.$eval(`[data-dashboard-card="${moved}"] button[aria-label]`, el => el.scrollIntoView({ block: 'center' }))
const h = await box(`[data-dashboard-card="${moved}"] button[aria-label]`)
await page.mouse.move(h.x, h.y)
await page.mouse.down()
await sleep(300)
console.log('after mousedown: draggable=', await page.$eval(`[data-dashboard-card="${moved}"]`, e => e.getAttribute('draggable')))
await page.$eval(`[data-dashboard-card="${target}"]`, el => el.scrollIntoView({ block: 'center' }))
const d = await box(`[data-dashboard-card="${target}"]`)
await page.mouse.move(d.x, d.y, { steps: 12 })
await sleep(200)
console.log('after mousemove: draggable=', await page.$eval(`[data-dashboard-card="${moved}"]`, e => e.getAttribute('draggable')))
const r2 = await page.evaluate((from, to) => {
  const src = document.querySelector(`[data-dashboard-card="${from}"]`)
  const dst = document.querySelector(`[data-dashboard-card="${to}"]`)
  const dt = new DataTransfer(); const log = []
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  const ov = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
  dst.dispatchEvent(ov); log.push('dragover-prevented=' + ov.defaultPrevented)
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  return log
}, moved, target)
console.log('ARM2:', r2.join(' | '))
await page.mouse.up()
await sleep(900)
console.log('ARM2 order:', (await read()).join(' > '))
await browser.close()
