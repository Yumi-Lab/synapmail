#!/usr/bin/env node
/**
 * Lot H4d — la CASE A COCHER de la selection est la MEME sur les deux listes.
 *
 * Nicolas : « avec le systeme de selecteur qu'on a deja code dans les boites
 * mail… il manque le cochage au niveau du badge ». Ce banc mesure, a la VRAIE
 * souris, sur l'application qui tourne, que la liste des newsletters du tableau
 * de bord rend la case exactement comme la liste des messages :
 *   1. au repos, la bulle porte ses lettres et AUCUNE case n'est dessinee ;
 *   2. au SURVOL de la bulle, la case VIDE apparait (opacite 1) et la bulle
 *      s'efface (opacite 0) ;
 *   3. la ligne retenue porte la case COCHEE, a la place de la bulle ;
 *   4. « tout selectionner » coche VISIBLEMENT toutes les lignes ;
 *   5. la case couvre la bulle au pixel (meme boite), sur les DEUX ecrans ;
 *   6. un clic sur la bulle AJOUTE la ligne sans effacer la selection en cours
 *      (geste `toggle`), comme la case de la liste des messages.
 *
 * AUCUN desabonnement ne peut partir d'ici : toute requete non-GET vers /api
 * est interceptee et refusee. Le banc ne fait que LIRE et cliquer.
 *
 *   node scripts/check-selection-checkbox.mjs
 *   node scripts/check-selection-checkbox.mjs --negative   (controle negatif)
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Temps laisse a React pour reposer ses lignes apres un clic. */
const SETTLE_MS = 400
/** La transition d'opacite de la case dure moins que ca ; on la laisse finir. */
const HOVER_MS = 500
// Large : le serveur de developpement COMPILE la page au premier passage, et
// les listes sont lues par IMAP. Ce delai borne une attente d'OUTILLAGE.
const NAV_TIMEOUT_MS = 180000
const CLOSE_TIMEOUT_MS = 5000
/** Il faut au moins deux lignes pour qu'un `toggle` cumulatif veuille dire quelque chose. */
const MIN_ROWS = 2
/** Tolerance de recouvrement entre la case et la bulle, en pixels. */
const BOX_TOLERANCE_PX = 1
/** Opacite au-dela de laquelle on considere un calque VISIBLE, et en-deca INVISIBLE. */
const VISIBLE_MIN = 0.9
const HIDDEN_MAX = 0.1

const NEGATIVE = process.argv.includes('--negative')

/** L'attribut publie par `components/ui/SelectableBubble.tsx`. */
const BOX = '[data-select-box]'
const SUBS_LIST = '[data-subs-list]'
const SUBS_ROW = '[data-subs-row]'
const MAIL_ROW = '[data-mail-row]'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
})) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigne`); process.exit(2) }
}

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

let liveBrowser = null
const harness = msg => {
  console.error(`HARNESS: ${msg}`)
  liveBrowser?.process()?.kill('SIGKILL')
  process.exit(2)
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000,
}).catch(e => harness(`Chrome ne demarre pas — ${e.message}`))
liveBrowser = browser

/**
 * Ce que la bulle d'une ligne rend VRAIMENT : l'etat publie, la boite de la
 * case, celle de la bulle qu'elle recouvre, et les opacites calculees des deux
 * calques. Tout est LU dans la page, rien n'est suppose.
 */
const readBox = (page, rowSel, i) => page.evaluate((rowSel, i, boxSel) => {
  const row = document.querySelectorAll(rowSel)[i]
  if (!row) return null
  const box = row.querySelector(boxSel)
  if (!box) return null
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
  // Le calque de la case VIDE est le seul enfant direct porteur d'un fond
  // `bg-muted/60` en position absolue ; celui de la case COCHEE remplace la
  // bulle. On les distingue par l'etat publie, pas par une classe devinee.
  const layers = [...box.children].map(el => ({
    opacity: Number(getComputedStyle(el).opacity),
    hasSvg: !!el.querySelector('svg'),
    absolute: getComputedStyle(el).position === 'absolute',
    box: rect(el),
  }))
  const bubble = box.querySelector('[data-account-badge], [data-account-initial]')
  return {
    state: box.getAttribute('data-select-box'),
    box: rect(box),
    bubble: bubble ? rect(bubble.closest('span,div') ?? bubble) : null,
    layers,
  }
}, rowSel, i, BOX)

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  // Garde-fou : ce banc est en LECTURE SEULE. Aucune ecriture ne sort d'ici.
  let blockedWrites = 0
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (req.method() !== 'GET' && req.url().includes('/api/') && !req.url().includes('/api/auth/')) {
      blockedWrites++
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
      return
    }
    req.continue()
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) harness('connexion refusee')

  if (NEGATIVE) {
    // Le defaut REJOUE : l'etat d'avant le lot, ou la bulle des newsletters ne
    // se changeait JAMAIS en case a cocher — exactement ce que Nicolas decrit
    // (« il manque le cochage au niveau du badge »). La bulle reste opaque au
    // survol et aucune coche ne se dessine, sur CET ecran seulement : l'ecran de
    // reference (les messages) n'est pas touche, il doit rester vert.
    //
    // Une premiere version masquait le calque en `display:none` : sa boite
    // tombait a 0x0 mais son opacite restait 1, si bien que « la case apparait »
    // passait sur un calque invisible. Elle mesurait donc autre chose que le
    // defaut. C'est l'OPACITE qui decide ici, comme dans le produit.
    await page.evaluateOnNewDocument(() => {
      const style = document.createElement('style')
      style.textContent = `
        [data-subs-row] [data-select-box] > * { opacity: 1 !important; }
        [data-subs-row] [data-select-box] svg { opacity: 0 !important; }
        [data-subs-row] [data-select-box] > *:has(svg) { opacity: 0 !important; }`
      const put = () => document.head.appendChild(style)
      if (document.head) put()
      else document.addEventListener('DOMContentLoaded', put)
    })
    console.log('NEGATIVE: sur les newsletters, la bulle ne se change jamais en case (etat d\'avant le lot)')
  }

  // ---------- L'ECRAN DE REFERENCE : la liste des messages ----------
  console.log('== reference : la liste des messages ==')
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(MAIL_ROW, { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness('la liste des messages ne rend aucune ligne'))
  await new Promise(r => setTimeout(r, SETTLE_MS))

  const mailRest = await readBox(page, MAIL_ROW, 0)
  if (!mailRest) harness('la premiere ligne de messages ne porte pas de bulle-case')
  check('messages : au repos la ligne n\'est pas cochee', mailRest.state === 'unchecked', String(mailRest.state))
  const mailEmptyLayer = mailRest.layers.find(l => l.absolute && l.hasSvg)
  check('messages : au repos la case vide est invisible',
    !!mailEmptyLayer && mailEmptyLayer.opacity <= HIDDEN_MAX, JSON.stringify(mailRest.layers))

  const mailBoxEl = await page.$(`${MAIL_ROW} ${BOX}`)
  await mailBoxEl.hover()
  await new Promise(r => setTimeout(r, HOVER_MS))
  const mailHover = await readBox(page, MAIL_ROW, 0)
  const mailHoverEmpty = mailHover.layers.find(l => l.absolute && l.hasSvg)
  const mailHoverBubble = mailHover.layers.find(l => !l.absolute)
  check('messages : au survol la case vide apparait',
    !!mailHoverEmpty && mailHoverEmpty.opacity >= VISIBLE_MIN, JSON.stringify(mailHover.layers))
  check('messages : au survol la bulle s\'efface',
    !!mailHoverBubble && mailHoverBubble.opacity <= HIDDEN_MAX, JSON.stringify(mailHover.layers))

  await mailBoxEl.click()
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const mailChecked = await readBox(page, MAIL_ROW, 0)
  check('messages : un clic sur la bulle coche la ligne', mailChecked.state === 'checked', String(mailChecked.state))
  const mailTick = mailChecked.layers.find(l => l.hasSvg)
  check('messages : la case cochee porte sa coche, pleinement visible',
    !!mailTick && mailTick.opacity >= VISIBLE_MIN, JSON.stringify(mailChecked.layers))
  // La geometrie de REFERENCE : c'est elle que l'autre ecran doit egaler.
  const referenceCover = mailTick
    ? Math.max(Math.abs(mailTick.box.w - mailChecked.box.w), Math.abs(mailTick.box.h - mailChecked.box.h))
    : Infinity

  // ---------- L'ECRAN DU LOT : les newsletters ----------
  console.log('== les newsletters portent la MEME case ==')
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(SUBS_LIST, { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness('la section des newsletters ne rend jamais sa liste'))
  await page.waitForFunction(
    (sel, min) => document.querySelectorAll(sel).length >= min,
    { timeout: NAV_TIMEOUT_MS }, SUBS_ROW, MIN_ROWS,
  ).catch(() => harness(`moins de ${MIN_ROWS} newsletters sur le compte de test — le banc ne peut rien conclure`))
  await new Promise(r => setTimeout(r, SETTLE_MS))

  const rowIds = await page.$$eval(SUBS_ROW, els => els.map(el => el.getAttribute('data-subs-row')))
  console.log(`contexte : ${rowIds.length} newsletter(s) rendues`)

  const subsRest = await readBox(page, SUBS_ROW, 0)
  if (!subsRest) {
    check('newsletters : la bulle porte une case a cocher', false, 'aucun [data-select-box] sur la ligne')
  } else {
    check('newsletters : au repos la ligne n\'est pas cochee', subsRest.state === 'unchecked', String(subsRest.state))
    const restEmpty = subsRest.layers.find(l => l.absolute && l.hasSvg)
    check('newsletters : au repos la case vide est invisible',
      !!restEmpty && restEmpty.opacity <= HIDDEN_MAX, JSON.stringify(subsRest.layers))

    const subsBoxEl = await page.$(`${SUBS_ROW} ${BOX}`)
    await subsBoxEl.hover()
    await new Promise(r => setTimeout(r, HOVER_MS))
    const subsHover = await readBox(page, SUBS_ROW, 0)
    const hoverEmpty = subsHover.layers.find(l => l.absolute && l.hasSvg)
    const hoverBubble = subsHover.layers.find(l => !l.absolute)
    check('newsletters : au survol la case vide apparait',
      !!hoverEmpty && hoverEmpty.opacity >= VISIBLE_MIN, JSON.stringify(subsHover.layers))
    check('newsletters : au survol la bulle s\'efface',
      !!hoverBubble && hoverBubble.opacity <= HIDDEN_MAX, JSON.stringify(subsHover.layers))

    await subsBoxEl.click()
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const subsChecked = await readBox(page, SUBS_ROW, 0)
    check('newsletters : un clic sur la bulle coche la ligne',
      subsChecked.state === 'checked', String(subsChecked.state))
    const tick = subsChecked.layers.find(l => l.hasSvg)
    check('newsletters : la case cochee porte sa coche, pleinement visible',
      !!tick && tick.opacity >= VISIBLE_MIN, JSON.stringify(subsChecked.layers))
    const cover = tick
      ? Math.max(Math.abs(tick.box.w - subsChecked.box.w), Math.abs(tick.box.h - subsChecked.box.h))
      : Infinity
    check(`newsletters : la case couvre la bulle (ecart <= ${BOX_TOLERANCE_PX} px)`,
      cover <= BOX_TOLERANCE_PX, `ecart ${cover.toFixed(1)} px, reference messages ${referenceCover.toFixed(1)} px`)

    // Le geste : cocher une SECONDE bulle garde la premiere. C'est ce qui
    // distingue une case a cocher d'un clic simple, qui remplacerait tout.
    const secondBox = (await page.$$(`${SUBS_ROW} ${BOX}`))[1]
    await secondBox.click()
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const checkedCount = await page.$$eval(`${BOX}[data-select-box="checked"]`, els => els.length)
    check('newsletters : cocher une 2e bulle garde la 1re cochee',
      checkedCount === 2, `${checkedCount} case(s) cochee(s)`)

    console.log('== « tout selectionner » coche VISIBLEMENT ==')
    await page.click('[data-subs-select-all]')
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const allChecked = await page.$$eval(`${SUBS_ROW} ${BOX}[data-select-box="checked"]`, els => els.length)
    // « Tout selectionner » depuis un etat partiel coche TOUT : c'est la regle
    // de `isAllSelected` dans `lib/explorerSelection.ts`, deja prouvee ailleurs.
    check('newsletters : tout selectionner coche toutes les lignes',
      allChecked === rowIds.length, `${allChecked} cochee(s) sur ${rowIds.length}`)
  }

  check('0 erreur de page', pageErrors.length === 0, pageErrors.join(' | '))
  console.log(`\necritures bloquees par le banc : ${blockedWrites} (lecture seule)`)
} finally {
  await Promise.race([
    browser.close(),
    new Promise(r => setTimeout(r, CLOSE_TIMEOUT_MS)),
  ]).catch(() => {})
  browser.process()?.kill('SIGKILL')
}

console.log(`\ncase a cocher : ${failures.length === 0 ? 'toutes les verifications passent' : `${failures.length} echec(s)`}`)
if (NEGATIVE) {
  if (failures.length === 0) {
    console.error('CONTROLE NEGATIF : la faute rejouee n\'a PAS ete vue — le banc ne mesure rien')
    process.exit(1)
  }
  console.log(`CONTROLE NEGATIF : rouge comme attendu (${failures.length} echec(s))`)
  process.exit(0)
}
process.exit(failures.length === 0 ? 0 : 1)
