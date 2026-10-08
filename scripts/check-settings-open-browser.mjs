#!/usr/bin/env node
/**
 * Measures, with a REAL mouse on the running app, that opening the account menu
 * and clicking "Settings" OPENS the settings window — every time, whatever the
 * delay between the two clicks.
 *
 * Cause (measured on a slow network, real Chrome): on opening the menu, the
 * "Settings" link PREFETCHED `/settings` (`_rsc` + `next-router-prefetch: 1`);
 * a click during that prefetch reused the in-flight response — fetched without
 * the header that activates the INTERCEPTED route `@modal/(.)settings` — and the
 * navigation never completed. Hence the emulated latency (300 ms) and the
 * 0 / 300 / 1000 / 3000 ms delays: the click lands during, right after and well
 * after a prefetch. From /mail AND from a folder reached by click.
 *
 * Criteria: (1) no prefetch of /settings when the menu opens;
 *           (2) the window `[data-slot="settings-modal"]` opens in < 5 s on EVERY trial.
 *
 * `next/link` only prefetches in a PRODUCTION build: run this against `next start`,
 * not against the dev server (HARNESS otherwise). Read-only: nothing is written.
 *
 *   SYNAPMAIL_TEST_URL=http://localhost:3116 node scripts/check-settings-open-browser.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Emulated latency: a prefetch lasts at least this long, so the 0 and 300 ms clicks land inside it. */
const LATENCY_MS = 300
const DELAYS_MS = [0, 300, 1000, 3000]
const TRIALS = 3
const OPEN_BUDGET_MS = 5000

const src = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const constant = (name, re, text, file) => {
  const m = text.match(re)
  if (!m) { console.error(`HARNESS: ${name} unreadable in ${file}`); process.exit(2) }
  return m[1]
}
const MAIL_PATH = constant('MAIL_PATH', /MAIL_PATH = '([^']+)'/, src('../lib/compose.ts'), 'compose.ts')
const SETTINGS_ROOT = constant('SETTINGS_ROOT', /SETTINGS_ROOT = '([^']+)'/, src('../components/settings/SettingsSidebar.tsx'), 'SettingsSidebar.tsx')

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const FOLDER_ROWS = '[data-sidebar-row^="folder:"]'
const folderRow = path => `[data-sidebar-row="folder:${path}"]`
const MENU_TRIGGER = '[data-user-menu-trigger]'
const MENU_SETTINGS = '[data-user-menu-item="settings"]'
const MODAL = '[data-slot="settings-modal"]'

for (const line of src('../.env').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
const failures = []
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 25000 })
    await page.waitForFunction(
      sel => { const el = document.querySelector(sel); return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$')) },
      { timeout: 25000 }, selector,
    )
  }
  const realClick = async (selector) => {
    await hydrated(selector)
    const box = await page.$eval(selector, el => {
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
    })
    if (box.w === 0 || box.h === 0) { console.error(`HARNESS: ${selector} renders with a zero size`); process.exit(2) }
    await page.mouse.click(box.x, box.y)
  }
  const settle = ms => new Promise(r => setTimeout(r, ms))

  // Every `_rsc` request to /settings, prefetch or navigation.
  let prefetches = [], navigations = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname !== SETTINGS_ROOT || !u.searchParams.has('_rsc')) return
    if (req.headers()['next-router-prefetch']) prefetches.push(u.search); else navigations.push(u.search)
  })
  const reset = () => { prefetches = []; navigations = [] }

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: login refused'); process.exit(2) }

  // A DEV server never prefetches: the bench would measure nothing on (1).
  const isDev = await page.evaluate(async base => {
    const html = await (await fetch(`${base}/login`)).text()
    return html.includes('/_next/static/chunks/webpack.js') || html.includes('react-refresh')
  }, BASE)
  if (isDev) { console.error('HARNESS: development server — `next/link` does not prefetch there, run against `next start`'); process.exit(2) }

  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 })

  const openMail = async () => {
    await page.goto(`${BASE}${MAIL_PATH}`, { waitUntil: 'domcontentloaded' })
    await hydrated(SIDEBAR_ACCOUNT)
    await page.waitForSelector(FOLDER_ROWS, { timeout: 25000 })
  }
  await openMail()
  const target = await page.evaluate(sel =>
    [...document.querySelectorAll(sel)]
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
      .find(p => p !== 'INBOX') ?? null, FOLDER_ROWS)
  if (!target) { console.error('HARNESS: the sidebar renders no folder besides the inbox'); process.exit(2) }

  const starts = [
    { label: MAIL_PATH, prepare: openMail },
    { label: `${MAIL_PATH} → folder "${target}" (by click)`, prepare: async () => {
      await openMail()
      await realClick(folderRow(target))
      // Whatever the mechanism (link or history API), the URL now names the folder.
      await page.waitForFunction(f => decodeURIComponent(location.search).includes(f), { timeout: 25000 }, target)
      await hydrated(MENU_TRIGGER)
    } },
  ]

  console.log(`\nemulated latency ${LATENCY_MS} ms; ${TRIALS} trials × delays ${DELAYS_MS.join('/')} ms × 2 starting points`)
  for (const start of starts) {
    console.log(`\n[from ${start.label}]`)
    for (const delay of DELAYS_MS) {
      const results = []
      for (let i = 0; i < TRIALS; i++) {
        await start.prepare()
        reset()
        await realClick(MENU_TRIGGER)
        await page.waitForSelector(MENU_SETTINGS, { timeout: 25000 })
        await settle(delay)
        const prefetched = prefetches.length
        const t0 = Date.now()
        await realClick(MENU_SETTINGS)
        const opened = await page.waitForSelector(MODAL, { timeout: OPEN_BUDGET_MS }).then(() => true).catch(() => false)
        const ms = Date.now() - t0
        results.push({ opened, ms, prefetched, navigated: navigations.length })
        if (prefetched) failures.push(`(1) prefetch of ${SETTINGS_ROOT} when the menu opens (from ${start.label}, delay ${delay} ms, trial ${i + 1})`)
        if (!opened) failures.push(`(2) window not opened within ${OPEN_BUDGET_MS} ms (from ${start.label}, delay ${delay} ms, trial ${i + 1}; URL ${new URL(page.url()).pathname})`)
      }
      const ok = results.filter(r => r.opened).length
      console.log(`  delay ${String(delay).padStart(4)} ms: opened ${ok}/${TRIALS}; ${results.map(r => `${r.opened ? r.ms + 'ms' : 'NEVER'}${r.prefetched ? '·prefetch' : ''}${r.navigated ? '·nav' : ''}`).join(', ')}`)
    }
  }
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-settings-open-browser: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-settings-open-browser: OK')
