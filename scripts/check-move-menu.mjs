#!/usr/bin/env node
/**
 * Browser bench of lot S7 — the right-click menu and its "Move to" panel, driven by a
 * REAL mouse and a REAL wheel in Chrome, on the test account. Everything this lot claims
 * is a GESTURE, and no static read of the sources can tell whether a gesture works: the
 * shipped code can hold the right listener and still lose the menu because the panel is
 * not where the pointer goes.
 *
 * The arms, each with its same-run reference:
 *
 *  A. WHEEL INSIDE THE FOLDER LIST — the menu and its panel stay open, and the list
 *     actually scrolled. REFERENCE (arm D): the same wheel on the MAIL LIST underneath
 *     still closes the menu. Without D, "stays open" would also be what a dead listener
 *     looks like, so A alone proves nothing.
 *  B. DRAGGING THE SCROLLBAR — a left press inside the ThinScroll band, a drag, a
 *     release: the menu stays open and the list scrolled. This is the gesture the report
 *     named first ("elle disparaît si on essaie d'attraper la scrollbar").
 *  C. DIAGONAL CROSSING — from the "Move to" row to the panel, passing over a NEIGHBOUR
 *     entry of the parent menu, under the delay: the panel is still open on arrival.
 *     REFERENCE: staying on that same neighbour BEYOND the delay does close it — which
 *     is what tells a delay apart from "it never closes".
 *  D. WHEEL ON THE MAIL LIST — the menu closes. Reference arm of A (see above).
 *  E. THE PANEL IS INSIDE THE WINDOW — right-click near the right edge and near the
 *     bottom, at both widths: the panel's rectangle stays within the viewport.
 *  F. FILTER AND ENTER — typing narrows the list (case- and accent-insensitive through
 *     the omnibar's own foldText), and Enter fires the move request at the FIRST shown
 *     folder. The request is INTERCEPTED: its path is read, it never reaches the server.
 *  G. GEOMETRY AND THEMES — 1440 px and 390 px, light and dark: the menu is inside the
 *     window and its surface is opaque (a transparent popover over a mail list is
 *     unreadable whatever the theme).
 *
 * READ ONLY: every non-GET request to /api/messages is captured and ABORTED, so no
 * message is moved, flagged or deleted, and no body is printed.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-move-menu.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Les deux largeurs que le lot S7 nomme.
const WIDE = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }
// Un serveur de dev COMPILE /mail au premier appel : la valeur par défaut de puppeteer
// (30 s) transformerait cette compilation en échec de BANC, qui ne dirait rien du produit.
const NAV_TIMEOUT_MS = 180000
const SETTLE_MS = 400
// Le banc doit franchir la traversée diagonale SOUS le délai du produit, et attendre
// AU-DELÀ pour la référence. Les deux bornes sont dérivées de la constante livrée, pas
// recopiées : la recalibrer là-bas recalibre ce banc.
const SURFACE_SRC = readFileSync(new URL('../components/ui/ContextMenu.tsx', import.meta.url), 'utf8')
const SUBMENU_SWITCH_MS = Number(SURFACE_SRC.match(/SUBMENU_SWITCH_MS = (\d+)/)?.[1])
const EDGE_GAP = Number(SURFACE_SRC.match(/EDGE_GAP = (\d+)/)?.[1])
const THIN_SRC = readFileSync(new URL('../components/layout/ThinScroll.tsx', import.meta.url), 'utf8')
const BAND_PX = Number(THIN_SRC.match(/bandWidth: (\d+)/)?.[1])
for (const [k, v] of Object.entries({ SUBMENU_SWITCH_MS, EDGE_GAP, BAND_PX })) {
  if (!Number.isFinite(v)) { console.error(`HARNESS: could not read ${k} from the shipped modules`); process.exit(2) }
}
// Tolérance d'un pixel sur les rectangles : Chrome rend en pixels fractionnaires.
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
const settle = () => wait(SETTLE_MS)

const ROW = '[data-mail-row]'
const SURFACE = '[data-mail-context-menu]'
const MOVE_ROW = '[data-menu-item="move"]'
const PANEL = '[data-menu-panel="move"]'
const FILTER = '[data-menu-folder-filter]'
const FOLDER = '[data-menu-folder]'

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  protocolTimeout: NAV_TIMEOUT_MS * 2,
})
let page = null
// Réglages de l'utilisateur de test empruntés par le banc, rendus tels quels à la sortie.
let previousSettings = null
try {
  page = await browser.newPage()
  await page.setViewport(WIDE)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  // LECTURE SEULE sur le courrier : toute requête mutante sur l'API des messages est
  // capturée et avortée — elle n'atteint jamais le serveur.
  await page.setRequestInterception(true)
  const writes = []
  page.on('request', req => {
    const url = req.url()
    if (req.method() !== 'GET' && /\/api\/messages/.test(url)) {
      let body = null
      try { body = JSON.parse(req.postData() ?? 'null') } catch { body = null }
      writes.push({ method: req.method(), url, body })
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

  // La boîte ACTIVE du compte de test n'a que quelques dossiers : la liste « Déplacer
  // vers » n'y déborde pas, et les arms A et B n'auraient rien à faire défiler. Le banc
  // choisit donc la boîte qui en a le PLUS, et REND l'ancienne au `finally` — le réglage
  // appartient à l'utilisateur de test, pas au banc.
  const accounts = await page.evaluate(async () => (await (await fetch('/api/accounts')).json()).data ?? [])
  if (accounts.length === 0) harness('the test user has no mailbox')
  const counted = []
  for (const a of accounts) {
    const folders = await page.evaluate(async id =>
      (await (await fetch(`/api/folders?account=${id}`)).json()).data ?? [], a.id)
    counted.push({ id: a.id, email: a.email, folders: folders.length })
  }
  counted.sort((x, y) => y.folders - x.folders)
  const richest = counted[0]
  const settings = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).data)
  previousSettings = { active_account_id: settings?.active_account_id ?? null, reading_pane: settings?.reading_pane ?? false }
  // `reading_pane` à vrai fait couvrir la colonne de LISTE par le volet de lecture sous
  // `lg` : à 390 px il n'y a alors plus une seule ligne de courrier sur laquelle faire un
  // clic droit, et le banc n'aurait rien à mesurer. C'est un réglage, pas un défaut ; le
  // banc l'emprunte et le rend.
  await page.evaluate(async patch => {
    await fetch('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
  }, { active_account_id: richest.id, reading_pane: false })

  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(ROW, { timeout: NAV_TIMEOUT_MS })
  await settle()

  /** Le rectangle d'un sélecteur, ou `null` s'il n'est pas dans le document. */
  const rectOf = sel => page.evaluate(s => {
    const el = document.querySelector(s)
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  }, sel)
  const present = async sel => (await page.$(sel)) !== null
  const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

  /**
   * Ouvre le menu sur une ligne de courrier, avec un VRAI clic droit, à `at` (une
   * fraction du rectangle de la ligne : {fx, fy}). Rend le rectangle du menu.
   */
  const openMenuOnRow = async (which = 'first', at = { fx: 0.5, fy: 0.5 }) => {
    await page.keyboard.press('Escape')
    await wait(80)
    // Le point visé doit APPARTENIR à la ligne : les en-têtes de date de la liste sont
    // `sticky`, et une ligne laissée dessous par un défilement précédent renvoie un
    // rectangle parfaitement valide sur lequel le clic droit atteint... l'en-tête. Le
    // banc hit-teste donc chaque candidate et garde la première qui répond d'elle-même.
    const point = await page.evaluate(([sel, w, fx, fy]) => {
      const rows = Array.from(document.querySelectorAll(sel))
      const order = w === 'last' ? rows.slice().reverse() : rows
      for (const row of order) {
        const r = row.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // Le bord droit d'une ligne porte la bande d'actions rapides : viser 97 % y
        // atteint un bouton, pas la ligne. On recule vers la gauche jusqu'au premier
        // point qui appartient VRAIMENT à la ligne — c'est la position la plus à droite
        // où un clic droit ouvre le menu, donc le pire cas que le lot S7 demande.
        for (let f = fx; f >= 0.2; f -= 0.05) {
          const x = r.x + r.width * f
          const y = r.y + r.height * fy
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
          if (row.contains(document.elementFromPoint(x, y))) return { x, y }
        }
      }
      return null
    }, [ROW, which, at.fx, at.fy])
    if (!point) harness(`no ${which} mail row is hit-testable at ${JSON.stringify(at)} — the list may be empty or fully covered`)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await page.waitForSelector(SURFACE, { timeout: 5000 })
    await settle()
    return rectOf(SURFACE)
  }

  /** Ouvre le panneau « Déplacer vers » au survol de son entrée. Rend son rectangle. */
  const openMovePanel = async () => {
    const row = await rectOf(MOVE_ROW)
    if (!row) harness('the "Move to" entry is not in the menu (no movable folder for this selection?)')
    const c = centre(row)
    await page.mouse.move(c.x, c.y, { steps: 6 })
    await page.waitForSelector(PANEL, { timeout: 5000 })
    await settle()
    return rectOf(PANEL)
  }

  /** Le viewport ThinScroll de la liste des dossiers du panneau, et son scrollTop. */
  const pickerScroll = () => page.evaluate(p => {
    const panel = document.querySelector(p)
    const vp = panel?.querySelector('[data-thin-scroll-viewport]')
    if (!vp) return null
    const { x, y, width, height } = vp.getBoundingClientRect()
    return { x, y, width, height, scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight }
  }, PANEL)

  console.log(`base           ${BASE}`)
  console.log(`mailbox        ${richest.email} (${richest.folders} folders, the richest of ${accounts.length})`)
  console.log(`viewport       ${WIDE.width}x${WIDE.height}`)
  console.log(`submenu delay  ${SUBMENU_SWITCH_MS} ms (read from ContextMenu.tsx)\n`)

  // ---------------------------------------------------------------- A + D
  console.log('A/D. la molette dans la liste des dossiers garde le menu, celle de la liste des mails le ferme')
  await openMenuOnRow()
  await openMovePanel()
  let sc = await pickerScroll()
  if (!sc) harness('the folder list has no ThinScroll viewport')
  if (sc.scrollHeight - sc.clientHeight < 10) harness(`the folder list does not overflow (${sc.scrollHeight} vs ${sc.clientHeight}), nothing to scroll`)
  const before = sc.scrollTop
  await page.mouse.move(sc.x + sc.width / 2, sc.y + sc.height / 2, { steps: 4 })
  await page.mouse.wheel({ deltaY: 200 })
  await wait(250)
  sc = await pickerScroll()
  const menuAlive = await present(SURFACE)
  const panelAlive = await present(PANEL)
  check('A. le menu reste ouvert quand on fait défiler SA liste de dossiers', menuAlive && panelAlive,
    `menu=${menuAlive} panneau=${panelAlive}`)
  check('A. la liste a bien défilé (le geste a un effet, il n\'est pas avalé)', !!sc && sc.scrollTop > before,
    `scrollTop ${before} -> ${sc?.scrollTop}`)

  // RÉFÉRENCE de A, même exécution : la molette sur la liste des mails, dessous.
  const listVp = await page.evaluate(r => {
    const vp = document.querySelector(r)?.closest('[data-thin-scroll-viewport]')
    if (!vp) return null
    const { x, y, width, height } = vp.getBoundingClientRect()
    return { x, y, width, height }
  }, ROW)
  if (!listVp) harness('the mail list has no ThinScroll viewport')
  await page.mouse.move(listVp.x + listVp.width / 2, listVp.y + listVp.height * 0.7, { steps: 4 })
  await page.mouse.wheel({ deltaY: 200 })
  await wait(250)
  check('D. RÉFÉRENCE : la molette sur la liste des mails ferme bien le menu', !(await present(SURFACE)),
    'sans cette arm, « le menu reste » serait aussi ce que donne un écouteur mort')

  // ---------------------------------------------------------------- B
  console.log('\nB. attraper l\'ascenseur de la liste des dossiers et le glisser')
  await openMenuOnRow()
  await openMovePanel()
  sc = await pickerScroll()
  const beforeDrag = sc.scrollTop
  // La bande sensible court le long du bord DROIT du ThinScroll : on y presse, on glisse.
  const bandX = sc.x + sc.width - BAND_PX / 2
  await page.mouse.move(bandX, sc.y + 10, { steps: 4 })
  await page.mouse.down()
  await page.mouse.move(bandX, sc.y + sc.height * 0.8, { steps: 12 })
  await wait(120)
  const duringDrag = await present(SURFACE)
  await page.mouse.up()
  await wait(200)
  sc = await pickerScroll()
  check('B. le menu reste ouvert pendant le glissement de l\'ascenseur', duringDrag && await present(SURFACE) && await present(PANEL))
  check('B. l\'ascenseur a fait défiler la liste', !!sc && sc.scrollTop > beforeDrag,
    `scrollTop ${beforeDrag} -> ${sc?.scrollTop}`)

  // ---------------------------------------------------------------- C
  console.log('\nC. traverser en diagonale vers le panneau, en passant sur une autre entrée')
  await openMenuOnRow()
  let panel = await openMovePanel()
  const moveRow = await rectOf(MOVE_ROW)
  // Une entrée VOISINE du menu parent, sous « Déplacer vers » : la diagonale passe
  // forcément dessus. On la prend dans le DOM pour ne pas recopier son nom.
  const neighbour = await page.evaluate((mv, surf) => {
    const items = Array.from(document.querySelector(surf).querySelectorAll('[data-menu-item]'))
    const at = items.findIndex(el => el.matches(mv))
    const el = items[at + 1] ?? items[at - 1]
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { key: el.getAttribute('data-menu-item'), x, y, width, height }
  }, MOVE_ROW, SURFACE)
  if (!neighbour) harness('the menu has no neighbouring entry to cross over')
  // Départ sur l'entrée, passage par le voisin, arrivée dans le panneau — le tout SOUS
  // le délai : c'est exactement le geste qui faisait disparaître le sous-menu.
  await page.mouse.move(centre(moveRow).x, centre(moveRow).y, { steps: 3 })
  const started = Date.now()
  await page.mouse.move(neighbour.x + neighbour.width * 0.8, neighbour.y + neighbour.height / 2, { steps: 4 })
  await page.mouse.move(panel.x + panel.width * 0.4, panel.y + panel.height * 0.6, { steps: 6 })
  const crossedMs = Date.now() - started
  await wait(40)
  check('C. le panneau survit à la traversée en diagonale', await present(PANEL),
    `traversée en ${crossedMs} ms, délai du produit ${SUBMENU_SWITCH_MS} ms`)
  if (crossedMs >= SUBMENU_SWITCH_MS) harness(`the crossing took ${crossedMs} ms, at or above the ${SUBMENU_SWITCH_MS} ms delay — this arm did not test what it claims`)
  // RÉFÉRENCE de C : rester sur le voisin AU-DELÀ du délai ferme bien le panneau.
  await page.mouse.move(neighbour.x + neighbour.width / 2, neighbour.y + neighbour.height / 2, { steps: 4 })
  await wait(SUBMENU_SWITCH_MS * 2)
  check('C. RÉFÉRENCE : rester sur le voisin au-delà du délai ferme le panneau', !(await present(PANEL)),
    'sans cette arm, « il reste » serait aussi ce que donne un panneau qui ne se ferme jamais')

  // ---------------------------------------------------------------- E + G
  console.log('\nE/G. le panneau tient dans l\'écran, près du bord droit et près du bas, aux deux largeurs')
  const inWindow = (r, vp) =>
    r.x >= EDGE_GAP - PX_SLACK && r.y >= EDGE_GAP - PX_SLACK
    && r.x + r.width <= vp.width - EDGE_GAP + PX_SLACK
    && r.y + r.height <= vp.height - EDGE_GAP + PX_SLACK
  for (const vp of [WIDE, NARROW]) {
    await page.setViewport(vp)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(ROW, { timeout: NAV_TIMEOUT_MS })
    await settle()
    for (const [what, at, which] of [['bord droit', { fx: 0.97, fy: 0.5 }, 'first'], ['bas', { fx: 0.5, fy: 0.5 }, 'last']]) {
      // Près du BAS de la fenêtre : la dernière ligne atteignable à la souris.
      const menuRect = await openMenuOnRow(which, at)
      check(`E. ${vp.width} px, ${what} : le menu est entièrement dans la fenêtre`, inWindow(menuRect, vp),
        `menu ${JSON.stringify(menuRect)}`)
      panel = await openMovePanel()
      check(`E. ${vp.width} px, ${what} : le panneau est entièrement dans la fenêtre`, inWindow(panel, vp),
        `panneau ${JSON.stringify(panel)}`)
    }
  }
  await page.setViewport(WIDE)
  await settle()

  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => {
      document.documentElement.classList.toggle('dark', t === 'dark')
    }, theme)
    await openMenuOnRow()
    await openMovePanel()
    // Un popover TRANSPARENT laisse la liste des mails transparaître au travers : le
    // menu devient illisible, quel que soit le thème. La couleur elle-même est un choix
    // visuel, c'est le gate humain qui la juge ; l'opacité, elle, se mesure.
    // L'opacité se MESURE, elle ne se lit pas dans la chaîne de couleur : les variables du
    // thème sont écrites en `oklch()`, qu'aucune analyse de `rgba(...)` ne sait lire — et
    // une analyse qui rend `null` ferait passer l'arm pour un défaut du produit. On peint
    // donc la couleur calculée sur un canevas et on lit le canal alpha obtenu.
    const paint = await page.evaluate(s => {
      const bg = getComputedStyle(document.querySelector(s)).backgroundColor
      const c = document.createElement('canvas').getContext('2d')
      c.fillStyle = bg
      c.fillRect(0, 0, 1, 1)
      return { bg, alpha: c.getImageData(0, 0, 1, 1).data[3] / 255 }
    }, SURFACE)
    check(`G. thème ${theme} : la surface du menu est opaque`, paint.alpha === 1, `${paint.bg} -> alpha=${paint.alpha}`)
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))

  // ---------------------------------------------------------------- F
  console.log('\nF. filtrer au clavier, puis Entrée déplace vers le premier résultat')
  await openMenuOnRow()
  await openMovePanel()
  const all = await page.$$eval(FOLDER, els => els.map(e => e.getAttribute('data-menu-folder')))
  if (all.length < 2) harness(`only ${all.length} movable folder(s), the filter arm needs at least 2`)
  const focused = await page.evaluate(f => document.activeElement?.matches(f) ?? false, FILTER)
  check('F. le champ de filtre a le focus à l\'ouverture', focused)
  // Le terme est DÉRIVÉ d'un dossier réel, en MAJUSCULES et sans accents : il vérifie du
  // même coup l'insensibilité à la casse et aux accents de `foldText`.
  const target = all.find(p => p.length >= 3) ?? all[0]
  const needle = target.split(/[/.]/).pop().slice(0, 3)
  const typed = needle.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  await page.keyboard.type(typed, { delay: 30 })
  await wait(200)
  const shown = await page.$$eval(FOLDER, els => els.map(e => e.getAttribute('data-menu-folder')))
  check('F. le filtre réduit la liste', shown.length > 0 && shown.length < all.length,
    `« ${typed} » : ${shown.length} sur ${all.length}`)
  const writesBefore = writes.length
  await page.keyboard.press('Enter')
  await wait(500)
  const move = writes.slice(writesBefore).find(w => w.body?.action === 'move')
  check('F. Entrée envoie UNE requête de déplacement (interceptée, jamais exécutée)', !!move,
    move ? `${move.method} ${new URL(move.url).pathname}` : `aucune parmi ${writes.length - writesBefore}`)
  check('F. la requête vise le PREMIER dossier affiché', move?.body?.destination === shown[0],
    `demandé ${JSON.stringify(move?.body?.destination)}, attendu ${JSON.stringify(shown[0])}`)

  console.log(`\nwrites intercepted: ${writes.length} (aucune n'a atteint le serveur)`)
} finally {
  if (page && previousSettings) {
    await page.evaluate(async patch => {
      await fetch('/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
    }, previousSettings).catch(() => {})
  }
  if (page) await page.close().catch(() => {})
  await browser.close().catch(() => {})
}

if (failures.length) {
  console.error(`\ncheck-move-menu: ${failures.length} FAIL — ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\ncheck-move-menu: OK')
