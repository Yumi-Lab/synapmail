#!/usr/bin/env node
/**
 * Measures the account unread BADGE, in both directions, in ONE pass, on the
 * running app — the defect Nicolas reported on 2026-09-21: "the number in the
 * badge does not move when a mail arrives unread or when I read one".
 *
 * Direction UP: a message is APPENDed unread into the watched mailbox over a
 * SEPARATE IMAP connection, and the bench waits for the badge to rise.
 * Direction DOWN: that same message is opened in the reading pane, and the
 * bench waits for the badge to fall back.
 *
 * Both are measured against the SAME badge the user looks at, read from the DOM
 * as drawn, never from an API response: a route that returns the right number
 * while the screen shows the old one is exactly the defect under test.
 *
 * What keeps this from being a polling measurement: the deadlines are read from
 * the shipped components' OWN refresh intervals, and the bench requires each
 * deadline to be a small fraction of them, so a badge that only moved because a
 * periodic refetch happened to fire cannot pass. The bench also demands a QUIET
 * window (no /api/accounts call) before the append, so the refetch that follows
 * is provably caused by it.
 *
 * Nothing touches real mail: the bench appends ITS OWN message and expunges
 * exactly that uid at the end. No other message is read, moved or deleted.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node --experimental-strip-types scripts/check-unread-badge.mjs
 *
 * Negative control — proves the bench can see the defect it exists for:
 *   node --experimental-strip-types scripts/check-unread-badge.mjs --no-signal
 * cuts every refetch of the accounts key, so the badge keeps the value it was
 * rendered with, and EXPECTS the run to fail.
 *
 * WHAT THE CONTROL COVERS, exactly: the UP direction only. The DOWN direction
 * is an optimistic write into the SWR cache — no request — so refusing requests
 * cannot remove it, and the control says nothing about it. What does stand in
 * for it is a measurement taken on this same bench: with the shift placed in
 * the reading pane (i.e. after the message's IMAP round trip) the badge fell
 * after 1029 ms against a 1000 ms ceiling, and the run FAILED; moved onto the
 * click itself it falls in 5 ms. The 1 s deadline is out of reach of any round
 * trip, which is the whole reason it is set there.
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { ImapFlow } from 'imapflow'
import { IDLE_FOLDER } from '../lib/stream.ts'
import { decrypt } from '../lib/encrypt.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

// The DoD's two deadlines (GOAL.md, lot H4i, decided by the human 2026-09-21):
// the arrival must show within 15s WITHOUT a reload, and reading a message must
// drop the badge within 1s. The second is an optimistic-update budget, not a
// round trip: the screen must not wait for the server to answer.
// Calibration bench: IONOS IMAP, test account, dev server on :3105, commit 139d200.
const UP_MS = 15000
const DOWN_MS = 1000
// No /api/accounts call may happen during this window before the append: it is
// what proves the refetch that follows was caused by the append, not by a poll.
const QUIET_MS = 3000
const POLL_MS = 50

/** `--no-signal` neutralises lib/unreadSignal.ts: the negative control. */
const NO_SIGNAL = process.argv.includes('--no-signal')

// The deadlines must be provably out of reach of the periodic refetches, read
// from the shipped components: bumping an interval there cannot silently turn
// this bench into a polling measurement.
const SRC_OF = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const INTERVAL_OF = (file) => Number(SRC_OF(file).match(/refreshInterval:\s*(\d+)/)?.[1])

// The SWR key the badge reads, taken from the shipped module rather than retyped:
// a bench that hardcoded it would keep passing after the key changed under it.
// Read as TEXT, not imported — `lib/unreadSignal.ts` is a client module whose own
// imports are extensionless, which node's type stripping cannot resolve.
const ACCOUNTS_KEY = SRC_OF('lib/unreadSignal.ts').match(/ACCOUNTS_KEY = '([^']+)'/)?.[1]
if (!ACCOUNTS_KEY) { console.error('HARNESS: could not read ACCOUNTS_KEY from lib/unreadSignal.ts'); process.exit(2) }

// Above this the badge reads `99+` and a change of one is INVISIBLE — the bench
// would be measuring a cap, not a count. Read from the shipped component so the
// two can never disagree about where the readable range ends.
const UNREAD_CAP = Number(SRC_OF('components/layout/AccountAvatar.tsx').match(/UNREAD_CAP = (\d+)/)?.[1])
if (!UNREAD_CAP) { console.error('HARNESS: could not read UNREAD_CAP from components/layout/AccountAvatar.tsx'); process.exit(2) }
const ACCOUNTS_REFRESH_MS = INTERVAL_OF('components/layout/AccountAvatar.tsx')
const LIST_REFRESH_MS = INTERVAL_OF('components/layout/MessageList.tsx')
for (const [name, ms] of [['AccountAvatar.tsx', ACCOUNTS_REFRESH_MS], ['MessageList.tsx', LIST_REFRESH_MS]]) {
  if (!ms) { console.error(`HARNESS: could not read refreshInterval from ${name}`); process.exit(2) }
  if (ms < UP_MS * 4) {
    console.error(`HARNESS: ${name} refetches every ${ms}ms, too close to the ${UP_MS}ms deadline — the bench could not tell a push from a poll`)
    process.exit(2)
  }
}

// The badge of the ACTIVE account, in the sidebar header — what the user reads.
const BADGE = '[data-sidebar-row="account"] [data-unread-badge]'
const ROW = '[data-mail-row]'

for (const file of ['../.env', '../.env.local']) {
  for (const line of readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

// The account the UI actually shows: the one the user settings point at, else
// the default one. Appending to any other account would measure nothing.
const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
// The mailbox must be under the badge's cap, or a change of one cannot be READ
// on screen. Real mailboxes here sit well past it, so the bench picks the
// nearest one under the cap and makes it active for the duration, restoring the
// user's own choice at the end — rather than reporting a pass it cannot see.
const { rows } = await pool.query(
  `SELECT a.*, u.id AS owner_id, s.active_account_id, COALESCE(ms.unread_count, 0) AS unread
     FROM email_accounts a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN user_settings s ON s.user_id = u.id
     LEFT JOIN mailbox_stats ms ON ms.account_id = a.id AND ms.folder = $2
   WHERE u.email = $1
   ORDER BY (a.id = s.active_account_id) DESC, a.is_default DESC, a.created_at`,
  [EMAIL, IDLE_FOLDER])
const readable = rows.filter(r => Number(r.unread) < UNREAD_CAP)
const acc = readable[0]
if (!rows.length) { await pool.end(); console.error(`HARNESS: no email account for ${EMAIL}`); process.exit(2) }
if (!acc) {
  await pool.end()
  console.error(`HARNESS: every mailbox of ${EMAIL} is at or past the ${UNREAD_CAP}-unread cap, where a change of one is not readable on screen`)
  process.exit(2)
}
const previousActive = rows[0].active_account_id
const restoreActive = previousActive !== acc.id
if (restoreActive) {
  await pool.query('UPDATE user_settings SET active_account_id = $1 WHERE user_id = $2', [acc.id, acc.owner_id])
  console.log(`active account moved to ${acc.email} (${acc.unread} unread, under the ${UNREAD_CAP} cap) for the duration of the bench`)
}

const imap = async () => {
  const c = new ImapFlow({
    host: acc.imap_host, port: acc.imap_port, secure: acc.imap_secure,
    auth: { user: acc.username, pass: decrypt(acc.password_encrypted) },
    logger: false, tls: { rejectUnauthorized: false },
  })
  await c.connect()
  return c
}

const SUBJECT = `check-unread-badge ${Date.now()}`
const failures = []
const fail = (m) => { failures.push(m); console.error(`FAIL: ${m}`) }
let uid = null

/** Flipped once the baseline badge is painted — see the negative control. */
let benchStarted = false

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  if (NO_SIGNAL) {
    // Negative control: every refetch of the accounts key is refused, so the
    // badge has nothing left but the value it was rendered with. This is
    // STRICTER than the behaviour before this lot (which still had the 60s
    // tick) and that is the point — the deadlines here are 15s and 1s, both
    // well inside one tick, so the interval could never have satisfied them
    // anyway. If the bench still passes with the key cut off, it is not
    // measuring the signal at all.
    await page.setRequestInterception(true)
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.pathname === ACCOUNTS_KEY && r.method() === 'GET' && benchStarted) r.abort().catch(() => {})
      else r.continue().catch(() => {})
    })
  }

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

  // Every accounts refetch is timestamped: this separates "pushed" from "polled".
  const accountCalls = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === ACCOUNTS_KEY) accountCalls.push(Date.now())
  })

  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(ROW, { timeout: 30000 })
  // From here on the control bites: the first load must be allowed through, or
  // the badge would never have a baseline to move away from.
  benchStarted = true

  // The badge as DRAWN. Absent means zero: the component renders nothing at 0.
  const badge = () => page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return 0
    const text = el.textContent.trim()
    // `99+` is a cap, not a number: the bench must not read it as 99 and then
    // demand an exact +1, which the screen cannot show.
    return text.endsWith('+') ? null : Number(text)
  }, BADGE)

  const before = await badge()
  console.log(`badge before the append: ${before === null ? '99+ (capped)' : before}`)
  if (before === null) {
    console.error('HARNESS: the badge is capped at 99+, so a change of one cannot be read — use a mailbox under 99 unread')
    process.exit(2)
  }

  // Quiet window: no accounts refetch at all, so the one that follows is the append's.
  const quietFrom = Date.now()
  await new Promise(r => setTimeout(r, QUIET_MS))
  const duringQuiet = accountCalls.filter(t => t >= quietFrom).length
  console.log(`accounts refetches during the ${QUIET_MS}ms quiet window: ${duringQuiet} (expected 0)`)
  if (duringQuiet > 0) { console.error('HARNESS: the badge refetched while idle — cannot attribute the next refetch to the append'); process.exit(2) }

  // --- UP: append an UNREAD message into the watched mailbox ---
  {
    const c = await imap()
    try {
      await c.mailboxOpen(IDLE_FOLDER)
      const raw = Buffer.from(
        `From: lane bench <${acc.email}>\r\nTo: lane bench <${acc.email}>\r\n` +
        `Subject: ${SUBJECT}\r\nDate: ${new Date().toUTCString()}\r\n` +
        `Message-ID: <${SUBJECT.replace(/\s/g, '-')}@yumi-lab.com>\r\n\r\nbench message\r\n`)
      // No \\Seen: the whole point is that it arrives UNREAD.
      uid = String((await c.append(IDLE_FOLDER, raw, [])).uid)
    } finally { await c.logout() }
  }
  const appendedAt = Date.now()
  console.log(`appended uid ${uid} to ${IDLE_FOLDER} unread, subject "${SUBJECT}"`)

  let roseAt = null
  while (Date.now() - appendedAt < UP_MS) {
    if ((await badge()) === before + 1) { roseAt = Date.now(); break }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  const upMs = (roseAt ?? Date.now()) - appendedAt
  console.log(`badge rose to ${before + 1} after ${upMs}ms (ceiling ${UP_MS}ms, periodic refetch every ${ACCOUNTS_REFRESH_MS}ms)`)
  if (!roseAt) fail(`the badge did not rise to ${before + 1} within ${UP_MS}ms of an unread message arriving`)

  const pushed = accountCalls.filter(t => t >= appendedAt).length
  console.log(`accounts refetches caused by the append: ${pushed} (expected at least 1)`)
  if (roseAt && pushed < 1) fail('the badge changed without any refetch — measurement is not trustworthy')

  // --- DOWN: open that same message and watch the badge fall ---
  if (roseAt) {
    await page.waitForSelector(ROW, { timeout: 10000 })
    const clicked = await page.evaluate((sel, subject) => {
      const row = [...document.querySelectorAll(sel)].find(el => el.textContent.includes(subject))
      if (!row) return false
      row.click()
      return true
    }, ROW, SUBJECT)
    if (!clicked) { console.error(`HARNESS: the appended row "${SUBJECT}" is not in the list to click`); process.exit(2) }
    const openedAt = Date.now()

    let fellAt = null
    while (Date.now() - openedAt < DOWN_MS) {
      if ((await badge()) === before) { fellAt = Date.now(); break }
      await new Promise(r => setTimeout(r, POLL_MS))
    }
    const downMs = (fellAt ?? Date.now()) - openedAt
    console.log(`badge fell back to ${before} after ${downMs}ms (ceiling ${DOWN_MS}ms)`)
    if (!fellAt) fail(`the badge did not fall back to ${before} within ${DOWN_MS}ms of the message being opened`)
  } else {
    console.log('skipping the read measurement: the message never appeared to be read')
  }
} finally {
  await browser.close()
  if (restoreActive) {
    await pool.query('UPDATE user_settings SET active_account_id = $1 WHERE user_id = $2', [previousActive, acc.owner_id])
    console.log('active account restored to the user\'s own choice')
  }
  await pool.end()
  if (uid) {
    const c = await imap()
    try {
      await c.mailboxOpen(IDLE_FOLDER)
      await c.messageDelete(uid, { uid: true })
      console.log(`bench message uid ${uid} deleted from ${IDLE_FOLDER}`)
    } catch (err) {
      console.error(`HARNESS: could not delete bench message uid ${uid}: ${err.message}`)
    } finally { await c.logout() }
  }
}

if (NO_SIGNAL) {
  if (failures.length) { console.log(`OK (negative control) — without lib/unreadSignal.ts the bench fails as it must: ${failures.length} failure(s)`); process.exit(0) }
  console.error('FAIL (negative control): the bench passed with the signal neutralised — it cannot see the defect it exists for')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nOK — the badge follows the mailbox, up and down')
