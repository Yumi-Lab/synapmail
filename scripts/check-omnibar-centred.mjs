#!/usr/bin/env node
/**
 * Lot H3k — le champ de l'omnibar est-il centré sur l'ÉCRAN ?
 *
 * Ce que le banc mesure, sur /mail ET sur /dashboard (décision de Nicolas du
 * 20/09/2026 : même règle, même géométrie sur les deux pages) :
 *   1. |centre du champ − centre de l'ÉCRAN| ≤ 1 px à 1440, 1728, 1920 et 2560 px ;
 *   2. écart de position ET de largeur du champ entre /mail et /dashboard ≤ 1 px,
 *      à chaque largeur — le champ ne saute pas d'une page à l'autre ;
 *   3. à 1280 px et 390 px : aucun chevauchement avec les icônes de gauche ni avec
 *      le groupe de droite, aucun débordement horizontal de l'en-tête ;
 *   4. la puce de portée (lot H3g) reste DANS le champ, quelle que soit sa largeur ;
 *   5. la largeur du champ ne dépasse jamais la borne exportée par le composant.
 *
 * Pourquoi le centre de l'ÉCRAN et pas celui de l'en-tête : l'en-tête commence au
 * bord droit de la barre latérale. Se centrer sur lui, c'est tomber à `barre / 2` à
 * droite du centre visuel — le défaut que Nicolas signale depuis trois passages
 * (307 px mesurés sur le staging à 1440 px, 126 px en prod).
 *
 * Contrôle négatif intégré (`--negative`) : la mesure est refaite en neutralisant la
 * piste de rattrapage de la barre (`--synap-bar-w: 0px`), c'est-à-dire en revenant à
 * un centrage sur l'EN-TÊTE. Elle DOIT alors échouer, sinon le critère ne distingue
 * rien et ne prouve rien.
 *
 * Les tolérances et les bornes ne sont pas des constantes calibrées ailleurs : la
 * borne de largeur est LUE dans `components/layout/Omnibar.tsx` au même run, et le
 * critère de centrage est un ZÉRO (écart au centre de l'écran), avec 1 px de marge
 * pour l'arrondi sous-pixel du moteur de rendu — pas un seuil à étalonner.
 *
 *   node scripts/check-omnibar-centred.mjs
 *   node scripts/check-omnibar-centred.mjs --negative
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Arrondi sous-pixel du moteur de rendu : tout ce qu'un humain verrait est au-dessus. */
const MAX_DRIFT_PX = 1
const NEGATIVE = process.argv.includes('--negative')

const OMNIBAR_SRC = readFileSync(new URL('../components/layout/Omnibar.tsx', import.meta.url), 'utf8')
const FIELD_MAX_WIDTH = Number(OMNIBAR_SRC.match(/searchMaxWidth:\s*(\d+)/)?.[1])
const FIELD_MIN_WIDTH = Number(OMNIBAR_SRC.match(/searchMinWidth:\s*(\d+)/)?.[1])
if (!FIELD_MAX_WIDTH || !FIELD_MIN_WIDTH) {
  console.error('HARNESS: could not read searchMaxWidth/searchMinWidth from Omnibar.tsx')
  process.exit(2)
}

/** Largeurs où le champ doit être CENTRÉ sur l'écran (la place symétrique y tient). */
const CENTRED_WIDTHS = [1440, 1728, 1920, 2560]
/** Largeurs où seule la non-collision est exigée (le champ a le droit d'être collé). */
const TIGHT_WIDTHS = [1280, 390]
const PAGES = ['/mail', '/dashboard']
const SETTLE_MS = 450
/**
 * La barre d'outils replie ses groupes APRÈS une mesure de dépassement, donc la
 * géométrie de l'en-tête bouge encore une ou deux frames après le premier rendu :
 * une attente à durée fixe l'a lue en cours de repli (observé une fois sur six, à
 * 390 px, la dernière icône à 212 px au lieu de 189). On lit donc jusqu'à ce que
 * la même mesure revienne DEUX fois de suite — plus de course, et aucune seconde
 * perdue quand c'est déjà stable.
 */
const STABLE_POLL_MS = 120
const STABLE_TRIES = 25

const BAR = '[data-omnibar]'
const FIELD = '[data-omnibar-search-field]'
const RIGHT = '[data-omnibar-right]'
const MENU = '[data-omnibar-menu]'
const SCOPE = '[data-omnibar-scope-trigger]'

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

/** Une passe de mesure : les boîtes qui décident, lues dans la MÊME frame. */
const probe = ({ bar, field, right, menu, scope }) => {
  const q = sel => document.querySelector(sel)
  const box = el => (el ? el.getBoundingClientRect() : null)
  const barEl = q(bar), fieldEl = q(field)
  if (!barEl || !fieldEl) return null
  const f = box(fieldEl)
  // Dernier élément cliquable AVANT le champ : le bouton le plus à droite de la
  // rangée d'icônes / de la barre d'outils, celui qui pourrait chevaucher le champ.
  // Les boutons de la place RÉSERVÉE (lot H4b : la barre d'outils garde sa place
  // hors du courrier, en `visibility: hidden`) ont une boîte de mise en page mais ne
  // se voient pas — un élément invisible ne peut pas chevaucher visuellement quoi
  // que ce soit. Le critère est visuel, on ne compte donc que ce qui est VISIBLE.
  const visible = el => {
    for (let n = el; n instanceof Element; n = n.parentElement) {
      const st = getComputedStyle(n)
      if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false
    }
    return true
  }
  const leftBoxes = Array.from(document.querySelectorAll(`${bar} button, ${bar} a`))
    .filter(visible)
    .map(el => el.getBoundingClientRect())
    .filter(r => r.width > 0 && r.height > 0 && r.right <= f.left + 200 && r.left < f.left)
  const lastLeft = leftBoxes.length ? Math.max(...leftBoxes.map(r => r.right)) : null
  const r = box(q(right))
  const s = box(q(scope))
  return {
    screenWidth: window.innerWidth,
    bar: { left: box(barEl).left, right: box(barEl).right, width: box(barEl).width },
    field: { left: f.left, right: f.right, width: f.width, centre: f.left + f.width / 2 },
    lastLeft,
    rightGroup: r ? { left: r.left, right: r.right } : null,
    scope: s ? { left: s.left, right: s.right } : null,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    menuPresent: Boolean(q(menu)),
  }
}

/**
 * Lit `probe` jusqu'à obtenir deux mesures IDENTIQUES d'affilée. Renvoie la mesure
 * stabilisée ; sort en 2 (HARNESS) si elle ne se stabilise pas — un banc qui n'a
 * pas su lire ne dit rien du produit.
 */
const stableProbe = async (page, where) => {
  const args = { bar: BAR, field: FIELD, right: RIGHT, menu: MENU, scope: SCOPE }
  let prev = null
  for (let i = 0; i < STABLE_TRIES; i++) {
    const m = await page.evaluate(probe, args)
    if (!m) { console.error(`HARNESS: header or field missing at ${where}`); process.exit(2) }
    if (prev && JSON.stringify(prev) === JSON.stringify(m)) return m
    prev = m
    await new Promise(r => setTimeout(r, STABLE_POLL_MS))
  }
  console.error(`HARNESS: header geometry never settled at ${where} after ${STABLE_TRIES} reads`)
  process.exit(2)
}

const fails = []
const fail = msg => { fails.push(msg); console.log(`FAIL  ${msg}`) }
const ok = msg => console.log(`ok    ${msg}`)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
page.setDefaultNavigationTimeout(120000)

try {
  await page.setViewport({ width: 1440, height: 900 })
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

  if (NEGATIVE) {
    // Contrôle négatif : on annule la piste de rattrapage, donc le champ se centre
    // sur l'EN-TÊTE au lieu de l'ÉCRAN — l'état d'AVANT ce lot. Le banc doit rougir.
    await page.evaluateOnNewDocument(() => {
      const style = document.createElement('style')
      style.textContent = '[data-omnibar]{--synap-bar-w:0px !important}'
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
    })
    console.log('NEGATIVE: --synap-bar-w forcée à 0px (centrage sur l’en-tête, état d’avant H3k)')
  }

  const measured = new Map()
  for (const width of [...CENTRED_WIDTHS, ...TIGHT_WIDTHS]) {
    for (const path of PAGES) {
      await page.setViewport({ width, height: 900 })
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' })
      await page.waitForSelector(FIELD, { timeout: 20000 })
      await new Promise(r => setTimeout(r, SETTLE_MS))
      const m = await stableProbe(page, `${width}px ${path}`)
      measured.set(`${width}|${path}`, m)
    }
  }

  // --- 1. centré sur l'écran ---
  for (const width of CENTRED_WIDTHS) {
    for (const path of PAGES) {
      const m = measured.get(`${width}|${path}`)
      const drift = m.field.centre - m.screenWidth / 2
      const line = `${path} ${width}px : centre champ ${m.field.centre.toFixed(1)} vs centre écran ${(m.screenWidth / 2).toFixed(1)} → écart ${drift.toFixed(1)} px (largeur champ ${m.field.width.toFixed(1)})`
      if (Math.abs(drift) > MAX_DRIFT_PX) fail(line); else ok(line)
    }
  }

  // --- 2. même géométrie sur les deux pages ---
  for (const width of [...CENTRED_WIDTHS, ...TIGHT_WIDTHS]) {
    const a = measured.get(`${width}|/mail`), b = measured.get(`${width}|/dashboard`)
    const dLeft = Math.abs(a.field.left - b.field.left)
    const dWidth = Math.abs(a.field.width - b.field.width)
    const line = `${width}px : /mail vs /dashboard → position ${dLeft.toFixed(1)} px, largeur ${dWidth.toFixed(1)} px`
    if (dLeft > MAX_DRIFT_PX || dWidth > MAX_DRIFT_PX) fail(line); else ok(line)
  }

  // --- 3. aucun chevauchement, aucun débordement (toutes les largeurs) ---
  for (const width of [...CENTRED_WIDTHS, ...TIGHT_WIDTHS]) {
    for (const path of PAGES) {
      const m = measured.get(`${width}|${path}`)
      if (m.lastLeft != null && m.lastLeft > m.field.left + MAX_DRIFT_PX) {
        fail(`${path} ${width}px : la dernière icône (droite ${m.lastLeft.toFixed(1)}) chevauche le champ (gauche ${m.field.left.toFixed(1)})`)
      } else ok(`${path} ${width}px : icônes ${m.lastLeft == null ? 'absentes' : m.lastLeft.toFixed(1)} ≤ champ ${m.field.left.toFixed(1)}`)
      if (m.rightGroup && m.field.right > m.rightGroup.left + MAX_DRIFT_PX) {
        fail(`${path} ${width}px : le champ (droite ${m.field.right.toFixed(1)}) chevauche le groupe de droite (gauche ${m.rightGroup.left.toFixed(1)})`)
      } else ok(`${path} ${width}px : champ ${m.field.right.toFixed(1)} ≤ groupe droit ${m.rightGroup ? m.rightGroup.left.toFixed(1) : 'absent'}`)
      if (m.docOverflow > MAX_DRIFT_PX) fail(`${path} ${width}px : débordement horizontal de ${m.docOverflow} px`)
      else ok(`${path} ${width}px : aucun débordement horizontal (${m.docOverflow} px)`)
    }
  }

  // --- 4. la puce de portée reste DANS le champ ; 5. largeur bornée ---
  for (const width of [...CENTRED_WIDTHS, ...TIGHT_WIDTHS]) {
    for (const path of PAGES) {
      const m = measured.get(`${width}|${path}`)
      if (m.scope) {
        const inside = m.scope.left >= m.field.left - MAX_DRIFT_PX && m.scope.right <= m.field.right + MAX_DRIFT_PX
        const line = `${path} ${width}px : puce de portée [${m.scope.left.toFixed(1)}, ${m.scope.right.toFixed(1)}] dans le champ [${m.field.left.toFixed(1)}, ${m.field.right.toFixed(1)}]`
        if (!inside) fail(line); else ok(line)
      }
      if (m.field.width > FIELD_MAX_WIDTH + MAX_DRIFT_PX) {
        fail(`${path} ${width}px : champ ${m.field.width.toFixed(1)} px > borne ${FIELD_MAX_WIDTH} px lue dans Omnibar.tsx`)
      }
      if (m.field.width < FIELD_MIN_WIDTH - MAX_DRIFT_PX) {
        fail(`${path} ${width}px : champ ${m.field.width.toFixed(1)} px < plancher ${FIELD_MIN_WIDTH} px lu dans Omnibar.tsx`)
      }
    }
  }
} finally {
  await browser.close()
}

console.log(`\n${fails.length} FAIL`)
if (NEGATIVE) {
  if (fails.length === 0) {
    console.log('NEGATIVE: aucun échec alors que le rattrapage est neutralisé — le critère ne distingue RIEN.')
    process.exit(1)
  }
  console.log('NEGATIVE: le critère rougit bien quand le centrage retombe sur l’en-tête. Contrôle concluant.')
  process.exit(0)
}
process.exit(fails.length ? 1 : 0)
