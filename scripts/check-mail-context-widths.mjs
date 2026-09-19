#!/usr/bin/env node
/**
 * Browser bench of lot S7b — the mail right-click menu must exist at EVERY window
 * width, driven by a real mouse in Chrome on the test account.
 *
 * Why it exists: at S7's human gate the menu opened at 1024/1200/1440 px and NOTHING
 * opened at 900/780 px — measured on staging AND on production, so a preexisting
 * defect, not a regression. A static read of the sources cannot tell: the handler
 * (`onContextMenu` on `[data-mail-row]`) is present at every width, and it is present
 * at the widths where nothing opens too.
 *
 * The arms, each with its same-run reference:
 *
 *  A. MENU AT EVERY WIDTH, LIST VIEW — right-click a visible row at 1440, 1200, 1024,
 *     900, 780 and 390 px: the menu opens and its rectangle is inside the viewport.
 *     There is no absolute threshold here: every width is measured in the SAME run,
 *     and the wide widths are the reference arm for the narrow ones (if 1440 also
 *     failed, the bench or the session would be the defect, not the width).
 *  B. THE ROOT CAUSE, NAMED AND MEASURED — with a message OPEN below `lg` the mail
 *     list column is `display: none` (`hidden lg:flex`, app/(app)/mail/MailClient.tsx),
 *     so its rows are in the DOM with a ZERO rectangle: there is no row on screen to
 *     right-click. The bench asserts that shape explicitly (rows present, none
 *     visible, column computed `none`) so a future reader gets the cause, not just a
 *     red arm. REFERENCE: the same measurement at 1024 px, where the column stays
 *     `flex` and the rows keep a non-zero rectangle.
 *  C. THE DOCUMENTED WAY BACK — at 900 px with a message open, the mobile "Retour"
 *     button is visible, and pressing it brings the list back with a working
 *     right-click. This is what makes B a LAYOUT RULE (one column at a time below
 *     `lg`) rather than a loss of function.
 *  D. THE "MOVE TO" PANEL FOLDS LEFT — right-click 6 px from a row's right edge at
 *     900, 780 and 390 px, open "Move to": the panel sits entirely inside the window
 *     AND to the LEFT of the parent menu. The human could never see this fold at these
 *     widths, having no menu there; this arm is the measurement they asked for.
 *     REFERENCE: at 1440 px the same right-click opens the panel to the RIGHT — without
 *     it, "inside the window" would also be what a panel that never moves looks like.
 *
 * READ ONLY: every non-GET request to /api/messages is captured and ABORTED, so no
 * message is moved, flagged or deleted, and no body is printed.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-mail-context-widths.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HEIGHT = 900
// Les largeurs que le gate S7 a mesurées (menu ouvert ≥ 1024, rien en dessous), plus la
// largeur téléphone que S7 nommait déjà. Mesurées dans le MÊME run : les larges sont le
// bras de référence des étroites, aucun seuil absolu n'est comparé à une constante.
const WIDTHS = [1440, 1200, 1024, 900, 780, 390]
// Un serveur de dev COMPILE /mail au premier appel : la valeur par défaut de puppeteer
// (30 s) transformerait cette compilation en échec de BANC, qui ne dirait rien du produit.
const NAV_TIMEOUT_MS = 180000
const SETTLE_MS = 500
// Ouvrir un message attend une requête réseau, pas seulement un rendu.
const OPEN_MS = 1500
// À combien de px du bord droit d'une ligne le clic droit tombe pour le bras D. Une
// souris ne peut pas viser le pixel du bord : 6 px est le plus près qu'un geste réel
// atteigne, et c'est là que le panneau doit basculer à gauche.
const RIGHT_EDGE_PX = 6

// Le point de rupture vient de la SOURCE, pas d'un chiffre recopié : c'est la classe
// `lg:` de la colonne de liste qui décide, et Tailwind la fixe à 1024 px par défaut.
const SHELL_SRC = readFileSync(new URL('../app/(app)/mail/MailClient.tsx', import.meta.url), 'utf8')
const LIST_COL_RULE = SHELL_SRC.match(/showReadingPane \? '(hidden lg:flex)' : 'flex'/)?.[1]
if (!LIST_COL_RULE) {
  console.error('HARNESS: could not read the list column\'s responsive rule from app/(app)/mail/MailClient.tsx')
  process.exit(2)
}
// Tailwind par défaut : `lg` = 1024 px. Lu ici pour que renommer le point de rupture
// dans la config casse ce banc au lieu de le laisser mesurer une borne périmée.
const TW_SRC = readFileSync(new URL('../tailwind.config.ts', import.meta.url), 'utf8')
const LG_PX = Number(TW_SRC.match(/lg:\s*['"](\d+)px['"]/)?.[1]) || 1024
const SURFACE_SRC = readFileSync(new URL('../components/ui/ContextMenu.tsx', import.meta.url), 'utf8')
const EDGE_GAP = Number(SURFACE_SRC.match(/EDGE_GAP = (\d+)/)?.[1])
if (!Number.isFinite(EDGE_GAP)) {
  console.error('HARNESS: could not read EDGE_GAP from components/ui/ContextMenu.tsx')
  process.exit(2)
}
// Chrome rend en pixels fractionnaires : un pixel de jeu couvre l'arrondi, pas un placement faux.
const PX_SLACK = 1

for (const file of ['.env', '.env.local']) {
  const url = new URL(`../${file}`, import.meta.url)
  if (!existsSync(url)) continue
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
const wait = ms => new Promise(r => setTimeout(r, ms))

const ROW = '[data-mail-row]'
const SURFACE = '[data-mail-context-menu]'
const MOVE_ROW = '[data-menu-item="move"]'
const PANEL = '[data-menu-panel="move"]'

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  protocolTimeout: NAV_TIMEOUT_MS * 2,
})
let page = null
try {
  page = await browser.newPage()
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
  await page.setViewport({ width: WIDTHS[0], height: HEIGHT })

  // LECTURE SEULE sur le courrier : toute requête mutante sur l'API des messages est
  // capturée et avortée — elle n'atteint jamais le serveur.
  await page.setRequestInterception(true)
  const writes = []
  page.on('request', req => {
    if (req.method() !== 'GET' && /\/api\/messages/.test(req.url())) {
      writes.push({ method: req.method(), url: req.url() })
      req.abort().catch(() => {})
      return
    }
    req.continue().catch(() => {})
  })

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
  if (!loggedIn) harness('credentials login failed')

  /** Rectangle de la n-ième ligne VISIBLE, ou null s'il n'y en a aucune. */
  const visibleRow = (nth = 0) => page.evaluate(({ sel, nth }) => {
    const seen = [...document.querySelectorAll(sel)]
      .map(n => ({ n, r: n.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
    const hit = seen[Math.min(nth, seen.length - 1)]
    if (!hit) return null
    const { x, y, width, height } = hit.r
    return { x, y, w: width, h: height }
  }, { sel: ROW, nth })

  const menuBox = () => page.evaluate(sel => {
    const m = document.querySelector(sel)
    if (!m) return null
    const r = m.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight }
  }, SURFACE)

  const closeMenu = async () => { await page.keyboard.press('Escape'); await wait(150) }

  const loadList = async width => {
    await page.setViewport({ width, height: HEIGHT })
    await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(ROW, { timeout: NAV_TIMEOUT_MS })
    await wait(SETTLE_MS)
  }

  // ---- A. le menu s'ouvre à TOUTE largeur, en vue liste -----------------------------
  console.log(`A. menu du clic droit, vue liste (${WIDTHS.join(' / ')} px)`)
  for (const width of WIDTHS) {
    await loadList(width)
    const row = await visibleRow(2)
    if (!row) harness(`no visible mail row at ${width}px — the bench cannot click what is not rendered`)
    await page.mouse.click(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2), { button: 'right' })
    await wait(350)
    const box = await menuBox()
    const inside = !!box && box.x >= EDGE_GAP - PX_SLACK && box.right <= box.vw - EDGE_GAP + PX_SLACK
      && box.y >= EDGE_GAP - PX_SLACK && box.bottom <= box.vh - EDGE_GAP + PX_SLACK
    check(`${width}px : menu ouvert et dans la fenêtre`, inside,
      box ? `menu [${box.x.toFixed(0)},${box.right.toFixed(0)}]x[${box.y.toFixed(0)},${box.bottom.toFixed(0)}] dans ${box.vw}x${box.vh}` : 'aucun menu')
    await closeMenu()
  }

  // ---- B. la CAUSE : sous `lg`, un message ouvert masque la colonne de liste --------
  console.log(`B. cause racine — colonne de liste \`${LIST_COL_RULE}\`, point de rupture lg = ${LG_PX}px`)
  const columnCensus = async width => {
    await loadList(width)
    const row = await visibleRow(2)
    if (!row) harness(`no visible mail row at ${width}px before opening a message`)
    await page.mouse.click(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2))
    await wait(OPEN_MS)
    return page.evaluate(sel => {
      const rows = [...document.querySelectorAll(sel)]
      const visible = rows.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      const col = rows[0]?.closest('div[style*="--synap-list-w"]') ?? null
      const back = [...document.querySelectorAll('button')]
        .find(b => b.getBoundingClientRect().width > 0 && /retour|back/i.test(b.textContent || ''))
      const br = back?.getBoundingClientRect()
      return {
        inDom: rows.length,
        visible: visible.length,
        colDisplay: col ? getComputedStyle(col).display : null,
        back: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null,
      }
    }, ROW)
  }

  const narrow = WIDTHS.find(w => w < LG_PX)
  const wide = WIDTHS.find(w => w >= LG_PX)
  const narrowOpen = await columnCensus(narrow)
  check(`${narrow}px, message ouvert : lignes présentes mais AUCUNE à l'écran`,
    narrowOpen.inDom > 0 && narrowOpen.visible === 0 && narrowOpen.colDisplay === 'none',
    `${narrowOpen.inDom} lignes dans le DOM, ${narrowOpen.visible} visibles, colonne display=${narrowOpen.colDisplay}`)

  // ---- C. la voie documentée du retour ---------------------------------------------
  console.log('C. retour à la liste sous le point de rupture')
  check(`${narrow}px : le bouton « Retour » est visible`, !!narrowOpen.back,
    narrowOpen.back ? `à (${narrowOpen.back.x.toFixed(0)},${narrowOpen.back.y.toFixed(0)})` : 'absent')
  if (narrowOpen.back) {
    await page.mouse.click(Math.round(narrowOpen.back.x + narrowOpen.back.w / 2), Math.round(narrowOpen.back.y + narrowOpen.back.h / 2))
    await wait(SETTLE_MS)
    const row = await visibleRow(2)
    check(`${narrow}px : la liste est revenue`, !!row, row ? `ligne à (${row.x.toFixed(0)},${row.y.toFixed(0)})` : 'aucune ligne visible')
    if (row) {
      await page.mouse.click(Math.round(row.x + row.w / 2), Math.round(row.y + row.h / 2), { button: 'right' })
      await wait(350)
      const box = await menuBox()
      check(`${narrow}px : le clic droit remarche après « Retour »`, !!box,
        box ? `menu ${box.w.toFixed(0)}x${box.h.toFixed(0)}` : 'aucun menu')
      await closeMenu()
    }
  }

  // RÉFÉRENCE du bras B : au-dessus du point de rupture la colonne reste `flex`.
  const wideOpen = await columnCensus(wide)
  check(`RÉFÉRENCE ${wide}px, message ouvert : la colonne reste à l'écran`,
    wideOpen.visible > 0 && wideOpen.colDisplay !== 'none',
    `${wideOpen.visible} lignes visibles, colonne display=${wideOpen.colDisplay}`)

  // ---- D. le panneau « Déplacer vers » se replie à GAUCHE en fenêtre étroite -------
  console.log('D. panneau « Déplacer vers » près du bord droit')
  const panelAt = async width => {
    await loadList(width)
    const row = await visibleRow(3)
    if (!row) harness(`no visible mail row at ${width}px for the move-panel arm`)
    await page.mouse.click(Math.round(row.x + row.w - RIGHT_EDGE_PX), Math.round(row.y + row.h / 2), { button: 'right' })
    await wait(350)
    const menu = await menuBox()
    if (!menu) return { menu: null }
    const mv = await page.evaluate(sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }, MOVE_ROW)
    if (!mv) return { menu, mv: null }
    await page.mouse.move(Math.round(mv.x + mv.w / 2), Math.round(mv.y + mv.h / 2))
    await page.waitForSelector(PANEL, { timeout: 5000 }).catch(() => {})
    await wait(300)
    const panel = await page.evaluate(sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, right: r.right, top: r.top, bottom: r.bottom, w: r.width, vw: innerWidth, vh: innerHeight }
    }, PANEL)
    await closeMenu()
    return { menu, mv, panel }
  }

  for (const width of WIDTHS.filter(w => w < LG_PX)) {
    const { menu, panel } = await panelAt(width)
    if (!menu || !panel) { check(`${width}px : panneau mesurable`, false, !menu ? 'aucun menu' : 'aucun panneau'); continue }
    const inWindow = panel.x >= EDGE_GAP - PX_SLACK && panel.right <= panel.vw - EDGE_GAP + PX_SLACK
      && panel.top >= EDGE_GAP - PX_SLACK && panel.bottom <= panel.vh - EDGE_GAP + PX_SLACK
    const folded = panel.x < menu.x
    check(`${width}px : panneau dans la fenêtre ET replié à gauche du menu`, inWindow && folded,
      `panneau [${panel.x.toFixed(0)},${panel.right.toFixed(0)}] menu [${menu.x.toFixed(0)},${menu.right.toFixed(0)}] fenêtre ${panel.vw}px`)
  }
  // RÉFÉRENCE : au large, le même clic droit ouvre le panneau à DROITE — sans quoi
  // « replié à gauche » serait aussi ce que montrerait un panneau qui ne bouge jamais.
  const refPanel = await panelAt(WIDTHS[0])
  check(`RÉFÉRENCE ${WIDTHS[0]}px : le panneau s'ouvre à DROITE du menu`,
    !!refPanel.panel && !!refPanel.menu && refPanel.panel.x > refPanel.menu.x,
    refPanel.panel && refPanel.menu ? `panneau x=${refPanel.panel.x.toFixed(0)} menu x=${refPanel.menu.x.toFixed(0)}` : 'non mesurable')

  console.log(`\nécritures interceptées (aucune n'a atteint le serveur) : ${writes.length}`)
  for (const w of writes) console.log(`  ${w.method} ${w.url.replace(BASE, '')}`)
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\ncheck-mail-context-widths : ${failures.length} échec(s)\n${failures.map(f => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\ncheck-mail-context-widths : OK')
