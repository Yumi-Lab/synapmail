#!/usr/bin/env node
/**
 * Measures what opening /mail asks the server for, in a REAL browser:
 *
 *   (a) exactly ONE list request (`/api/messages`, page 1) is sent, and
 *   (b) it carries the CONFIGURED page size — not the hard-coded fallback the
 *       list used before /api/settings answered, nor the notification hook's
 *       own `perPage=5` poll of the same folder.
 *
 * The user's page size is set to a value different from the fallback for the
 * run, and restored afterwards. Read-only on the mailboxes: only GET list
 * requests are triggered.
 *
 * Needs a running server and SYNAPMAIL_TEST_* credentials (see .env).
 *   SYNAPMAIL_TEST_URL=http://localhost:3116 node scripts/check-mail-list-requests-browser.mjs
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
const MAIL_PATH = constant('MAIL_PATH', /MAIL_PATH = '([^']+)'/, src('../lib/compose.ts'), 'compose.ts')
const DEFAULT_PER_PAGE = Number(constant('messages_per_page', /messages_per_page: (\d+),/, src('../app/api/settings/route.ts'), 'settings/route.ts'))
/** Any size the server accepts that is not the fallback: a fallback request then shows as a wrong size. */
const TEST_PER_PAGE = DEFAULT_PER_PAGE + 10

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const MESSAGE_ROW = `[${constant('MAIL_ORIGIN_ATTR', /MAIL_ORIGIN_ATTR = '([^']+)'/, src('../lib/mailOrigin.ts'), 'mailOrigin.ts')}]`
/** A list on a real IMAP account: generous, and measured, not guessed. */
const LIST_SETTLE_MS = 12000

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
let page = null, savedPerPage = null
const setPerPage = n => page.evaluate(async (base, n) => {
  const res = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages_per_page: n }) })
  return res.ok
}, BASE, n)
try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 25000 })
    await page.waitForFunction(
      sel => { const el = document.querySelector(sel); return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$')) },
      { timeout: 25000 }, selector,
    )
  }
  const settle = ms => new Promise(r => setTimeout(r, ms))

  // Every LIST request (`/api/messages` alone — not search, thread or [id]).
  const lists = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname === '/api/messages') lists.push({ page: u.searchParams.get('page'), perPage: u.searchParams.get('perPage'), query: u.search })
  })

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

  // Page size ≠ fallback for the run, restored at the end.
  savedPerPage = await page.evaluate(async base => (await (await fetch(`${base}/api/settings`)).json()).data?.messages_per_page ?? null, BASE)
  if (!(await setPerPage(TEST_PER_PAGE))) { console.error('HARNESS: cannot write messages_per_page'); process.exit(2) }

  // --- opening /mail (default folder) ---
  await page.goto(`${BASE}${MAIL_PATH}`, { waitUntil: 'domcontentloaded' })
  await hydrated(SIDEBAR_ACCOUNT)
  await page.waitForSelector(MESSAGE_ROW, { timeout: 25000 }).catch(() => {})
  await settle(LIST_SETTLE_MS)
  const rows = await page.$$eval(MESSAGE_ROW, els => els.length)
  const firstLists = lists.filter(l => l.page === '1')
  console.log(`\n[open ${MAIL_PATH}] ${rows} message rows rendered`)
  console.log(`  list requests (page 1): ${firstLists.length}`)
  for (const l of firstLists) console.log(`    ${l.query}`)
  if (rows < 1) failures.push('the list rendered no message row')
  if (firstLists.length !== 1) failures.push(`(a) ${firstLists.length} list request(s) on open, expected 1`)
  if (!firstLists.every(l => l.perPage === String(TEST_PER_PAGE))) failures.push(`(b) a list request at a size other than the configured ${TEST_PER_PAGE} (fallback ${DEFAULT_PER_PAGE} or a side poll)`)
} finally {
  if (page && savedPerPage !== null) await setPerPage(savedPerPage).catch(() => {})
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-mail-list-requests-browser: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-mail-list-requests-browser: OK')
