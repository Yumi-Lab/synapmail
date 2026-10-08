#!/usr/bin/env node
/**
 * Measures folder navigation on the running app, with a REAL mouse: changing
 * folder never goes through the server, and the router stays in sync.
 *
 *   (a) opening /mail sends NO `_rsc` request to /mail (the automatic prefetch
 *       of every folder link in the sidebar);
 *   (b) clicking a folder sends NO `_rsc` request, the URL and the highlight
 *       follow, and the folder's list is requested;
 *   (c) going back returns to the previous folder without a reload, and the
 *       sidebar highlights it again;
 *   (d) after a folder change pushed through the history API, a regular link to
 *       another page (the dashboard) still navigates — the router was not left
 *       believing it was elsewhere.
 *
 * `next/link` only prefetches in a PRODUCTION build (dev switches it off): run
 * this against `next start`, not against the dev server — on a dev server (a) and
 * (b) are green whatever the code, and the bench says so (HARNESS) instead of
 * passing for green.
 *
 * Read-only on the mailboxes: only GET list requests are triggered.
 *
 * Needs a running production server and SYNAPMAIL_TEST_* credentials (see .env).
 *   SYNAPMAIL_TEST_URL=http://localhost:3116 node scripts/check-mail-folder-nav-browser.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

const src = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const constant = (name, re, text, file) => {
  const m = text.match(re)
  if (!m) { console.error(`HARNESS: ${name} unreadable in ${file}`); process.exit(2) }
  return m[1]
}
const CONTRACT = src('../app/(app)/mail/mailboxUrl.ts')
const FOLDER_PARAM = constant('FOLDER_PARAM', /FOLDER_PARAM = '([^']+)'/, CONTRACT, 'mailboxUrl.ts')
const DEFAULT_FOLDER = constant('DEFAULT_FOLDER', /DEFAULT_FOLDER = '([^']+)'/, CONTRACT, 'mailboxUrl.ts')
const MAIL_PATH = constant('MAIL_PATH', /MAIL_PATH = '([^']+)'/, src('../lib/compose.ts'), 'compose.ts')
const ACTIVE_TOKEN = constant('ROW_ACTIVE', /ROW_ACTIVE = cn\(ACCENT\.(\w+),/, src('../components/layout/Sidebar.tsx'), 'Sidebar.tsx')
const ACTIVE_MARKER = constant('ACCENT.' + ACTIVE_TOKEN, new RegExp(`\\b${ACTIVE_TOKEN}: '([^']+)'`), src('../components/layout/AccountAvatar.tsx'), 'AccountAvatar.tsx')
const DASHBOARD_PATH = constant('dashboard link', /<Link href="(\/dashboard)"[^>]*data-omnibar-action="dashboard"/, src('../components/layout/Omnibar.tsx'), 'Omnibar.tsx')

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const FOLDER_ROWS = '[data-sidebar-row^="folder:"]'
const folderRow = path => `[data-sidebar-row="folder:${path}"]`
const DASHBOARD_LINK = '[data-omnibar-action="dashboard"]'
/** A list on a real IMAP account: generous, and measured, not guessed. */
const LIST_SETTLE_MS = 12000
const NAV_SETTLE_MS = 8000

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

  // Every request, sorted: `_rsc` renders of the mail page, and LIST requests
  // (`/api/messages` alone — not search, thread or [id]).
  let rsc = [], lists = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname === MAIL_PATH && u.searchParams.has('_rsc')) rsc.push(u.search)
    if (u.pathname === '/api/messages') lists.push({ folder: u.searchParams.get(FOLDER_PARAM), page: u.searchParams.get('page') })
  })
  const reset = () => { rsc = []; lists = [] }

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

  // A DEV server never prefetches: the bench would measure nothing on (a)/(b).
  const isDev = await page.evaluate(async base => {
    const html = await (await fetch(`${base}/login`)).text()
    return html.includes('/_next/static/chunks/webpack.js') || html.includes('react-refresh')
  }, BASE)
  if (isDev) { console.error('HARNESS: development server — `next/link` does not prefetch there, run against `next start`'); process.exit(2) }

  const activeFolderRows = async () => page.evaluate((sel, marker) =>
    [...document.querySelectorAll(sel)]
      .filter(el => el.className.includes(marker))
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length)),
    FOLDER_ROWS, ACTIVE_MARKER)

  // --- (a) opening /mail ---
  reset()
  await page.goto(`${BASE}${MAIL_PATH}?${FOLDER_PARAM}=${encodeURIComponent(DEFAULT_FOLDER)}`, { waitUntil: 'domcontentloaded' })
  await hydrated(SIDEBAR_ACCOUNT)
  await page.waitForSelector(FOLDER_ROWS, { timeout: 25000 })
  await settle(LIST_SETTLE_MS)
  const folderCount = await page.$$eval(FOLDER_ROWS, els => els.length)
  console.log(`\n[open] ${folderCount} folders in the sidebar`)
  console.log(`  _rsc requests to ${MAIL_PATH}: ${rsc.length}`)
  if (rsc.length !== 0) failures.push(`(a) ${rsc.length} _rsc request(s) on open (folder prefetch)`)

  // --- (b) clicking a folder ---
  const target = await page.evaluate((sel, inbox) =>
    [...document.querySelectorAll(sel)]
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
      .find(p => p !== inbox) ?? null, FOLDER_ROWS, DEFAULT_FOLDER)
  if (!target) { console.error('HARNESS: the sidebar renders no folder besides the inbox'); process.exit(2) }
  await page.evaluate(() => { window.__nav_alive = true })
  reset()
  await realClick(folderRow(target))
  await settle(LIST_SETTLE_MS)
  const afterClick = new URL(page.url())
  const clickLists = lists.filter(l => l.folder === target)
  const clickRows = await activeFolderRows()
  console.log(`\n[click "${target}"] URL ${afterClick.search}`)
  console.log(`  _rsc requests: ${rsc.length}; list requests for the folder: ${clickLists.length}; highlighted: ${clickRows.join(', ') || '(none)'}`)
  if (afterClick.searchParams.get(FOLDER_PARAM) !== target) failures.push(`(b) the click did not land (URL ${afterClick.search})`)
  if (rsc.length !== 0) failures.push(`(b) ${rsc.length} _rsc request(s) on a folder click`)
  if (clickLists.length < 1) failures.push(`(b) no list request for "${target}"`)
  if (!clickRows.includes(target)) failures.push(`(b) the sidebar does not highlight "${target}"`)

  // --- (c) going back ---
  reset()
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(LIST_SETTLE_MS)
  const afterBack = new URL(page.url())
  const alive = await page.evaluate(() => window.__nav_alive === true)
  const backRows = await activeFolderRows()
  console.log(`\n[back] URL ${afterBack.search}; page kept: ${alive}; _rsc: ${rsc.length}; highlighted: ${backRows.join(', ') || '(none)'}`)
  if (afterBack.searchParams.get(FOLDER_PARAM) !== DEFAULT_FOLDER) failures.push(`(c) back did not return to ${DEFAULT_FOLDER} (${afterBack.search})`)
  if (!alive) failures.push('(c) back reloaded the page')
  if (!backRows.includes(DEFAULT_FOLDER)) failures.push(`(c) the sidebar does not highlight ${DEFAULT_FOLDER} after back`)

  // --- (d) the router is still in sync: a folder click, then a regular link ---
  await realClick(folderRow(target))
  await settle(2000)
  await realClick(DASHBOARD_LINK)
  await settle(NAV_SETTLE_MS)
  const afterNav = new URL(page.url())
  const stillAlive = await page.evaluate(() => window.__nav_alive === true)
  console.log(`\n[link after folder click] URL ${afterNav.pathname}; page kept: ${stillAlive}`)
  if (afterNav.pathname !== DASHBOARD_PATH) failures.push(`(d) the dashboard link did not navigate after a folder click (${afterNav.pathname}${afterNav.search})`)
  if (!stillAlive) failures.push('(d) the dashboard link reloaded the page')
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-mail-folder-nav-browser: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-mail-folder-nav-browser: OK')
