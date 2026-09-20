#!/usr/bin/env node
/**
 * Lot H4b — la barre du haut ne bouge PAS entre le courrier et le tableau de bord.
 *
 * Mesuré en prod le 20/09/2026 : à 1440 px l'en-tête et le premier bouton ne
 * bougeaient pas, mais le CHAMP de recherche partait 342 px plus à gauche et gagnait
 * 80 px de large sur /dashboard, parce que la barre d'outils du courrier n'y était
 * pas rendue. Depuis le lot H4b sa place est RÉSERVÉE (même gabarit de rangée sur les
 * deux pages, rendu réel mis en `visibility: hidden`), donc le champ garde la même
 * gauche et la même largeur.
 *
 * Le critère est un écart PAGE À PAGE, mesuré dans la même exécution, sur la même
 * fenêtre : /mail est le bras de RÉFÉRENCE de /dashboard, il n'y a aucun seuil
 * absolu calibré ailleurs. La tolérance (1 px) est celle des autres bancs du fork
 * (`MAX_DRIFT_PX` de `check-omnibar.mjs`) : l'arrondi sous-pixel est attendu, ce
 * qu'un humain verrait ne l'est pas.
 *
 * Besoin d'un serveur qui tourne + SYNAPMAIL_TEST_* (voir .env).
 *   node scripts/check-header-stability.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Même plancher que les autres bancs du fork : l'arrondi sous-pixel n'est pas un défaut. */
const MAX_DRIFT_PX = 1
/** Les deux largeurs que le lot nomme. */
const WIDTHS = [1440, 1728]
/** La page de référence d'abord : c'est elle qui porte la barre d'outils. */
const PAGES = ['/mail', '/dashboard']

const SEARCH = '[data-omnibar-search]'
const TOOLBAR = '[data-mail-toolbar]'
const RESERVED = '[data-mail-toolbar-reserved]'
const MENU = '[data-omnibar-menu]'
const COMPOSE = '[data-omnibar-action="compose"]'

// Le nom de l'attribut de réserve est LU dans le composant : le banc ne tient pas
// sa propre copie de la convention, sinon il mesurerait sa copie.
const TOOLBAR_SRC = readFileSync(new URL('../components/layout/MailToolbar.tsx', import.meta.url), 'utf8')
if (!TOOLBAR_SRC.includes("'data-mail-toolbar-reserved'")) {
  console.error('HARNESS: data-mail-toolbar-reserved introuvable dans MailToolbar.tsx')
  process.exit(2)
}

const SETTLE_MS = 600

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas défini`); process.exit(2) }
}

/** Une passe de mesure : la géométrie des repères du header, dans la même frame. */
const probe = sels => {
  const box = sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, width: r.width, top: r.top }
  }
  const toolbar = document.querySelector(sels.toolbar)
  return {
    search: box(sels.search),
    menu: box(sels.menu),
    compose: box(sels.compose),
    toolbar: box(sels.toolbar),
    // Une barre vivante ou une place réservée : le banc doit pouvoir les distinguer.
    toolbarReserved: !!document.querySelector(sels.reserved),
    toolbarVisibility: toolbar ? getComputedStyle(toolbar).visibility : null,
    // Rien ne se clique dans la réserve : le point le plus proche du centre de la
    // barre ne doit PAS renvoyer un de ses boutons quand elle est réservée.
    hitAtToolbarCentre: toolbar
      ? (() => {
          const r = toolbar.getBoundingClientRect()
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return el ? !!el.closest('[data-mail-action]') : false
        })()
      : null,
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const failures = []
try {
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(120000)
  await page.setViewport({ width: WIDTHS[0], height: 900 })
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
  if (!loggedIn) { console.error('HARNESS: connexion refusée'); process.exit(2) }

  const sels = { search: SEARCH, menu: MENU, compose: COMPOSE, toolbar: TOOLBAR, reserved: RESERVED }

  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 900 })
    const seen = {}
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(SEARCH, { timeout: 20000 })
      await new Promise(r => setTimeout(r, SETTLE_MS))
      const m = await page.evaluate(probe, sels)
      if (!m.search) { failures.push(`${width}px ${path}: aucun ${SEARCH} dans le document`); continue }
      seen[path] = m
      console.log(`${width}px ${path}: champ gauche=${m.search.left.toFixed(2)} largeur=${m.search.width.toFixed(2)} | ` +
        `barre=${m.toolbar ? `${m.toolbar.left.toFixed(2)}..${m.toolbar.right.toFixed(2)} ${m.toolbarVisibility}` : 'absente'} ` +
        `réservée=${m.toolbarReserved} clicAuCentre=${m.hitAtToolbarCentre}`)
    }

    const ref = seen[PAGES[0]]
    const other = seen[PAGES[1]]
    if (!ref || !other) { failures.push(`${width}px : une des deux pages n'a pas été mesurée, aucun écart calculable`); continue }

    // Le critère du lot : l'écart entre les deux pages, pas une constante.
    for (const [name, pick] of [['gauche du champ', m => m.search.left], ['largeur du champ', m => m.search.width]]) {
      const drift = Math.abs(pick(ref) - pick(other))
      console.log(`${width}px écart ${name} entre ${PAGES[0]} et ${PAGES[1]} : ${drift.toFixed(2)}px`)
      if (drift > MAX_DRIFT_PX) {
        failures.push(`${width}px : ${name} bouge de ${drift.toFixed(2)}px entre ${PAGES[0]} (${pick(ref).toFixed(2)}) et ${PAGES[1]} (${pick(other).toFixed(2)})`)
      }
    }
    // Les deux repères déjà stables en prod le restent : une non-régression, pas un acquis.
    for (const [name, pick] of [['menu', m => m.menu?.left], ['nouveau message', m => m.compose?.left]]) {
      if (pick(ref) == null || pick(other) == null) { failures.push(`${width}px : bouton « ${name} » introuvable sur une des deux pages`); continue }
      const drift = Math.abs(pick(ref) - pick(other))
      if (drift > MAX_DRIFT_PX) failures.push(`${width}px : le bouton « ${name} » bouge de ${drift.toFixed(2)}px entre les deux pages`)
    }

    // La réserve est une PLACE, pas une barre : elle est invisible et rien ne s'y clique.
    if (ref.toolbarReserved) failures.push(`${width}px ${PAGES[0]} : la barre d'outils est marquée réservée alors que la boîte est ouverte`)
    if (ref.toolbarVisibility !== 'visible') failures.push(`${width}px ${PAGES[0]} : la barre d'outils est ${ref.toolbarVisibility}, elle devrait être visible`)
    if (!other.toolbarReserved) failures.push(`${width}px ${PAGES[1]} : la place de la barre d'outils n'est pas marquée réservée`)
    if (other.toolbarVisibility !== 'hidden') failures.push(`${width}px ${PAGES[1]} : la réserve est ${other.toolbarVisibility}, elle devrait être hidden`)
    if (other.hitAtToolbarCentre) failures.push(`${width}px ${PAGES[1]} : un bouton de la barre réservée reçoit encore le clic`)
    if (!ref.hitAtToolbarCentre) failures.push(`${width}px ${PAGES[0]} : aucun bouton de la barre ne reçoit le clic, la barre vivante est inerte`)
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\nKO — ${failures.length} écart(s) :`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nOK — la barre du haut ne bouge pas entre le courrier et le tableau de bord')
