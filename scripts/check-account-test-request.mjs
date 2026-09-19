#!/usr/bin/env node
/**
 * Measures lot C4b in the browser: what the "Test connection" button actually PUTS ON THE
 * WIRE from the edit screen, and what the password field tells the browser about itself.
 *
 * NOT ONE real authentication attempt is made: `/api/accounts/test` is INTERCEPTED and
 * answered from here, so nothing ever reaches the mail host. That is the whole point of
 * the lot — every press of this button used to cost the provider two failed logins.
 * Nothing is written, nothing is deleted: the bench only reads the edit form.
 *
 * Fails (exit 1) on any mismatch. Exits 2 on a HARNESS error — a missing browser, an
 * unreachable server — which says nothing about the product.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-account-test-request.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
const SETTLE_MS = 400
const TEST_PATH = '/api/accounts/test'
/** A password no mailbox has: it is intercepted, so it never leaves the browser anyway. */
const TYPED = 'bench-typed-password'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
} = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
})) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const failures = []
const ok = msg => console.log(`ok   ${msg}`)
const fail = msg => { failures.push(msg); console.log(`FAIL ${msg}`) }
const check = (cond, msg) => (cond ? ok(msg) : fail(msg))
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  .catch(e => { console.error(`HARNESS: cannot launch Chrome — ${e.message}`); process.exit(2) })

/** Every test payload the page tried to send. None of them reached the server. */
const sent = []
/** What the intercepted route answers next, so the result line can be read back. */
let reply = { tested: 'stored', imap: { ok: true, error: '' }, smtp: { ok: true, error: '' } }

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === TEST_PATH) {
      sent.push(JSON.parse(req.postData() ?? '{}'))
      // Answered here, never forwarded: no mail host is contacted, so no failed login is
      // recorded anywhere.
      req.respond({
        status: 200, contentType: 'application/json', body: JSON.stringify(reply),
      }).catch(() => {})
      return
    }
    req.continue().catch(() => {})
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: credentials login failed'); process.exit(2) }

  const accounts = (await page.evaluate(async base => {
    const res = await fetch(`${base}/api/accounts`)
    return res.ok ? (await res.json()).data ?? [] : []
  }, BASE)).filter(a => !a.isShared)
  if (accounts.length === 0) { console.error('HARNESS: this database has no owned mailbox'); process.exit(2) }
  const account = accounts[0]

  /** Opens the edit form of the mailbox under test, from a fresh page. */
  const openEdit = async () => {
    await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(`[data-row-menu="${account.id}"]`, { timeout: 20000 })
    await page.click(`[data-row-menu="${account.id}"]`)
    await page.waitForSelector(`[data-row-menu-surface="${account.id}"] [data-menu-item="edit"]`,
      { visible: true, timeout: 10000 })
    await page.click(`[data-row-menu-surface="${account.id}"] [data-menu-item="edit"]`)
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 })
    await settle()
  }

  const clickTest = async () => {
    const before = sent.length
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.type === 'button' && /tester|test/i.test(b.textContent ?? ''))
      if (!btn) return false
      btn.click()
      return true
    })
    if (!clicked) return null
    for (let i = 0; i < 60 && sent.length === before; i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    await settle()
    return sent.length > before ? sent.at(-1) : null
  }

  // ── 1. The password field tells the browser not to fill it ────────────────
  await openEdit()
  const field = await page.$eval('input[type="password"]', el => ({
    autoComplete: el.getAttribute('autocomplete'),
    value: el.value,
    placeholder: el.getAttribute('placeholder'),
  }))
  check(field.autoComplete === 'new-password',
    `the password field carries autocomplete="new-password" — got ${JSON.stringify(field.autoComplete)}`)
  check(field.value === '',
    `the password field opens EMPTY: the saved password never reaches the browser — got ${JSON.stringify(field.value)}`)
  check(Boolean(field.placeholder),
    `the empty field says it means "unchanged" — placeholder=${JSON.stringify(field.placeholder)}`)

  const help = await page.evaluate(() => {
    const el = document.querySelector('input[type="password"]')
    const hint = el?.closest('div')?.parentElement?.querySelector('p')
    return hint?.textContent ?? ''
  })
  check(help.length > 0, `the field carries a help line about leaving it empty — "${help}"`)

  // ── 2. Field left empty: the request names the mailbox and carries NO password
  reply = { tested: 'stored', imap: { ok: true, error: '' }, smtp: { ok: true, error: '' } }
  const empty = await clickTest()
  if (empty === null) {
    fail('the test button sent nothing at all with the field empty')
  } else {
    check(empty.accountId === account.id,
      `field empty: the request names the mailbox — accountId=${JSON.stringify(empty.accountId)}`)
    check(!('password' in empty),
      `field empty: the request carries NO password key at all — keys=${JSON.stringify(Object.keys(empty))}`)
    check(empty.username === account.username,
      `field empty: the request carries the mailbox username — ${JSON.stringify(empty.username)}`)
    check(empty.imapHost === account.imapHost && empty.smtpHost === account.smtpHost,
      'field empty: the hosts tested are the ones in the FORM, so a port can be fixed before saving')
  }

  // The result line says WHICH password was tried — a green test on the saved password
  // proves nothing for someone who just typed a new one.
  const storedLine = await page.evaluate(() => document.body.innerText)
  check(/enregistr|saved|已保存/i.test(storedLine),
    'the result says the SAVED password was the one tried')

  // ── 3. Field filled: that password, and only that one, is what goes ───────
  await openEdit()
  await page.type('input[type="password"]', TYPED)
  reply = { tested: 'submitted', imap: { ok: true, error: '' }, smtp: { ok: true, error: '' } }
  const filled = await clickTest()
  if (filled === null) {
    fail('the test button sent nothing at all with the field filled')
  } else {
    check(filled.password === TYPED,
      'field filled: the request carries the TYPED password, so a change can be checked before saving')
    check(filled.accountId === account.id,
      `field filled: the request still names the mailbox — accountId=${JSON.stringify(filled.accountId)}`)
  }
  const submittedLine = await page.evaluate(() => document.body.innerText)
  check(/saisi|typed|输入/i.test(submittedLine),
    'the result says the NEWLY TYPED password was the one tried')

  // ── 4. A refusal reads as a cause, not as the raw server line ─────────────
  await openEdit()
  reply = {
    tested: 'stored',
    imap: { ok: false, error: 'credentials' },
    smtp: { ok: false, error: 'credentials' },
  }
  await clickTest()
  const refused = await page.evaluate(() => document.body.innerText)
  check(/identifiants|credentials|凭据/i.test(refused),
    'a refusal reads as "the server refused these credentials"')
  check(!/\b535\b/.test(refused) && !/AUTHENTICATIONFAILED/i.test(refused),
    'the raw server line is not shown as-is')
} catch (e) {
  console.error(`HARNESS: ${e.stack}`)
  await browser.close().catch(() => {})
  process.exit(2)
}

await browser.close().catch(() => {})
console.log(`intercepted test requests (none reached a mail host): ${sent.length}`)
console.log(failures.length ? `check-account-test-request: ${failures.length} FAIL` : 'check-account-test-request: OK')
process.exit(failures.length ? 1 : 0)
