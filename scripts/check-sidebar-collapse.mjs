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
// The round toggle straddles the bar's right edge: its centre must sit on that edge.
// Same tolerance as any other geometry here — the edge and the centre are both read
// from getBoundingClientRect in the SAME run, so this is a relative check, not an
// absolute constant calibrated on a vanished bench.
const MAX_EDGE_OFFSET_PX = MAX_DRIFT_PX
// The desktop toggle stays mounted (display:none) below `lg`, so the drawer check must
// select ITS OWN button explicitly — a bare attribute selector matches the hidden
// desktop one first and measures a 0x0 box (observed: 0.00px "off the edge", vacuous).
const EDGE_TOGGLE = { bar: '[data-sidebar-edge-toggle="bar"]', drawer: '[data-sidebar-edge-toggle="drawer"]' }
// Same trap for the drawer itself: the desktop <aside> stays in the DOM below `lg` with
// a 0x0 box, so `[data-sidebar]` alone resolves to it and every mobile measurement taken
// through it is vacuous (observed: "256px off the edge", and a drawer reported still open
// after it had closed). The drawer is addressed through its own marker.
const DRAWER = '[data-sidebar-drawer]'
// Badge geometry thresholds, from the human gate of 2026-09-17 that rejected a badge
// covering 37% of the bubble and 40% of the initial's text box: the badge may clip the
// bubble's corner, but the letter underneath must stay whole.
const MAX_BADGE_OVER_BUBBLE = 0.25
const MAX_BADGE_OVER_GLYPH = 0
// WCAG AA floor for small bold text — the letters are 9-12px, so 4.5:1 is the minimum.
const MIN_CONTRAST = 4.5
// Lot A10: a bubble carries TWO letters, never one — a lone initial reads as an accident.
const BUBBLE_LETTERS = 2
// Lot A11: every name and email of the account list starts at the same x. Same tolerance
// as the collapse contract (MAX_DRIFT_PX) — one pixel is where sub-pixel text layout lands,
// anything above it is a real indent difference between a selected row and an idle one.
const MAX_TEXT_X_SPREAD_PX = MAX_DRIFT_PX
// ...and exactly one bubble of the list wears the selection ring — the active account.
const EXPECTED_SELECTED_BUBBLES = 1
// ...and those letters must stay INSIDE the circle. The inked box is measured with a
// Range over the text node (the span is a flex child stretched to the line box, so its
// own rect says nothing about where the ink is), and compared against the bubble's box
// shrunk by this margin on each side — the visual breathing room the human gate asks for.
const GLYPH_INSET_PX = 2
// Scrollbar width declared by the `.scroll-thin` utility in app/globals.css, asserted
// against the compiled stylesheet rather than against a layout gutter: on macOS Chrome
// both a styled and a native container reserve 0px (overlay scrollbars), so the gutter
// cannot discriminate on this bench — measured, see the Journal. What IS discriminating
// here is the computed property pair, measured on a same-run UNSTYLED reference.
const SCROLL_THIN_PX = 6
// Mobile width GOAL.md fixes for the drawer check: no horizontal overflow at 390.
const MOBILE_VIEWPORT = { width: 390, height: 844 }
// The bar must follow the theme. Discriminating criterion, measured on the SAME run
// in both themes: the bar's own background must differ between light and dark. A bar
// painted with a fixed dark value (the `bg-zinc-950`/gradient this lot removed) reports
// the identical colour in both and fails here.
const THEMES = ['light', 'dark']
// Accent budget: every accent-bearing surface of the bar must belong to ONE hue family.
// Tints of one accent share its hue by construction, so the discriminating measure is the
// SPREAD of hue angles, not the count of colours. Origin: the bar's accent is violet-600
// (hue ~272 deg); the states this lot removed — the violet->blue Compose gradient and its
// blue ring — put a second family ~60 deg away, far outside this band. 15 deg leaves room
// for the rounding of an alpha-composited tint and nothing else. Verified failable: see
// the negative control in the Journal.
const MAX_ACCENT_HUE_SPREAD_DEG = 15
// Below this saturation a painted surface is a neutral (the bar's own greys), not an accent.
const ACCENT_MIN_SATURATION = 0.12

// Lot A7: a custom folder is told apart when the bar is folded by the letters on its tile.
// One letter is enough unless a sibling of the SAME list starts with it, in which case both
// grow to two — so the ceiling is two, the floor one, and no two tiles of one list may match.
// Two letters ALWAYS — the same floor the account bubbles hold to (a lone letter reads
// as an accident, not an identity); a third only when two folders of one list would
// otherwise spell the same pair. Human gate of 19/09/2026 rejected the one-letter tiles.
const FOLDER_GLYPH_MIN_LETTERS = 2
const FOLDER_GLYPH_MAX_LETTERS = 3
// The tile must READ as a tile, not as letters floating on the bar. Origin: the human
// gate measured the shipped `bg-secondary` fill at 1.03:1 (light) and 1.30:1 (dark)
// against the bar and could not see a plate at all; the ceiling it asked for is 1.5:1.
// Calibration bench: this script, headless Chrome, the bar's own light/dark `--sidebar`
// — the shipped 24 % mix measures ~1.9:1 in both themes, so the floor is not grazed.
// Same-run reference: the BAR's own background is read in the same pass, in the same
// theme, from the same rendered page — the ratio is a measured A/B, not a bare constant.
const FOLDER_GLYPH_MIN_TILE_CONTRAST = 1.5
// Two letters at a readable weight do not fit a 16 px plate: measured on this bench, in
// this browser, with the app's own system stack, the widest pair the rule can produce
// (`WM`) inks 17.88 px at the 10 px semibold / 0.3 px tracking the human gate asked for,
// and still 16.69 px at 9 px with no tracking. The plate size is fixed by the collapse
// contract (it IS a row icon), so a small symmetric bleed is inherent, not a defect —
// what would be a defect is a letter CLIPPED or pushed out of the icon column, both
// checked separately. 1.2 px per side leaves room for the widest pair and nothing more.
const FOLDER_GLYPH_MAX_PLATE_BLEED_PX = 1.2
// The tile must stay monochrome: it carries no accent, so its ink and its background must
// be grey — measured as HSV saturation, the same metric the cleanliness pass already uses.
const FOLDER_GLYPH_MAX_SATURATION = ACCENT_MIN_SATURATION

// Colour tokens inside a composite computed value (background-image gradient, box-shadow).
const COLOUR_TOKEN_SOURCE = '(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\([^)]*\\)'
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
const probe = sel => {
  const bar = document.querySelector('[data-sidebar]')
  if (!bar) return null
  const rows = [...bar.querySelectorAll('[data-sidebar-row]')]
  // The straddling toggle and the edge it straddles, read in the same frame: the
  // button is outside [data-sidebar], so it is deliberately not one of the rows.
  const aside = bar.closest('aside')
  const toggle = document.querySelector(sel)
  const asideRect = aside?.getBoundingClientRect()
  const toggleRect = toggle?.getBoundingClientRect()
  return {
    collapsed: bar.dataset.collapsed,
    asideRight: asideRect ? asideRect.right : null,
    toggleCenterX: toggleRect ? toggleRect.x + toggleRect.width / 2 : null,
    toggleCenterY: toggleRect ? toggleRect.y + toggleRect.height / 2 : null,
    headerRowCenterY: (() => {
      const header = bar.querySelector('[data-sidebar-row="account"]')
      if (!header) return null
      const r = header.getBoundingClientRect()
      return r.y + r.height / 2
    })(),
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
  const inkBox = node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect()
  }
  return [...document.querySelectorAll('[data-account-initial]')].map(glyph => {
    const bubble = glyph.parentElement
    const wrapper = bubble.parentElement
    const badge = wrapper.querySelector('[data-unread-badge]')
    const gr = inkBox(glyph)
    const br = bubble.getBoundingClientRect()
    const dr = badge?.getBoundingClientRect()
    const style = getComputedStyle(bubble)
    return {
      where: wrapper.closest('[data-sidebar-row]') ? 'header' : 'popover row',
      initial: glyph.textContent,
      letters: [...(glyph.textContent ?? '')].length,
      fontSize: getComputedStyle(glyph).fontSize,
      bubbleW: br.width,
      // Signed slack on each side: how far the inked text sits from the bubble's rim.
      // Negative on any side = a letter touching or crossing the circle.
      slack: { left: gr.left - br.left, right: br.right - gr.right, top: gr.top - br.top, bottom: br.bottom - gr.bottom },
      badgeText: badge?.textContent ?? '',
      overBubble: dr ? overlap(dr, br) / (br.width * br.height) : 0,
      overGlyph: dr && gr.width && gr.height ? overlap(dr, gr) / (gr.width * gr.height) : 0,
      bg: style.backgroundColor,
      contrast: contrast(style.backgroundColor, getComputedStyle(glyph).color),
    }
  })
}

/**
 * Reads the account popover as a LIST: the x at which each row's text starts, how many
 * bubbles wear the selection ring, and whether any check glyph survives. The text x is
 * taken from the inked box of each line (Range over the text node), not from its span —
 * a truncating flex child is as wide as its slot, so its rect would report the same x
 * even if the ink were centred inside it, and the check this backs would pass vacuously.
 */
const probeAccountList = () => {
  const popover = document.querySelector('[data-account-popover]')
  if (!popover) return null
  const inkLeft = node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const r = range.getBoundingClientRect()
    return r.width ? r.left : null
  }
  const rows = [...popover.querySelectorAll('button')].map(row => {
    const lines = [...row.querySelectorAll('span.block')]
      .map(line => ({ text: (line.textContent ?? '').trim(), x: inkLeft(line) }))
      .filter(l => l.x !== null)
    const bubble = row.querySelector('[data-account-initial]')?.parentElement
    return {
      label: lines[0]?.text ?? '(no text)',
      lines,
      selected: bubble?.dataset.accountSelected === 'true',
      ring: bubble ? getComputedStyle(bubble).boxShadow : '',
      textAlign: getComputedStyle(row).textAlign,
      bubbleX: bubble ? bubble.getBoundingClientRect().left : null,
    }
  })
  return {
    rows,
    // Any lucide check, however it is classed, plus the raw glyph as a second net.
    checkGlyphs: popover.querySelectorAll('svg.lucide-check, [class*="lucide-check"]').length,
    checkChars: ((popover.textContent ?? '').match(/[✓✔]/g) ?? []).length,
  }
}

/**
 * A/B of the scrollbar: injects two identical overflowing containers — one with
 * `.scroll-thin`, one bare — and reads what each one resolves to. The bare container
 * is the SAME-RUN reference: whatever this browser does natively is measured here
 * rather than assumed from another machine. Also reports the layout gutter each
 * reserves, and reads the shipped `::-webkit-scrollbar` width out of the compiled
 * stylesheet so a utility dropped at build time cannot pass unnoticed.
 */
/**
 * Reads every custom-folder tile: its letters, its full-path tooltip, and the
 * saturation of its ink and background. Runs in BOTH states — the tile IS the row's
 * icon, so the collapse contract already measures its box; what this adds is that the
 * letters survive the fold and stay readable, which is the whole point of the tile.
 */
const probeFolderGlyphs = () => {
  // Colours are resolved through a canvas, never parsed: this app's tokens compute to
  // `oklch(...)`, whose three numbers are NOT r,g,b — a hand-rolled parser reads
  // `oklch(0.985 0 0)` (pure white) as saturation 1.00 and fails a monochrome tile.
  // Measured on this bench; the same canvas technique is what probeCleanliness uses.
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const sat = colour => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    // A fully transparent colour paints nothing — it carries no hue to judge.
    if (a === 0) return 0
    const max = Math.max(r, g, b)
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max
  }
  const alpha = colour => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 1, 1)
    return ctx.getImageData(0, 0, 1, 1).data[3]
  }
  // Luminance contrast, read through the same canvas: the tokens are oklch, so the
  // three numbers of a computed value are NOT r,g,b and must not be parsed by hand.
  const rgb = colour => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  }
  const lum = colour => {
    const [r, g, b] = rgb(colour).slice(0, 3).map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  // The inked box of the letters, not the span's box: a centred flex child is as wide
  // as its slot, so its rect would report a fit even if the glyphs overflowed it.
  const inkBox = node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect()
  }
  const bar = document.querySelector('[data-sidebar]')
  if (!bar) return null
  // SAME-RUN reference for the tile's contrast: whatever the bar actually paints behind
  // the tile, in the theme this pass is in — never a value carried over from a bench.
  const barBg = getComputedStyle(bar).backgroundColor
  // Published by the bar as the ONE width every icon column uses, collapsed or not.
  const iconColW = parseFloat(getComputedStyle(bar).getPropertyValue('--synap-icon-col'))
  return [...bar.querySelectorAll('[data-folder-glyph]')].map(el => {
    const row = el.closest('[data-sidebar-row]')
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const ink = inkBox(el)
    // The slot the tile is centred in — the bar's fixed icon column, read from the width
    // the bar itself publishes (`--synap-icon-col`) and anchored on the row's own left
    // edge, since that column is the row's first child in every state. This, NOT the
    // 16 px plate, is what the letters must fit inside: a plate that size cannot hold
    // two letters at a readable weight (measured on this bench: the widest pair the rule
    // can produce inks 17.88 px at the 10 px semibold the human gate asked for), so the
    // meaningful question is whether the glyphs stay in their column and unclipped.
    const rowRect = (row ?? el).getBoundingClientRect()
    const slot = { left: rowRect.left, right: rowRect.left + iconColW, top: rowRect.top, bottom: rowRect.bottom, width: iconColW }
    return {
      // Signed slack against the icon column on each side; negative = out of its slot.
      slotSlack: { left: ink.left - slot.left, right: slot.right - ink.right, top: ink.top - slot.top, bottom: slot.bottom - ink.bottom },
      slotW: slot.width,
      // How far the ink spills past the plate's own edge — reported so the drift is
      // visible in the log, and capped below rather than forbidden outright.
      plateBleed: Math.max(0, r.left - ink.left, ink.right - r.right, r.top - ink.top, ink.bottom - r.bottom),
      // A plate that clips would cut a letter; the tile must never do that.
      overflow: cs.overflow,
      fontSize: cs.fontSize,
      barBg,
      // The plate against the bar behind it, and the letters against the plate.
      tileContrast: contrast(cs.backgroundColor, barBg),
      inkContrast: contrast(cs.color, cs.backgroundColor),
      key: row?.dataset.sidebarRow ?? null,
      title: row?.getAttribute('title') ?? null,
      text: (el.textContent || '').trim(),
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
      inkSat: sat(cs.color),
      bgSat: sat(cs.backgroundColor),
      color: cs.color,
      background: cs.backgroundColor,
      // Alpha of the painted background: 0 means the tile class did not compile and the
      // letters float with no plate. Read through the canvas so any colour syntax counts.
      bgAlpha: alpha(cs.backgroundColor),
    }
  })
}

const probeScrollbars = () => {
  const gutter = el => el.offsetWidth - el.clientWidth
  const read = el => {
    const st = getComputedStyle(el)
    return { widthProp: st.scrollbarWidth, colorProp: st.scrollbarColor, gutter: gutter(el) }
  }
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-9999px;top:0;'
  const make = cls => {
    const box = document.createElement('div')
    box.className = cls
    box.style.cssText = 'width:200px;height:60px;overflow-y:auto;'
    box.innerHTML = '<div style="height:600px"></div>'
    host.appendChild(box)
    return box
  }
  const styled = make('scroll-thin')
  const bare = make('')
  document.body.appendChild(host)

  // The shipped rule, straight out of the cascade: proves the utility survived the
  // build. Walks nested groups (@layer/@media/@supports) — Tailwind may wrap it.
  let webkitWidth = null
  const walk = rules => {
    for (const r of rules ?? []) {
      if (r.selectorText === '.scroll-thin::-webkit-scrollbar') webkitWidth = r.style.width
      if (r.cssRules) walk(r.cssRules)
    }
  }
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules) } catch { /* cross-origin sheet: not ours */ }
  }

  const result = {
    styled: read(styled),
    bare: read(bare),
    webkitWidth,
    containers: [...document.querySelectorAll('[data-scroll-thin]')].map(el => ({
      tag: el.tagName.toLowerCase(),
      hasClass: el.classList.contains('scroll-thin'),
      ...read(el),
      overflowing: el.scrollHeight - el.clientHeight,
    })),
  }
  host.remove()
  return result
}

/**
 * Cleanliness probe for the bar itself: the surface it is painted with, the ink and
 * height of every row (one motif => one height), the accent colours actually used,
 * and whether ANY element inside the bar is running an animation. Contrast is
 * recomputed from rendered colours, so "readable in both themes" is measured.
 */
const probeCleanliness = (minSaturation, colourTokenSource) => {
  // Matches the colour function forms a computed style can hold (rgb/rgba/hsl/oklch/color/lab…).
  const COLOUR_TOKEN = new RegExp(colourTokenSource, 'g')
  // Colours are resolved through a canvas rather than parsed: the app's tokens are
  // `oklch()`, which a hand-rolled rgb() regex silently reads as 0,0,0 (measured: every
  // contrast came out 1.00:1). Painting the colour — over its backdrop when it carries
  // alpha — and reading the pixel back makes the BROWSER do the conversion and the
  // alpha compositing, in the same run, for any colour syntax it supports.
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const paint = (colour, backdrop) => {
    ctx.clearRect(0, 0, 1, 1)
    if (backdrop) { ctx.fillStyle = backdrop; ctx.fillRect(0, 0, 1, 1) }
    ctx.fillStyle = colour
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return { r, g, b, a }
  }
  const lum = ({ r, g, b }) => {
    const [x, y, z] = [r, g, b].map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) })
    return 0.2126 * x + 0.7152 * y + 0.0722 * z
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const show = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`
  // Hue angle on the colour wheel — what "one accent colour" is actually about. A tint
  // of the same accent keeps its hue; a second accent family (a gradient's other end, a
  // blue ring on a violet bar) lands somewhere else entirely.
  const hue = ({ r, g, b }) => {
    const [R, G, B] = [r / 255, g / 255, b / 255]
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
    if (!d) return null // neutral: no hue to place
    const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
    return (h * 60 + 360) % 360
  }
  const saturation = ({ r, g, b }) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    return max ? (max - min) / max : 0
  }

  const bar = document.querySelector('[data-sidebar]')
  const barBg = paint(getComputedStyle(bar).backgroundColor)
  const rows = [...bar.querySelectorAll('[data-sidebar-row]')]
  const accents = new Map()
  const animated = []
  for (const el of bar.querySelectorAll('*')) {
    const st = getComputedStyle(el)
    // Decorative motion only: a transition is not an animation, and a 0s animation is not running.
    if (st.animationName !== 'none' && parseFloat(st.animationDuration) > 0) {
      animated.push(`${el.tagName.toLowerCase()}:${st.animationName}`)
    }
    // Account bubbles are excluded: their palette is deliberately multi-colour and is
    // contrast-gated above. Everything else the bar paints must share one accent hue.
    if (el.hasAttribute('data-account-initial') || el.querySelector('[data-account-initial]')) continue
    // A gradient lives in background-IMAGE and a ring/glow in box-SHADOW: both compute
    // background-color to transparent, so reading that property alone is blind to exactly
    // the two decorations this lot removes. Every colour token of all three is measured.
    const tokens = [st.backgroundColor, ...`${st.backgroundImage} ${st.boxShadow}`.match(COLOUR_TOKEN) ?? []]
    for (const token of tokens) {
      const painted = paint(token, show(barBg))
      if (saturation(painted) < minSaturation) continue // neutral surface, not an accent
      const h = hue(painted)
      if (h != null) accents.set(show(painted), h)
    }
  }
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    barBg: show(barBg),
    slot: !!bar.querySelector('[data-sidebar-slot="theme-toggle"]'),
    animated,
    accents: [...accents].map(([colour, h]) => ({ colour, hue: h })),
    rows: rows.map(r => {
      const st = getComputedStyle(r)
      // A row that paints its own background (the Compose control) is read against THAT,
      // not against the bar: measuring its white ink on the bar behind it would report a
      // contrast the user never sees. Rows with no fill of their own fall back to the bar.
      const backdrop = paint(st.backgroundColor, show(barBg))
      const ink = paint(st.color, show(backdrop))
      return {
        key: r.dataset.sidebarRow,
        height: r.getBoundingClientRect().height,
        ink: show(ink),
        on: show(backdrop),
        contrast: contrast(ink, backdrop),
      }
    }),
  }
}

const setTheme = theme => {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
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

  // The bar folds from the round button straddling its right edge — a REAL click on
  // the shipped control, not a programmatic state change.
  const toggle = async () => {
    await page.click(EDGE_TOGGLE.bar)
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }

  let before = await page.evaluate(probe, EDGE_TOGGLE.bar)
  if (before.collapsed === 'true') { await toggle(); before = await page.evaluate(probe, EDGE_TOGGLE.bar) }
  if (before.collapsed !== 'false') { console.error('HARNESS: could not reach the expanded state'); process.exit(2) }
  const glyphsExpanded = await page.evaluate(probeFolderGlyphs)

  await toggle()
  const after = await page.evaluate(probe, EDGE_TOGGLE.bar)
  if (after.collapsed !== 'true') { console.error('HARNESS: could not reach the collapsed state'); process.exit(2) }
  const glyphsCollapsed = await page.evaluate(probeFolderGlyphs)

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

  // --- The round toggle straddles the bar's right edge, in BOTH states ---
  for (const s of [before, after]) {
    if (s.toggleCenterX == null || s.asideRight == null) {
      console.error(`HARNESS: no [data-sidebar-edge-toggle] or no <aside> while collapsed=${s.collapsed} — nothing measured`)
      process.exit(2)
    }
    const offset = Math.abs(s.toggleCenterX - s.asideRight)
    console.log(`edge toggle (collapsed=${s.collapsed}): centre x=${s.toggleCenterX.toFixed(2)} vs bar right edge ${s.asideRight.toFixed(2)} → ${offset.toFixed(2)}px`)
    if (offset > MAX_EDGE_OFFSET_PX) {
      failures.push(`edge toggle sits ${offset.toFixed(2)}px off the bar's right edge while collapsed=${s.collapsed} (max ${MAX_EDGE_OFFSET_PX}px)`)
    }
    // Vertically centred on the header row — the single-line header the lot is about.
    if (s.headerRowCenterY == null || s.toggleCenterY == null) {
      console.error(`HARNESS: no header row to centre the toggle on while collapsed=${s.collapsed}`)
      process.exit(2)
    }
    const vOffset = Math.abs(s.toggleCenterY - s.headerRowCenterY)
    console.log(`  vertical: toggle centre y=${s.toggleCenterY.toFixed(2)} vs header row centre ${s.headerRowCenterY.toFixed(2)} → ${vOffset.toFixed(2)}px`)
    if (vOffset > MAX_EDGE_OFFSET_PX) {
      failures.push(`edge toggle sits ${vOffset.toFixed(2)}px off the header row's centre while collapsed=${s.collapsed} (max ${MAX_EDGE_OFFSET_PX}px)`)
    }
  }
  // The two states must actually differ, otherwise the check above passes vacuously
  // on a button that never moved because the bar never folded.
  if (Math.abs(before.asideRight - after.asideRight) < 1) {
    console.error('HARNESS: the bar\'s right edge did not move between the two states — the fold did nothing')
    process.exit(2)
  }

  // --- Custom folders: a tile of letters, readable folded, monochrome, full path on hover ---
  if (!glyphsExpanded || !glyphsCollapsed) { console.error('HARNESS: the sidebar root was not found when reading folder tiles'); process.exit(2) }
  if (!glyphsCollapsed.length) { console.error('HARNESS: no [data-folder-glyph] tile rendered — this account has no custom folder, nothing measured'); process.exit(2) }
  console.log(`custom folder tiles: expanded=${glyphsExpanded.length} collapsed=${glyphsCollapsed.length}`)
  if (glyphsExpanded.length !== glyphsCollapsed.length) {
    failures.push(`folder tiles: ${glyphsExpanded.length} expanded vs ${glyphsCollapsed.length} collapsed — tiles were unmounted by the fold`)
  }
  // Read on the COLLAPSED state: that is the state the tile exists for.
  const glyphLetters = new Map()
  for (const g of glyphsCollapsed) {
    console.log(`  ${g.key}: "${g.text}" (${g.text.length} letters, ${g.fontSize}) visible=${g.visible} title="${g.title}" ink=${g.color} (sat ${g.inkSat.toFixed(3)}) bg=${g.background} (sat ${g.bgSat.toFixed(3)}, alpha ${g.bgAlpha}) tile/bar=${g.tileContrast.toFixed(3)}:1 on ${g.barBg} ink/tile=${g.inkContrast.toFixed(2)}:1`)
    if (g.tileContrast < FOLDER_GLYPH_MIN_TILE_CONTRAST) {
      failures.push(`folder tile ${g.key}: plate ${g.background} on bar ${g.barBg} = ${g.tileContrast.toFixed(3)}:1 (min ${FOLDER_GLYPH_MIN_TILE_CONTRAST}:1) — the tile does not read as a tile`)
    }
    const tight = Math.min(g.slotSlack.left, g.slotSlack.right, g.slotSlack.top, g.slotSlack.bottom)
    if (tight < 0) failures.push(`folder tile ${g.key}: letters "${g.text}" leave the ${g.slotW.toFixed(0)}px icon column (slack ${tight.toFixed(2)}px)`)
    if (g.overflow !== 'visible') failures.push(`folder tile ${g.key}: overflow=${g.overflow} — a wide pair would be clipped mid-letter`)
    if (g.plateBleed > FOLDER_GLYPH_MAX_PLATE_BLEED_PX) {
      failures.push(`folder tile ${g.key}: letters "${g.text}" spill ${g.plateBleed.toFixed(2)}px past the plate (max ${FOLDER_GLYPH_MAX_PLATE_BLEED_PX}px)`)
    }
    if (!g.visible) failures.push(`folder tile ${g.key}: not visible while the bar is collapsed — the folder cannot be told apart`)
    if (g.text.length < FOLDER_GLYPH_MIN_LETTERS || g.text.length > FOLDER_GLYPH_MAX_LETTERS) {
      failures.push(`folder tile ${g.key}: "${g.text}" is ${g.text.length} letter(s) (expected ${FOLDER_GLYPH_MIN_LETTERS}-${FOLDER_GLYPH_MAX_LETTERS})`)
    }
    if (g.text !== g.text.toUpperCase()) failures.push(`folder tile ${g.key}: "${g.text}" is not upper-cased`)
    if (g.bgAlpha === 0) failures.push(`folder tile ${g.key}: background paints nothing (alpha 0, "${g.background}") — the tile class did not compile`)
    if (g.inkSat > FOLDER_GLYPH_MAX_SATURATION || g.bgSat > FOLDER_GLYPH_MAX_SATURATION) {
      failures.push(`folder tile ${g.key}: not monochrome — ink saturation ${g.inkSat.toFixed(3)}, background ${g.bgSat.toFixed(3)} (max ${FOLDER_GLYPH_MAX_SATURATION})`)
    }
    // The letters replace the name, so the full IMAP path must remain reachable on hover.
    const path = (g.key || '').replace(/^folder:/, '')
    if (!g.title || g.title !== path) failures.push(`folder tile ${g.key}: title "${g.title}" is not the folder's full path "${path}"`)
    const clash = glyphLetters.get(g.text)
    if (clash) failures.push(`folder tiles: "${g.text}" is carried by both ${clash} and ${g.key} — the two folders are indistinguishable folded`)
    glyphLetters.set(g.text, g.key)
  }
  // Same letters in both states: the tile is the row's identity, not a collapsed-only decoration.
  for (const e of glyphsExpanded) {
    const c = glyphsCollapsed.find(x => x.key === e.key)
    if (c && c.text !== e.text) failures.push(`folder tile ${e.key}: letters changed with the fold ("${e.text}" → "${c.text}")`)
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
    const worstSlack = Math.min(...Object.values(b.slack))
    console.log(`  ${where}: letters=${b.letters} font=${b.fontSize} bubble=${b.bubbleW.toFixed(0)}px inset=${worstSlack.toFixed(2)}px badge/bubble=${(b.overBubble * 100).toFixed(1)}% badge/glyph=${(b.overGlyph * 100).toFixed(1)}% contrast=${b.contrast.toFixed(2)} bg=${b.bg}`)
    if (b.letters !== BUBBLE_LETTERS) failures.push(`${where}: ${b.letters} letter(s) in the bubble (expected exactly ${BUBBLE_LETTERS})`)
    if (worstSlack < GLYPH_INSET_PX) {
      const sides = Object.entries(b.slack).map(([k, v]) => `${k} ${v.toFixed(2)}px`).join(', ')
      failures.push(`${where}: letters reach the bubble's rim — closest side ${worstSlack.toFixed(2)}px (min ${GLYPH_INSET_PX}px); ${sides}`)
    }
    if (b.overBubble > MAX_BADGE_OVER_BUBBLE) failures.push(`${where}: badge covers ${(b.overBubble * 100).toFixed(1)}% of the bubble (max ${(MAX_BADGE_OVER_BUBBLE * 100)}%)`)
    if (b.overGlyph > MAX_BADGE_OVER_GLYPH) failures.push(`${where}: badge covers ${(b.overGlyph * 100).toFixed(1)}% of the initial (max ${(MAX_BADGE_OVER_GLYPH * 100)}%)`)
    if (b.contrast < MIN_CONTRAST) failures.push(`${where}: initial contrast ${b.contrast.toFixed(2)}:1 on ${b.bg} (min ${MIN_CONTRAST}:1)`)
  }
  const palette = [...new Set(bubbles.map(b => b.bg))]
  console.log(`distinct bubble colours exercised: ${palette.length} (${palette.join(', ')})`)

  // --- Account list: strict left alignment, ring instead of a check glyph ---
  const list = await page.evaluate(probeAccountList)
  if (!list) { console.error('HARNESS: account popover not found — the list checks measured nothing'); process.exit(2) }
  if (list.rows.length < 2) { console.error(`HARNESS: ${list.rows.length} account row(s) — too few to compare alignment`); process.exit(2) }
  const textXs = list.rows.flatMap(r => r.lines.map(l => l.x))
  if (!textXs.length) { console.error('HARNESS: no inked text line measured in the account list'); process.exit(2) }
  const spread = Math.max(...textXs) - Math.min(...textXs)
  const selected = list.rows.filter(r => r.selected)
  console.log(`account list: ${list.rows.length} rows, ${textXs.length} text lines, x spread ${spread.toFixed(2)}px, selected bubbles ${selected.length}, check glyphs ${list.checkGlyphs} (chars ${list.checkChars})`)
  for (const r of list.rows) {
    console.log(`  ${r.selected ? 'SELECTED' : '        '} "${r.label}": bubble x=${r.bubbleX?.toFixed(2)} text x=${r.lines.map(l => l.x.toFixed(2)).join('/')} align=${r.textAlign}${r.selected ? ` ring="${r.ring}"` : ''}`)
    if (r.textAlign !== 'left') failures.push(`account row "${r.label}": text-align ${r.textAlign}, expected left`)
  }
  if (spread > MAX_TEXT_X_SPREAD_PX) {
    failures.push(`account list: names/emails start at ${spread.toFixed(2)}px apart (max ${MAX_TEXT_X_SPREAD_PX}px) — x values ${[...new Set(textXs.map(x => x.toFixed(2)))].join(', ')}`)
  }
  if (selected.length !== EXPECTED_SELECTED_BUBBLES) {
    failures.push(`account list: ${selected.length} bubble(s) carry the selection ring (expected ${EXPECTED_SELECTED_BUBBLES})`)
  }
  // A ring is a box-shadow: an empty one means the class did not compile into the bundle.
  for (const r of selected) {
    if (!r.ring || r.ring === 'none') failures.push(`account list: the selected row "${r.label}" has no ring (box-shadow "${r.ring || 'none'}")`)
  }
  if (list.checkGlyphs || list.checkChars) {
    failures.push(`account list: ${list.checkGlyphs} check icon(s) and ${list.checkChars} check character(s) left in the popover (expected none — the ring marks the active account)`)
  }

  // --- Scrollbars: the bar's scroll containers never show the native bar ---
  const sb = await page.evaluate(probeScrollbars)
  console.log(`scroll-thin vs native reference (same run): scrollbar-width ${sb.styled.widthProp} vs ${sb.bare.widthProp}, scrollbar-color "${sb.styled.colorProp}" vs "${sb.bare.colorProp}", gutter ${sb.styled.gutter}px vs ${sb.bare.gutter}px`)
  console.log(`shipped ::-webkit-scrollbar width in the compiled stylesheet: ${sb.webkitWidth ?? 'MISSING'}`)
  if (sb.webkitWidth !== `${SCROLL_THIN_PX}px`) {
    failures.push(`compiled stylesheet ships .scroll-thin::-webkit-scrollbar width=${sb.webkitWidth ?? 'nothing'}, expected ${SCROLL_THIN_PX}px`)
  }
  // Discriminating on this bench: the reference resolves to `auto`, the styled one to `thin`.
  if (sb.styled.widthProp !== 'thin') failures.push(`.scroll-thin resolves scrollbar-width=${sb.styled.widthProp}, expected thin`)
  if (sb.styled.widthProp === sb.bare.widthProp) {
    failures.push(`.scroll-thin resolves the same scrollbar-width as the unstyled reference (${sb.bare.widthProp}) — the utility is not applying`)
  }
  if (sb.styled.colorProp === sb.bare.colorProp) {
    failures.push(`.scroll-thin resolves the same scrollbar-color as the unstyled reference ("${sb.bare.colorProp}") — the utility is not applying`)
  }
  // Never worse than native, whatever this platform reserves.
  if (sb.styled.gutter > sb.bare.gutter) failures.push(`.scroll-thin reserves ${sb.styled.gutter}px, more than the native reference (${sb.bare.gutter}px)`)
  if (sb.bare.gutter === 0) console.log('  note: this browser uses overlay scrollbars (reference gutter 0px) — the gutter comparison is not discriminating here, the computed-property A/B above is')

  console.log(`scroll containers marked in the bar: ${sb.containers.length}`)
  if (!sb.containers.length) { console.error('HARNESS: no [data-scroll-thin] container found — nothing to measure'); process.exit(2) }
  for (const c of sb.containers) {
    console.log(`  <${c.tag}>: class=${c.hasClass} scrollbar-width=${c.widthProp} gutter=${c.gutter}px overflowing=${c.overflowing}px`)
    if (!c.hasClass) failures.push(`<${c.tag}> scroll container is missing the scroll-thin class`)
    if (c.widthProp !== 'thin') failures.push(`<${c.tag}> resolves scrollbar-width=${c.widthProp}, expected thin`)
    if (c.gutter > sb.bare.gutter) failures.push(`<${c.tag}> reserves ${c.gutter}px, more than the native reference (${sb.bare.gutter}px) — native bar showing`)
  }
  if (!sb.containers.some(c => c.overflowing > 0)) {
    failures.push('no marked scroll container actually overflows — the thin scrollbar was never exercised')
  }

  // --- Cleanliness: one accent, one row motif, static, follows the theme ---
  await page.keyboard.press('Escape') // close the popover so only the bar's own rows are measured
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const clean = {}
  for (const theme of THEMES) {
    await page.evaluate(setTheme, theme)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    clean[theme] = await page.evaluate(probeCleanliness, ACCENT_MIN_SATURATION, COLOUR_TOKEN_SOURCE)
    const c = clean[theme]
    const hues = c.accents.map(a => a.hue)
    const spread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0
    console.log(`${theme}: bar background ${c.barBg}, accent surfaces ${c.accents.length} spanning ${spread.toFixed(1)} deg of hue (${c.accents.map(a => `${a.colour} @${a.hue.toFixed(0)}deg`).join(', ') || 'none'}), animated elements ${c.animated.length}`)
    if (!c.accents.length) { console.error('HARNESS: no accent surface found in the bar — nothing to measure'); process.exit(2) }
    if (spread > MAX_ACCENT_HUE_SPREAD_DEG) {
      failures.push(`${theme}: bar paints accents spanning ${spread.toFixed(1)} deg of hue (max ${MAX_ACCENT_HUE_SPREAD_DEG}): ${c.accents.map(a => `${a.colour} @${a.hue.toFixed(0)}deg`).join(', ')}`)
    }
    if (c.animated.length) failures.push(`${theme}: ${c.animated.length} animated element(s) in the bar: ${c.animated.join(', ')}`)
    if (!c.slot) failures.push(`${theme}: the footer theme-toggle slot is missing`)
    const heights = [...new Set(c.rows.map(r => r.height.toFixed(2)))]
    console.log(`  row heights: ${heights.join(', ')} (rows: ${c.rows.length})`)
    if (heights.length > 1) failures.push(`${theme}: rows use ${heights.length} different heights (${heights.join(', ')}) — one motif expected`)
    for (const r of c.rows) {
      if (r.contrast < MIN_CONTRAST) {
        failures.push(`${theme}: row "${r.key}" ink ${r.ink} on ${r.on} = ${r.contrast.toFixed(2)}:1 (min ${MIN_CONTRAST}:1)`)
      }
    }
    const worst = c.rows.reduce((a, b) => (a.contrast < b.contrast ? a : b))
    console.log(`  worst row contrast: ${worst.contrast.toFixed(2)}:1 ("${worst.key}", ${worst.ink} on ${worst.on})`)
    // The folder tiles, re-measured in THIS theme: the plate is painted from the theme's
    // own tokens, so a fill that reads in dark can vanish in light (the defect the human
    // gate of 19/09/2026 found). Both themes are measured in the SAME run, each against
    // the bar background of that same theme — the reference travels with the measurement.
    const tiles = await page.evaluate(probeFolderGlyphs)
    const worstTile = tiles.reduce((a, b) => (a.tileContrast < b.tileContrast ? a : b))
    console.log(`  worst folder tile: ${worstTile.tileContrast.toFixed(3)}:1 ("${worstTile.text}", plate ${worstTile.background} on bar ${worstTile.barBg}), letters ${worstTile.inkContrast.toFixed(2)}:1 at ${worstTile.fontSize}`)
    for (const t of tiles) {
      if (t.tileContrast < FOLDER_GLYPH_MIN_TILE_CONTRAST) {
        failures.push(`${theme}: folder tile ${t.key} plate ${t.background} on bar ${t.barBg} = ${t.tileContrast.toFixed(3)}:1 (min ${FOLDER_GLYPH_MIN_TILE_CONTRAST}:1)`)
      }
      if (t.text.length < FOLDER_GLYPH_MIN_LETTERS) {
        failures.push(`${theme}: folder tile ${t.key} carries ${t.text.length} letter ("${t.text}") — ${FOLDER_GLYPH_MIN_LETTERS} minimum`)
      }
      if (t.inkSat > FOLDER_GLYPH_MAX_SATURATION || t.bgSat > FOLDER_GLYPH_MAX_SATURATION) {
        failures.push(`${theme}: folder tile ${t.key} is not monochrome — ink ${t.inkSat.toFixed(3)}, plate ${t.bgSat.toFixed(3)} (max ${FOLDER_GLYPH_MAX_SATURATION})`)
      }
    }
  }
  // Same-run A/B: a bar that ignores the theme reports the same background in both.
  if (clean.light.barBg === clean.dark.barBg) {
    failures.push(`the bar paints the same background in light and dark (${clean.light.barBg}) — it does not follow the theme`)
  }
  await page.evaluate(setTheme, 'dark')

  // --- Mobile 390: the drawer opens, nothing overflows horizontally ---
  await page.setViewport(MOBILE_VIEWPORT)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const mobile = await page.evaluate(() => {
    const burger = document.querySelector('main button')
    burger?.click()
    return new Promise(resolve => setTimeout(() => {
      const bar = document.querySelector('[data-sidebar-drawer] [data-sidebar]')
      resolve({
        drawerOpen: !!bar,
        rows: bar ? bar.querySelectorAll('[data-sidebar-row]').length : 0,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        widest: Math.max(0, ...[...document.querySelectorAll('[data-sidebar-drawer] [data-sidebar] *')].map(e => e.getBoundingClientRect().right)),
      })
    }, 400))
  })
  console.log(`mobile ${MOBILE_VIEWPORT.width}px: drawer open=${mobile.drawerOpen} rows=${mobile.rows} horizontal overflow=${mobile.overflow}px widest bar edge=${mobile.widest.toFixed(1)}px`)
  if (!mobile.drawerOpen) { console.error('HARNESS: the mobile drawer did not open — nothing measured'); process.exit(2) }
  if (mobile.overflow > 0) failures.push(`mobile ${MOBILE_VIEWPORT.width}px: ${mobile.overflow}px of horizontal overflow`)
  if (mobile.widest > MOBILE_VIEWPORT.width) failures.push(`mobile ${MOBILE_VIEWPORT.width}px: an element of the bar reaches ${mobile.widest.toFixed(1)}px, past the viewport`)

  // The drawer carries the same straddling button, and a REAL click on it closes the drawer.
  const drawerToggle = await page.evaluate(({ sel, drawer }) => {
    const root = document.querySelector(drawer)
    const aside = root?.querySelector('aside')
    const btn = root?.querySelector(sel)
    if (!aside || !btn) return null
    const a = aside.getBoundingClientRect(), b = btn.getBoundingClientRect()
    return { offset: Math.abs(b.x + b.width / 2 - a.right), width: b.width }
  }, { sel: EDGE_TOGGLE.drawer, drawer: DRAWER })
  if (!drawerToggle) { console.error('HARNESS: the mobile drawer carries no edge toggle — nothing measured'); process.exit(2) }
  console.log(`mobile ${MOBILE_VIEWPORT.width}px: drawer edge toggle ${drawerToggle.width.toFixed(2)}px wide, ${drawerToggle.offset.toFixed(2)}px off the drawer edge`)
  // A hidden button measures 0x0 and would sit "0px off the edge" — guard the vacuous pass.
  if (drawerToggle.width < 1) { console.error('HARNESS: the drawer edge toggle has no box (hidden?) — nothing measured'); process.exit(2) }
  if (drawerToggle.offset > MAX_EDGE_OFFSET_PX) {
    failures.push(`mobile: drawer edge toggle sits ${drawerToggle.offset.toFixed(2)}px off the drawer edge (max ${MAX_EDGE_OFFSET_PX}px)`)
  }
  await page.click(EDGE_TOGGLE.drawer)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const drawerClosed = await page.evaluate(drawer => !document.querySelector(drawer), DRAWER)
  console.log(`mobile ${MOBILE_VIEWPORT.width}px: click on the drawer edge toggle → drawer closed=${drawerClosed}`)
  if (!drawerClosed) failures.push('mobile: clicking the drawer edge toggle did not close the drawer')
} finally {
  // Close the tab before the browser: an open tab keeps its /api/stream SSE
  // connection alive on the dev server, and orphaned tabs pile those up.
  for (const p of await browser.pages()) { await p.close().catch(() => {}) }
  await browser.close()
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} drift(s) over ${MAX_DRIFT_PX}px`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`OK: no icon moved, no row height changed, no horizontal overflow (tolerance ${MAX_DRIFT_PX}px)`)
