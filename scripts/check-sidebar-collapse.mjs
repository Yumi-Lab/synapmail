#!/usr/bin/env node
/**
 * Measures the sidebar collapse: every icon must keep its exact position and
 * every row its exact height when the bar folds. Then measures every account
 * bubble: the unread badge must sit ON the corner without covering the initial,
 * and the initial must stay readable on every colour of the palette.
 * Fails (exit 1) on any drift or any bubble under the thresholds.
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
// Badge geometry thresholds, from the human gate of 2026-09-17 that rejected a badge
// covering 37% of the bubble and 40% of the initial's text box: the badge may clip the
// bubble's corner, but the letter underneath must stay whole.
const MAX_BADGE_OVER_BUBBLE = 0.25
const MAX_BADGE_OVER_GLYPH = 0
// WCAG AA floor for small bold text — the initial is 9-12px, so 4.5:1 is the minimum.
const MIN_CONTRAST = 4.5
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

/**
 * Reads every account bubble: how much of it (and of its initial's text box) the
 * unread badge covers, and the contrast of the initial against the bubble colour.
 * Overlap is measured between bounding boxes — the same metric the human gate used.
 */
const probeBubbles = () => {
  const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number)
  const lum = c => {
    const [r, g, b] = rgb(c).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const overlap = (a, b) => {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return w * h
  }
  return [...document.querySelectorAll('[data-account-initial]')].map(glyph => {
    const bubble = glyph.parentElement
    const wrapper = bubble.parentElement
    const badge = wrapper.querySelector('[data-unread-badge]')
    const gr = glyph.getBoundingClientRect()
    const br = bubble.getBoundingClientRect()
    const dr = badge?.getBoundingClientRect()
    const style = getComputedStyle(bubble)
    return {
      where: wrapper.closest('[data-sidebar-row]') ? 'header' : 'popover row',
      initial: glyph.textContent,
      badgeText: badge?.textContent ?? '',
      overBubble: dr ? overlap(dr, br) / (br.width * br.height) : 0,
      overGlyph: dr && gr.width && gr.height ? overlap(dr, gr) / (gr.width * gr.height) : 0,
      bg: style.backgroundColor,
      contrast: contrast(style.backgroundColor, getComputedStyle(glyph).color),
    }
  })
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

  // --- Account bubbles: badge on the corner, initial readable on every colour ---
  await toggle() // back to expanded, so the header bubble carries its label too
  await page.click('[data-sidebar-row="account"]')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const bubbles = await page.evaluate(probeBubbles)
  if (!bubbles.length) { console.error('HARNESS: no account bubble found — popover did not open'); process.exit(2) }

  const withBadge = bubbles.filter(b => b.badgeText)
  console.log(`bubbles measured: ${bubbles.length} (with a badge: ${withBadge.length})`)
  if (!withBadge.length) { console.error('HARNESS: no bubble carries an unread badge — nothing to measure'); process.exit(2) }
  for (const b of bubbles) {
    const where = `${b.where} "${b.initial}" (${b.badgeText || 'no badge'})`
    console.log(`  ${where}: badge/bubble=${(b.overBubble * 100).toFixed(1)}% badge/glyph=${(b.overGlyph * 100).toFixed(1)}% contrast=${b.contrast.toFixed(2)} bg=${b.bg}`)
    if (b.overBubble > MAX_BADGE_OVER_BUBBLE) failures.push(`${where}: badge covers ${(b.overBubble * 100).toFixed(1)}% of the bubble (max ${(MAX_BADGE_OVER_BUBBLE * 100)}%)`)
    if (b.overGlyph > MAX_BADGE_OVER_GLYPH) failures.push(`${where}: badge covers ${(b.overGlyph * 100).toFixed(1)}% of the initial (max ${(MAX_BADGE_OVER_GLYPH * 100)}%)`)
    if (b.contrast < MIN_CONTRAST) failures.push(`${where}: initial contrast ${b.contrast.toFixed(2)}:1 on ${b.bg} (min ${MIN_CONTRAST}:1)`)
  }
  const palette = [...new Set(bubbles.map(b => b.bg))]
  console.log(`distinct bubble colours exercised: ${palette.length} (${palette.join(', ')})`)
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} drift(s) over ${MAX_DRIFT_PX}px`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`OK: no icon moved, no row height changed, no horizontal overflow (tolerance ${MAX_DRIFT_PX}px)`)
