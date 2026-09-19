#!/usr/bin/env node
/**
 * Measures lot C1: the colour a mailbox carries is the one its owner chose, it is the SAME
 * colour in the settings badge, in the sidebar bubble and in the bar's accent variable, and
 * whatever colour is picked the letters on it stay readable.
 *
 * Every mailbox touched is put back on `Automatic` in the `finally`, so the bench leaves the
 * database as it found it. Fails (exit 1) on any mismatch. Exits 2 on a HARNESS error — a
 * missing browser, an unreachable server, a database with no mailbox — which says nothing
 * about the product.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-account-color.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import {
  ACCOUNT_PALETTE, MIN_CONTRAST, accountColor, contrastRatio, readableInk,
} from '../lib/accountColor.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
// A colour that is NOT in the automatic palette, so \"the badge shows what was chosen\" cannot
// pass by accident on a mailbox whose rank colour happens to match.
const CHOSEN = '#0ea5e9'
// A colour light enough that white ink fails on it (measured: 1.32:1 against white): the ink
// rule has to flip to dark, or the initials become unreadable. This is the discriminating case.
const PALE = '#fde047'
// Hue tolerance between the settings badge, the sidebar bubble and `--synap-account`: they
// are the same hex resolved by the same function, so the only spread allowed is the rounding
// of `rgb()` serialisation. GOAL.md fixes this at 1 degree.
const MAX_HUE_SPREAD_DEG = 1
// Values the API must refuse. Not colours: a short hex, a CSS name, an injection attempt.
const REJECTED = ['#0ea5e', 'red', 'rgb(1,2,3)', '#0ea5e9; DROP TABLE', '']
const HTTP_BAD_REQUEST = 400
const SETTLE_MS = 600

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const failures = []
const ok = msg => console.log(`ok   ${msg}`)
const fail = msg => { failures.push(msg); console.log(`FAIL ${msg}`) }
const check = (cond, msg) => (cond ? ok(msg) : fail(msg))

/** `rgb(r, g, b)` as rendered by the browser → `#rrggbb`, so it can be compared to the source. */
const toHex = rgb => {
  const m = rgb.match(/\d+/g)
  return m ? '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('') : null
}
const hue = hex => {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => c / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueSpread = hexes => {
  const angles = hexes.map(hue)
  return Math.max(...angles.map(a => Math.min(...angles.map(b => Math.abs(a - b) > 180 ? 360 - Math.abs(a - b) : Math.abs(a - b)))))
    || Math.max(...angles) - Math.min(...angles)
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  .catch(e => { console.error(`HARNESS: cannot launch Chrome — ${e.message}`); process.exit(2) })

/** Every mailbox this run wrote to, so the `finally` can put each one back on Automatic. */
const touched = new Set()
let page

const patch = (id, badgeColor) => page.evaluate(async ({ base, id, badgeColor }) => {
  const res = await fetch(`${base}/api/accounts/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badgeColor }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}, { base: BASE, id, badgeColor })

/** The badge in settings, the bubble in the bar and the bar's accent, read from one render. */
const readPaint = (id, activeId) => page.evaluate(async ({ base, id, activeId, settle }) => {
  const paint = {}
  await new Promise(r => setTimeout(r, settle))
  const badge = document.querySelector(`[data-account-badge="${id}"]`)
  if (badge) {
    const s = getComputedStyle(badge)
    paint.badge = s.backgroundColor
    paint.badgeInk = s.color
    paint.badgeLetters = badge.querySelector('[data-account-initial]')?.textContent ?? ''
    paint.badgeBox = badge.getBoundingClientRect().width
  }
  const bar = document.querySelector('[data-sidebar]')
  if (bar && id === activeId) {
    paint.accent = getComputedStyle(bar).getPropertyValue('--synap-account').trim()
    const bubble = bar.querySelector('[data-sidebar-row="account"] [data-account-initial]')?.parentElement
    if (bubble) {
      paint.bubble = getComputedStyle(bubble).backgroundColor
      paint.bubbleInk = getComputedStyle(bubble).color
      paint.bubbleLetters = bubble.querySelector('[data-account-initial]')?.textContent ?? ''
    }
    const compose = bar.querySelector('[data-sidebar-row="compose"]')
    if (compose) {
      paint.compose = getComputedStyle(compose).backgroundColor
      paint.composeInk = getComputedStyle(compose).color
    }
  }
  return paint
}, { base: BASE, id, activeId, settle: SETTLE_MS })

try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)
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

  const accounts = (await page.evaluate(async base =>
    (await (await fetch(`${base}/api/accounts`)).json()).data ?? [], BASE)).filter(a => !a.isShared)
  if (accounts.length < 2) { console.error('HARNESS: this database has fewer than two owned mailboxes'); process.exit(2) }
  const target = accounts[0]
  const untouched = accounts[1]

  // BEFORE: what the mailboxes look like with nobody having chosen anything. The second one
  // is never written to, and its colour is compared again at the end — that is the
  // \"an existing mailbox does not change appearance\" criterion, measured, not asserted.
  await page.evaluate(async ({ base, id }) => {
    await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active_account_id: id }) })
  }, { base: BASE, id: target.id })
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-account-badge="${target.id}"]`, { timeout: 20000 })
  const before = await readPaint(target.id, target.id)
  const beforeUntouched = await readPaint(untouched.id, target.id)

  const autoTarget = accountColor({ badgeColor: target.badgeColor ?? null }, accounts.indexOf(target))
  check(toHex(before.badge) === autoTarget,
    `automatic colour of "${target.name || target.email}": badge ${toHex(before.badge)} = rank colour ${autoTarget}`)
  check(before.badgeLetters.length === 2 && before.badgeLetters === before.bubbleLetters,
    `settings badge carries the same two letters as the bar bubble — "${before.badgeLetters}" / "${before.bubbleLetters}"`)

  // CHOSEN colour: settings badge, bar bubble and the accent variable must agree.
  touched.add(target.id)
  const patched = await patch(target.id, CHOSEN)
  check(patched.status === 200 && patched.body?.data?.badgeColor === CHOSEN,
    `PATCH badgeColor=${CHOSEN} accepted and echoed — status ${patched.status}, got ${patched.body?.data?.badgeColor}`)
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-account-badge="${target.id}"]`, { timeout: 20000 })
  const after = await readPaint(target.id, target.id)
  const trio = [toHex(after.badge), toHex(after.bubble), after.accent].filter(Boolean)
  check(trio.length === 3, `settings badge, bar bubble and --synap-account all rendered — ${trio.join(' / ')}`)
  check(trio.every(c => c.toLowerCase() === CHOSEN), `all three carry the chosen colour ${CHOSEN} — ${trio.join(' / ')}`)
  check(hueSpread([...trio, CHOSEN]) <= MAX_HUE_SPREAD_DEG,
    `hue spread across badge / bubble / accent ≤ ${MAX_HUE_SPREAD_DEG} deg — ${hueSpread([...trio, CHOSEN]).toFixed(2)}`)

  // PALE colour: the ink has to flip, on the bubble AND on the compose control.
  await patch(target.id, PALE)
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-account-badge="${target.id}"]`, { timeout: 20000 })
  const pale = await readPaint(target.id, target.id)
  for (const [surface, bg, ink] of [
    ['settings badge', pale.badge, pale.badgeInk],
    ['bar bubble', pale.bubble, pale.bubbleInk],
    ['compose control', pale.compose, pale.composeInk],
  ]) {
    if (!bg || !ink) { fail(`${surface} did not render on ${PALE} — nothing to measure`); continue }
    const ratio = contrastRatio(toHex(bg), toHex(ink))
    check(ratio >= MIN_CONTRAST, `${surface} on ${PALE}: ink ${toHex(ink)} reads ${ratio.toFixed(2)}:1 ≥ ${MIN_CONTRAST}`)
  }
  // Same rule, computed rather than rendered, over every palette colour plus the two probes:
  // no colour this product can carry may be left without a readable ink.
  for (const colour of [...ACCOUNT_PALETTE, CHOSEN, PALE]) {
    const ratio = contrastRatio(colour, readableInk(colour))
    check(ratio >= MIN_CONTRAST, `readable ink exists for ${colour} — ${readableInk(colour)} at ${ratio.toFixed(2)}:1`)
  }

  // The API is the boundary: what is not a colour is refused, and nothing is written.
  for (const bad of REJECTED) {
    const res = await patch(target.id, bad)
    check(res.status === HTTP_BAD_REQUEST, `PATCH badgeColor=${JSON.stringify(bad)} refused — status ${res.status} (want ${HTTP_BAD_REQUEST})`)
  }
  const stillPale = await page.evaluate(async ({ base, id }) =>
    ((await (await fetch(`${base}/api/accounts`)).json()).data ?? []).find(a => a.id === id)?.badgeColor,
    { base: BASE, id: target.id })
  check(stillPale === PALE, `a refused colour wrote nothing — mailbox still on ${PALE}, got ${stillPale}`)

  // Automatic puts the rank colour back, exactly the one measured before anything was chosen.
  const auto = await patch(target.id, null)
  check(auto.status === 200 && auto.body?.data?.badgeColor === null, `PATCH badgeColor=null accepted — status ${auto.status}`)
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-account-badge="${target.id}"]`, { timeout: 20000 })
  const restored = await readPaint(target.id, target.id)
  check(toHex(restored.badge) === toHex(before.badge),
    `Automatic restores the original colour — ${toHex(restored.badge)} = ${toHex(before.badge)}`)
  check(toHex(beforeUntouched.badge) === toHex((await readPaint(untouched.id, target.id)).badge),
    `the mailbox nobody touched kept its colour — ${toHex(beforeUntouched.badge)}`)
} catch (e) {
  console.error(`HARNESS: ${e.stack}`)
  process.exit(2)
} finally {
  // Every mailbox this run wrote to goes back to Automatic, whatever happened above.
  if (page) for (const id of touched) await patch(id, null).catch(() => {})
  await browser.close().catch(() => {})
}

console.log(failures.length ? `check-account-color: ${failures.length} FAIL` : 'check-account-color: OK')
process.exit(failures.length ? 1 : 0)
