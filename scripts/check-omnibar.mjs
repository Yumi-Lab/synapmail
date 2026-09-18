#!/usr/bin/env node
/**
 * Measures the application header (`components/layout/Omnibar.tsx`) on the running
 * app: it is present on every page, it spans the whole window width above the
 * sidebar, its height is the one the component exports, Cmd/Ctrl+K focuses the
 * field, Escape clears it, and REAL clicks on the three actions reach the
 * dashboard / the compose window / the settings. Also checks the sidebar no longer
 * carries a dashboard row, and that nothing overflows horizontally at 390px.
 * Fails (exit 1) on any drift.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-omnibar.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Tolerance for a position/size drift, in CSS pixels — same floor as the sidebar
// gate: sub-pixel layout rounding is expected, anything a human could see is not.
const MAX_DRIFT_PX = 1
const VIEWPORT = { width: 1440, height: 900 }
const MOBILE_VIEWPORT = { width: 390, height: 844 }
// Pages the header must be present on, per GOAL.md lot O1.
const PAGES = ['/mail', '/dashboard', '/settings']
// The header's height is NOT an absolute constant calibrated elsewhere: it is read
// out of the component's own `OMNIBAR` export in this same run, so the shipped value
// and the measured value cannot drift apart. A hand-retyped height fails here.
const OMNIBAR_SOURCE = new URL('../components/layout/Omnibar.tsx', import.meta.url)
const EXPECTED_HEIGHT = Number(readFileSync(OMNIBAR_SOURCE, 'utf8').match(/height:\s*(\d+)/)?.[1])
if (!EXPECTED_HEIGHT) { console.error('HARNESS: could not read OMNIBAR.height from the component'); process.exit(2) }

const BAR = '[data-omnibar]'
const SEARCH = '[data-omnibar-search]'
const MENU = '[data-omnibar-menu]'
const action = name => `[data-omnibar-action="${name}"]`
// Navigations and the compose window settle well under this; the bar's own
// transitions are colour-only (no layout animation to wait out).
const SETTLE_MS = 600

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

/**
 * Reads the header's box against the window and against the sidebar, in one frame.
 * `aboveSidebar` is what tells a full-width application header apart from a bar
 * confined to the content column: the header's left edge must reach the window's,
 * and its bottom must sit above the sidebar's top.
 */
const probeBar = sel => {
  const bar = document.querySelector(sel)
  if (!bar) return null
  const r = bar.getBoundingClientRect()
  const aside = document.querySelector('aside')
  const ar = aside?.getBoundingClientRect()
  const style = getComputedStyle(bar)
  return {
    height: r.height,
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    windowWidth: document.documentElement.clientWidth,
    asideTop: ar && ar.height ? ar.top : null,
    background: style.backgroundColor,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    // Decorative animation is forbidden by GOAL.md: the header's state is static.
    animated: [bar, ...bar.querySelectorAll('*')].some(el => {
      const st = getComputedStyle(el)
      return st.animationName !== 'none' && st.animationDuration !== '0s'
    }),
  }
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

  // --- Present on every page, with the exported height, spanning the window ---
  console.log(`expected height, read from Omnibar.tsx: ${EXPECTED_HEIGHT}px`)
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(BAR, { timeout: 20000 })
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const bar = await page.evaluate(probeBar, BAR)
    if (!bar) { failures.push(`${path}: no ${BAR} in the document`); continue }
    console.log(`${path}: height=${bar.height.toFixed(2)}px left=${bar.left.toFixed(2)} right=${bar.right.toFixed(2)}/${bar.windowWidth} asideTop=${bar.asideTop?.toFixed(2) ?? 'n/a'}`)
    const drift = Math.abs(bar.height - EXPECTED_HEIGHT)
    if (drift > MAX_DRIFT_PX) failures.push(`${path}: header is ${bar.height.toFixed(2)}px tall, expected ${EXPECTED_HEIGHT}px (drift ${drift.toFixed(2)}px)`)
    if (Math.abs(bar.left) > MAX_DRIFT_PX) failures.push(`${path}: header starts at x=${bar.left.toFixed(2)}, not at the window's left edge`)
    if (Math.abs(bar.right - bar.windowWidth) > MAX_DRIFT_PX) failures.push(`${path}: header ends at x=${bar.right.toFixed(2)}, not at the window's right edge (${bar.windowWidth})`)
    if (bar.asideTop != null && bar.bottom - bar.asideTop > MAX_DRIFT_PX) {
      failures.push(`${path}: header bottom (${bar.bottom.toFixed(2)}) overlaps the sidebar top (${bar.asideTop.toFixed(2)}) — it is not above the bar`)
    }
    if (bar.horizontalOverflow) failures.push(`${path}: horizontal scrollbar at ${VIEWPORT.width}px`)
    if (bar.animated) failures.push(`${path}: an element of the header is running an animation (state must be static)`)
    const missing = await page.evaluate(sels => sels.filter(s => !document.querySelector(s)), [SEARCH, action('dashboard'), action('compose'), action('settings')])
    if (missing.length) failures.push(`${path}: missing from the header: ${missing.join(', ')}`)
  }

  // --- The dashboard row left the sidebar (lot O1 removes it from there) ---
  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-sidebar] [data-sidebar-row]', { timeout: 20000 })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const sidebarRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-sidebar] [data-sidebar-row]')].map(el => el.dataset.sidebarRow))
  console.log(`sidebar rows: ${sidebarRows.join(', ')}`)
  if (!sidebarRows.length) { console.error('HARNESS: no sidebar row measured'); process.exit(2) }
  if (sidebarRows.includes('dashboard')) failures.push('the sidebar still carries a "dashboard" row')

  // --- Cmd/Ctrl+K focuses the field, from anywhere on the page ---
  await page.evaluate(() => document.body.click())
  const beforeShortcut = await page.evaluate(s => document.activeElement === document.querySelector(s), SEARCH)
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
  const afterMeta = await page.evaluate(s => document.activeElement === document.querySelector(s), SEARCH)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control')
  const afterCtrl = await page.evaluate(s => document.activeElement === document.querySelector(s), SEARCH)
  console.log(`search focused — before any shortcut: ${beforeShortcut}, after Cmd+K: ${afterMeta}, after Ctrl+K: ${afterCtrl}`)
  // The "before" reading is the same-run reference: without it, a field that was
  // already focused would make both shortcuts pass vacuously.
  if (beforeShortcut) { console.error('HARNESS: the field was already focused before the shortcut — nothing measured'); process.exit(2) }
  if (!afterMeta) failures.push('Cmd+K does not focus the header search field')
  if (!afterCtrl) failures.push('Ctrl+K does not focus the header search field')

  // --- Escape clears the field and drops the focus ---
  await page.type(SEARCH, 'facture')
  const typed = await page.$eval(SEARCH, el => el.value)
  await page.keyboard.press('Escape')
  const cleared = await page.$eval(SEARCH, el => el.value)
  const stillFocused = await page.evaluate(s => document.activeElement === document.querySelector(s), SEARCH)
  console.log(`Escape: "${typed}" -> "${cleared}", still focused: ${stillFocused}`)
  if (!typed) { console.error('HARNESS: could not type into the field — nothing measured'); process.exit(2) }
  if (cleared !== '') failures.push(`Escape left "${cleared}" in the field`)
  if (stillFocused) failures.push('Escape left the focus in the field')

  // --- REAL clicks on the three actions ---
  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(action('dashboard'), { timeout: 20000 })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click(action('dashboard'))])
  await new Promise(r => setTimeout(r, SETTLE_MS))
  let url = new URL(page.url()).pathname
  console.log(`click dashboard -> ${url}`)
  if (!url.startsWith('/dashboard')) failures.push(`clicking the dashboard action landed on ${url}`)

  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click(action('settings'))])
  await new Promise(r => setTimeout(r, SETTLE_MS))
  url = new URL(page.url()).pathname
  console.log(`click settings -> ${url}`)
  if (!url.startsWith('/settings')) failures.push(`clicking the settings action landed on ${url}`)

  // Compose has two branches in lib/compose.ts: on /mail it dispatches the event,
  // elsewhere it navigates to /mail?compose=1. Both are clicked, from a FRESHLY
  // loaded page each time — clicking straight after the settings action would land
  // on the settings modal's backdrop and measure the dismiss, not the compose.
  const composeEditor = () => page.evaluate(() =>
    !!document.querySelector('[role="dialog"] .ProseMirror, [role="dialog"] [contenteditable="true"]'))
  for (const from of ['/dashboard', '/mail']) {
    await page.goto(`${BASE}${from}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(action('compose'), { timeout: 20000 })
    await new Promise(r => setTimeout(r, SETTLE_MS))
    if (await composeEditor()) { console.error(`HARNESS: a compose window was already open on ${from} — nothing measured`); process.exit(2) }
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click(action('compose'))])
    await new Promise(r => setTimeout(r, SETTLE_MS * 4))
    const composeUrl = new URL(page.url())
    const composeOpen = await composeEditor()
    console.log(`click compose from ${from} -> ${composeUrl.pathname}${composeUrl.search}, compose window in the DOM: ${composeOpen}`)
    if (!composeOpen) failures.push(`clicking the compose action from ${from} did not open the compose window (landed on ${composeUrl.pathname}${composeUrl.search})`)
  }

  // --- Mobile: the header replaces the top bar and carries the drawer hamburger ---
  await page.setViewport(MOBILE_VIEWPORT)
  await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(BAR, { timeout: 20000 })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const mobileBar = await page.evaluate(probeBar, BAR)
  const hamburgerVisible = await page.evaluate(s => {
    const el = document.querySelector(s)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }, MENU)
  // Exactly one top bar: a leftover `lg:hidden` bar above the content would be a second one.
  const barCount = await page.evaluate(s => document.querySelectorAll(s).length, BAR)
  console.log(`mobile ${MOBILE_VIEWPORT.width}px: header height=${mobileBar?.height.toFixed(2)}px, hamburger visible=${hamburgerVisible}, headers in the DOM=${barCount}, overflow=${mobileBar?.horizontalOverflow}`)
  if (!mobileBar) failures.push(`no header at ${MOBILE_VIEWPORT.width}px`)
  else {
    if (Math.abs(mobileBar.height - EXPECTED_HEIGHT) > MAX_DRIFT_PX) failures.push(`mobile: header is ${mobileBar.height.toFixed(2)}px tall, expected ${EXPECTED_HEIGHT}px`)
    if (mobileBar.horizontalOverflow) failures.push(`mobile: horizontal scrollbar at ${MOBILE_VIEWPORT.width}px`)
  }
  if (barCount !== 1) failures.push(`mobile: ${barCount} headers in the DOM, expected exactly 1`)
  if (!hamburgerVisible) failures.push('mobile: the drawer hamburger is not visible in the header')
  const drawerOpened = await (async () => {
    await page.click(MENU)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    return page.evaluate(() => !!document.querySelector('[data-sidebar-drawer]'))
  })()
  console.log(`mobile: clicking the hamburger opens the drawer: ${drawerOpened}`)
  if (!drawerOpened) failures.push('mobile: the header hamburger does not open the drawer')
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\ncheck-omnibar: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\ncheck-omnibar: OK')
