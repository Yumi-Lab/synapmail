#!/usr/bin/env node
/**
 * Measures the explorer-style selection of the message list on the running app,
 * with REAL clicks and REAL keystrokes: Cmd/Ctrl-click toggles one row at a
 * time, Shift-click extends an exact range from the last clicked row, Cmd/Ctrl+A
 * takes everything loaded, Escape empties the selection. It also checks the
 * reading pane's Archive button now carries an action (it was dead).
 *
 * The count is NOT recomputed by the bench: it is read out of the list's own
 * `data-mail-selection-count` attribute, which the component publishes from the
 * same state the shared context exposes. A bench-side count could agree with a
 * broken component; this one cannot.
 *
 * Nothing is moved, deleted or flagged: every assertion is about selection state.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-mail-selection.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
// The list settles well under this: a click only re-renders rows, no network call.
const SETTLE_MS = 400
// Enough rows to make a 3-row range meaningful; below this the bench cannot conclude.
const MIN_ROWS = 4

// The attribute name is read from the shipped module, so a rename there fails
// here instead of silently measuring an attribute nobody writes any more.
const MODULE_SRC = readFileSync(new URL('../lib/mailSelection.tsx', import.meta.url), 'utf8')
const COUNT_ATTR = MODULE_SRC.match(/MAIL_SELECTION_COUNT_ATTR = '([^']+)'/)?.[1]
if (!COUNT_ATTR) { console.error('HARNESS: could not read MAIL_SELECTION_COUNT_ATTR from lib/mailSelection.tsx'); process.exit(2) }

const LIST = `[${COUNT_ATTR}]`
const ROW = '[data-mail-row]'

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
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

  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(ROW, { timeout: 30000 })
  await new Promise(r => setTimeout(r, SETTLE_MS))

  const rowCount = await page.$$eval(ROW, els => els.length)
  console.log(`rows loaded: ${rowCount}`)
  if (rowCount < MIN_ROWS) { console.error(`HARNESS: only ${rowCount} rows loaded, need ${MIN_ROWS} to exercise a range`); process.exit(2) }

  const readCount = () => page.$eval(LIST, (el, attr) => Number(el.getAttribute(attr)), COUNT_ATTR)
  const clickRow = async (index, modifier) => {
    const handle = (await page.$$(ROW))[index]
    if (!handle) { console.error(`HARNESS: row ${index} vanished before the click`); process.exit(2) }
    if (modifier) await page.keyboard.down(modifier)
    await handle.click()
    if (modifier) await page.keyboard.up(modifier)
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }
  // macOS reports Meta; everything else reports Control. The bench follows the
  // platform it runs on rather than assuming one.
  const ACCEL = process.platform === 'darwin' ? 'Meta' : 'Control'

  const check = (label, got, want) => {
    console.log(`${label}: count=${got} (expected ${want})`)
    if (got !== want) failures.push(`${label}: selection holds ${got} messages, expected ${want}`)
  }

  // --- Cmd/Ctrl-click twice → exactly two selected ---
  await clickRow(0, ACCEL)
  check('accel-click row 0', await readCount(), 1)
  await clickRow(2, ACCEL)
  check('accel-click row 2', await readCount(), 2)

  // --- Escape empties ---
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check('Escape', await readCount(), 0)

  // --- Shift-click extends an EXACT range from the last clicked row ---
  // Anchor on row 0 with an accel-click (which does not open the reading pane),
  // then extend to row 2: rows 0,1,2 = three messages, no more, no less.
  await clickRow(0, ACCEL)
  await clickRow(2, 'Shift')
  check('shift-click row 0 → row 2', await readCount(), 3)

  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))

  // --- Cmd/Ctrl+A takes everything loaded ---
  // The reference is the number of rows in the DOM in this SAME run, not a
  // constant: a list that loaded more or fewer rows still gives a valid check.
  await page.keyboard.down(ACCEL)
  await page.keyboard.press('a')
  await page.keyboard.up(ACCEL)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const allCount = await readCount()
  const rowsNow = await page.$$eval(ROW, els => els.length)
  console.log(`select-all: count=${allCount} rows=${rowsNow}`)
  if (allCount !== rowsNow) failures.push(`select-all: selection holds ${allCount} messages for ${rowsNow} loaded rows`)

  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check('Escape after select-all', await readCount(), 0)

  // --- The reading pane's Archive button carries an action ---
  // Opening a message and reading the button's own disabled state is what tells
  // a wired button from the dead one shipped before this lot. No click: archiving
  // would move a real message out of a real mailbox.
  await clickRow(0)
  await page.waitForSelector('[data-reading-archive]', { timeout: 20000 })
  const archive = await page.$eval('[data-reading-archive]', el => ({
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
  }))
  console.log(`reading-pane archive: disabled=${archive.disabled}`)
  if (archive.disabled) failures.push('reading pane: the Archive button is still inert with a message open')
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\ncheck-mail-selection: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\ncheck-mail-selection: OK')
