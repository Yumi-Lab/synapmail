#!/usr/bin/env node
/**
 * Measures the sidebar collapse: every icon must keep its exact position and
 * every row its exact height when the bar folds. Fails (exit 1) on any drift.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-sidebar-collapse.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Tolerance for a position/size drift, in CSS pixels. Sub-pixel layout rounding
// is expected; anything a human could see is not. GOAL.md fixes this at 1 px.
const MAX_DRIFT_PX = 1
const VIEWPORT = { width: 1440, height: 900 }
// Transition is 180 ms (SIDEBAR.transitionMs); wait well past it before measuring.
const SETTLE_MS = 600

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

/** Reads the geometry of every sidebar icon and row, keyed so both states match up. */
const probe = () => {
  const bar = document.querySelector('[data-sidebar]')
  if (!bar) return null
  const rows = [...bar.querySelectorAll('[data-sidebar-row]')]
  return {
    collapsed: bar.dataset.collapsed,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    rows: rows.map((row, i) => {
      const r = row.getBoundingClientRect()
      // Explicit marker — never selector order, which a badge or a decoration could steal.
      const iconEl = row.querySelector('[data-sidebar-icon]')
      const ic = iconEl?.getBoundingClientRect()
      return {
        key: row.dataset.sidebarRow,
        rowHeight: r.height,
        iconX: ic ? ic.x : null,
        iconY: ic ? ic.y : null,
        iconW: ic ? ic.width : null,
        iconH: ic ? ic.height : null,
      }
    }),
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
let failures = []
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  // Sign in through the credentials endpoint, then land on /mail.
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
  await page.waitForSelector('[data-sidebar] [data-sidebar-row]', { timeout: 20000 })
  // Let the folder list settle so both states measure the same set of rows.
  await new Promise(r => setTimeout(r, 2500))

  const toggle = async () => {
    await page.click('[data-sidebar] [data-sidebar-row]')
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }

  let before = await page.evaluate(probe)
  if (before.collapsed === 'true') { await toggle(); before = await page.evaluate(probe) }
  if (before.collapsed !== 'false') { console.error('HARNESS: could not reach the expanded state'); process.exit(2) }

  await toggle()
  const after = await page.evaluate(probe)
  if (after.collapsed !== 'true') { console.error('HARNESS: could not reach the collapsed state'); process.exit(2) }

  const withIcon = s => s.rows.filter(r => r.iconX != null).length
  console.log(`rows measured: expanded=${before.rows.length} collapsed=${after.rows.length}`)
  console.log(`rows carrying a measurable icon: expanded=${withIcon(before)} collapsed=${withIcon(after)}`)
  // A row whose icon is skipped is not measured — a selector matching nothing would
  // otherwise make this check pass vacuously.
  for (const s of [before, after]) {
    if (withIcon(s) !== s.rows.length) {
      failures.push(`${s.rows.length - withIcon(s)} row(s) have no [data-sidebar-icon] while collapsed=${s.collapsed} — unmeasured`)
    }
  }
  if (before.rows.length !== after.rows.length) {
    failures.push(`row count changed: ${before.rows.length} → ${after.rows.length} (icons were unmounted)`)
  }
  for (const [i, b] of before.rows.entries()) {
    const a = after.rows[i]
    if (!a) continue
    if (b.key !== a.key) failures.push(`row ${i}: identity changed (${b.key} → ${a.key})`)
    for (const f of ['iconX', 'iconY', 'iconW', 'iconH', 'rowHeight']) {
      if (b[f] == null || a[f] == null) continue
      const drift = Math.abs(a[f] - b[f])
      if (drift > MAX_DRIFT_PX) failures.push(`row ${i} (${b.key}): ${f} moved ${drift.toFixed(2)}px (${b[f].toFixed(2)} → ${a[f].toFixed(2)})`)
    }
  }
  for (const s of [before, after]) {
    if (s.horizontalOverflow) failures.push(`horizontal scrollbar present while collapsed=${s.collapsed}`)
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} drift(s) over ${MAX_DRIFT_PX}px`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`OK: no icon moved, no row height changed, no horizontal overflow (tolerance ${MAX_DRIFT_PX}px)`)
