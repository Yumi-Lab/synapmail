#!/usr/bin/env node
/**
 * Measures the colour flags end to end, on the running app, with REAL clicks:
 * each of the seven colours is picked in the reading pane's flag menu, and the
 * result is read back FROM THE IMAP SERVER on a separate connection.
 *
 * The reference is the server, not the screen: a component that paints a flag
 * it never stored would pass a DOM-only check and fail this one. Conversely the
 * last assertion reads the row's own icon colour class, so a correctly stored
 * flag that never reaches the list is caught too.
 *
 * Nothing touches a real mailbox: the bench APPENDs its own message into a
 * `Tests-lane` folder of the test account and deletes it at the end. No other
 * message is read, moved, flagged or deleted.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node --experimental-strip-types scripts/check-mail-flags.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { ImapFlow } from 'imapflow'
import { MAIL_FLAGS, flagFromKeywords } from '../lib/flags.ts'
import { decrypt } from '../lib/encrypt.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
// A flag click is one PATCH against IMAP: slower than a local re-render.
const SETTLE_MS = 1500
const FOLDER = 'Tests-lane'

for (const f of [new URL('../.env.local', import.meta.url), new URL('../.env', import.meta.url)]) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const { rows } = await pool.query(
  `SELECT a.* FROM email_accounts a JOIN users u ON u.id = a.user_id
   WHERE u.email = $1 ORDER BY a.created_at LIMIT 1`, [EMAIL])
await pool.end()
const acc = rows[0]
if (!acc) { console.error(`HARNESS: no email account for ${EMAIL}`); process.exit(2) }

const imap = async () => {
  const c = new ImapFlow({
    host: acc.imap_host, port: acc.imap_port, secure: acc.imap_secure,
    auth: { user: acc.username, pass: decrypt(acc.password_encrypted) },
    logger: false, tls: { rejectUnauthorized: false },
  })
  await c.connect()
  return c
}

// --- plant one message of our own in the test folder ---
let uid
{
  const c = await imap()
  try {
    if (!(await c.list()).some(b => b.path === FOLDER)) await c.mailboxCreate(FOLDER)
    await c.mailboxOpen(FOLDER)
    const raw = Buffer.from(
      `From: lane bench <${acc.email}>\r\nTo: lane bench <${acc.email}>\r\n` +
      `Subject: check-mail-flags ${Date.now()}\r\nDate: ${new Date().toUTCString()}\r\n` +
      `Message-ID: <check-mail-flags-${Date.now()}@yumi-lab.com>\r\n\r\nbench message\r\n`)
    uid = String((await c.append(FOLDER, raw, ['\\Seen'])).uid)
  } finally { await c.logout() }
}
console.log(`bench message appended to ${FOLDER}, uid ${uid}`)

const serverFlag = async () => {
  const c = await imap()
  try {
    await c.mailboxOpen(FOLDER)
    const msg = await c.fetchOne(uid, { flags: true }, { uid: true })
    return flagFromKeywords(msg.flags)
  } finally { await c.logout() }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const failures = []
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: credentials login failed'); process.exit(2) }

  // The active account lives in user_settings, not in the URL: point it at the
  // account the bench planted its message in, or the list would open elsewhere.
  const switched = await page.evaluate(async ({ base, id }) => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active_account_id: id }),
    })
    return res.ok
  }, { base: BASE, id: acc.id })
  if (!switched) { console.error('HARNESS: could not set the active account'); process.exit(2) }

  await page.goto(`${BASE}/mail?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-mail-row="${uid}"]`, { timeout: 30000 })
  await (await page.$(`[data-mail-row="${uid}"]`)).click()
  await page.waitForSelector('[data-reading-archive]', { timeout: 20000 })

  const openMenu = async () => {
    await page.click('[data-reading-flag]')
    await page.waitForSelector('[data-flag]', { timeout: 5000 })
  }

  // --- each of the seven colours: click it, then ASK THE SERVER ---
  for (const f of MAIL_FLAGS) {
    await openMenu()
    await page.click(`[data-flag="${f.key}"]`)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const stored = await serverFlag()
    const ok = stored === f.key
    console.log(`${ok ? 'ok  ' : 'FAIL'} pick ${f.key.padEnd(6)} → server holds ${stored}`)
    if (!ok) failures.push(`picking ${f.key} stored ${stored} on the IMAP server`)
  }

  // --- the list shows the colour it stored ---
  const painted = await page.$eval(`[data-mail-row="${uid}"] svg.fill-current`, el => el.getAttribute('class'))
  const last = MAIL_FLAGS[MAIL_FLAGS.length - 1]
  const showsLast = painted?.includes(last.colorClass)
  console.log(`${showsLast ? 'ok  ' : 'FAIL'} row paints ${last.key} (class "${painted}")`)
  if (!showsLast) failures.push(`the row does not paint ${last.key} after it was stored`)

  // --- removing the flag clears it server-side ---
  await openMenu()
  await page.click('[data-flag=""]')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const cleared = await serverFlag()
  console.log(`${cleared === null ? 'ok  ' : 'FAIL'} remove → server holds ${cleared}`)
  if (cleared !== null) failures.push(`removing the flag left ${cleared} on the IMAP server`)
} finally {
  await browser.close()
  const c = await imap()
  try {
    await c.mailboxOpen(FOLDER)
    await c.messageDelete(uid, { uid: true })
    console.log(`bench message deleted from ${FOLDER}`)
  } finally { await c.logout() }
}

if (failures.length) {
  console.error(`\ncheck-mail-flags: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\ncheck-mail-flags: OK')
