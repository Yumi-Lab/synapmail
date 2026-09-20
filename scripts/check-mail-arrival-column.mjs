#!/usr/bin/env node
/**
 * Browser bench of lot S7c — arriving on /mail in a narrow window must show the LIST,
 * not the reading pane.
 *
 * Why it exists: at S7b's human gate, Nicolas measured on staging at 900 px, with the
 * default account setting `reading_pane: true`, that loading /mail showed the reading
 * pane's "À traiter" panel and a "Retour" button — no mail row on screen at all
 * (`ligneVisible: false` at load, `true` (898 px) after clicking "Retour").
 *
 * The cause, read in the source before touching it: `showReadingPane` carries ONE
 * meaning — a message is open. Above `lg` it has no layout effect (both columns carry
 * `lg:flex` in both states); below `lg` it alone decides WHICH column takes the screen.
 * Initializing it from the `reading_pane` setting therefore let a setting meant for the
 * TWO-column view pick the arrival column of the ONE-column view.
 *
 * The arms, each with its same-run reference:
 *
 *  A. ARRIVAL SHOWS THE LIST — load /mail with no message selected at 1440, 900, 780
 *     and 390 px: a mail row is VISIBLE and right-clicking it opens the menu. No
 *     absolute threshold: 1440 px is measured in the SAME run as the narrow widths and
 *     is their reference (a red 1440 would indict the bench or the session, not width).
 *  B. THE SETTING IS REALLY ON — the same run reads GET /api/settings and asserts
 *     `reading_pane: true` for the bench account. Without this, arm A would also be
 *     green on an account where the setting is off, i.e. it would measure nothing.
 *  C. OPENING A MESSAGE STILL GIVES THE SCREEN TO THE PANE — below `lg`, clicking a row
 *     hides the list column (`display: none`) and shows "Retour". REFERENCE: the same
 *     click at 1440 px leaves the list column on screen. This is what keeps the
 *     one-column-at-a-time rule (lot S7b's arm B) intact rather than traded away.
 *  D. "RETOUR" BRINGS THE LIST BACK — after C, pressing "Retour" makes a row visible
 *     again. Unchanged behaviour, asserted so this lot cannot silently break it.
 *
 * READ ONLY: every non-GET request to /api/messages and /api/settings is captured and
 * ABORTED, so no message is touched and the bench account's settings are never written.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-mail-arrival-column.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HEIGHT = 900
// La largeur large est la RÉFÉRENCE de même run des étroites ; les trois étroites sont
// celles que Nicolas a mesurées sur le staging au gate S7b.
const WIDTHS = [1440, 900, 780, 390]
// Un serveur de dev COMPILE /mail au premier appel : la valeur par défaut de puppeteer
// (30 s) transformerait cette compilation en échec de BANC, qui ne dirait rien du produit.
const NAV_TIMEOUT_MS = 180000
const SETTLE_MS = 500
// Ouvrir un message attend une requête réseau, pas seulement un rendu.
const OPEN_MS = 1500

// Le point de rupture vient de la SOURCE, pas d'un chiffre recopié : c'est la classe
// `lg:` de la colonne de liste qui décide, et Tailwind la fixe à 1024 px par défaut.
const SHELL_SRC = readFileSync(new URL('../app/(app)/mail/MailClient.tsx', import.meta.url), 'utf8')
if (!/showReadingPane \? 'hidden lg:flex' : 'flex'/.test(SHELL_SRC)) {
  console.error("HARNESS: could not read the list column's responsive rule from app/(app)/mail/MailClient.tsx")
  process.exit(2)
}
const TW_SRC = readFileSync(new URL('../tailwind.config.ts', import.meta.url), 'utf8')
const LG_PX = Number(TW_SRC.match(/lg:\s*['"](\d+)px['"]/)?.[1]) || 1024

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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  protocolTimeout: NAV_TIMEOUT_MS * 2,
})
try {
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
  await page.setViewport({ width: WIDTHS[0], height: HEIGHT })

  // LECTURE SEULE : toute requête mutante sur les messages OU sur les réglages du compte
  // de banc est capturée et avortée — elle n'atteint jamais le serveur.
  await page.setRequestInterception(true)
  const writes = []
  page.on('request', req => {
    if (req.method() !== 'GET' && /\/api\/(messages|settings)/.test(req.url())) {
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

  /** État de la coquille : ligne visible, colonne de liste, bouton « Retour ». */
  const census = () => page.evaluate(sel => {
    const rows = [...document.querySelectorAll(sel)]
    const visible = rows.map(n => n.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)
    const col = rows[0]?.closest('div[style*="--synap-list-w"]') ?? null
    const back = [...document.querySelectorAll('button')]
      .find(b => b.getBoundingClientRect().width > 0 && /retour|back/i.test(b.textContent || ''))
    const br = back?.getBoundingClientRect()
    const first = visible[0]
    return {
      inDom: rows.length,
      visible: visible.length,
      row: first ? { x: first.x, y: first.y, w: first.width, h: first.height } : null,
      colDisplay: col ? getComputedStyle(col).display : null,
      back: br ? { x: br.x, y: br.y, w: br.width, h: br.height } : null,
    }
  }, ROW)

  const menuBox = () => page.evaluate(sel => {
    const m = document.querySelector(sel)
    if (!m) return null
    const r = m.getBoundingClientRect()
    return { w: r.width, h: r.height }
  }, SURFACE)

  const arrive = async width => {
    await page.setViewport({ width, height: HEIGHT })
    await page.goto(`${BASE}/mail`, { waitUntil: 'networkidle2' })
    await page.waitForSelector(ROW, { timeout: NAV_TIMEOUT_MS })
    await wait(SETTLE_MS)
    return census()
  }

  // ---- B. le réglage est bien ACTIF sur le compte du banc ---------------------------
  // Sans cette lecture, le bras A serait vert aussi sur un compte où `reading_pane` est
  // à faux : il ne mesurerait alors rien du défaut que ce lot corrige.
  const settings = await page.evaluate(async base => (await (await fetch(`${base}/api/settings`)).json()).data, BASE)
  check('le compte du banc a bien `reading_pane: true` (le défaut)', settings?.reading_pane === true,
    `reading_pane=${settings?.reading_pane}`)

  // ---- A. à l'ARRIVÉE, la liste est à l'écran et le clic droit y marche -------------
  console.log(`A. arrivée sur /mail sans message sélectionné (${WIDTHS.join(' / ')} px)`)
  for (const width of WIDTHS) {
    const c = await arrive(width)
    check(`${width}px : une ligne est VISIBLE à l'arrivée`, c.visible > 0,
      `${c.inDom} lignes dans le DOM, ${c.visible} visibles, colonne display=${c.colDisplay}`)
    if (!c.row) continue
    await page.mouse.click(Math.round(c.row.x + c.row.w / 2), Math.round(c.row.y + c.row.h / 2), { button: 'right' })
    await wait(350)
    const box = await menuBox()
    check(`${width}px : le clic droit y ouvre le menu`, !!box,
      box ? `menu ${box.w.toFixed(0)}x${box.h.toFixed(0)}` : 'aucun menu')
    await page.keyboard.press('Escape')
    await wait(150)
  }

  // ---- C/D. ouvrir un message, puis revenir ----------------------------------------
  console.log(`C. un message ouvert donne l'écran au volet sous lg (${LG_PX}px), D. « Retour » ramène la liste`)
  const narrow = WIDTHS.find(w => w < LG_PX)
  const wide = WIDTHS.find(w => w >= LG_PX)

  const openFirst = async width => {
    const c = await arrive(width)
    if (!c.row) harness(`no visible mail row at ${width}px before opening a message`)
    await page.mouse.click(Math.round(c.row.x + c.row.w / 2), Math.round(c.row.y + c.row.h / 2))
    await wait(OPEN_MS)
    return census()
  }

  const narrowOpen = await openFirst(narrow)
  check(`${narrow}px, message ouvert : le volet prend l'écran`,
    narrowOpen.visible === 0 && narrowOpen.colDisplay === 'none' && !!narrowOpen.back,
    `${narrowOpen.visible} lignes visibles, colonne display=${narrowOpen.colDisplay}, bouton Retour ${narrowOpen.back ? 'présent' : 'absent'}`)

  if (narrowOpen.back) {
    await page.mouse.click(Math.round(narrowOpen.back.x + narrowOpen.back.w / 2), Math.round(narrowOpen.back.y + narrowOpen.back.h / 2))
    await wait(SETTLE_MS)
    const backToList = await census()
    check(`${narrow}px : « Retour » ramène la liste`, backToList.visible > 0,
      `${backToList.visible} lignes visibles, colonne display=${backToList.colDisplay}`)
  }

  // RÉFÉRENCE du bras C : au large, ouvrir un message ne retire pas la liste.
  const wideOpen = await openFirst(wide)
  check(`RÉFÉRENCE ${wide}px, message ouvert : la liste reste à l'écran`,
    wideOpen.visible > 0 && wideOpen.colDisplay !== 'none',
    `${wideOpen.visible} lignes visibles, colonne display=${wideOpen.colDisplay}`)

  console.log(`\nécritures interceptées (aucune n'a atteint le serveur) : ${writes.length}`)
  for (const w of writes) console.log(`  ${w.method} ${w.url.replace(BASE, '')}`)
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\ncheck-mail-arrival-column : ${failures.length} échec(s)\n${failures.map(f => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\ncheck-mail-arrival-column : OK')
