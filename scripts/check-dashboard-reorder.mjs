#!/usr/bin/env node
/**
 * Lot H4e — les cartes du tableau de bord se rangent A LA SOURIS.
 *
 * Le banc pilote une VRAIE souris (mousedown / mousemove / mouseup sur la
 * poignee, plus les evenements de glisser-deposer que le navigateur n'emet pas
 * tout seul depuis puppeteer), puis RECHARGE la page pour verifier que l'ordre
 * a bien ete enregistre COTE SERVEUR — c'est le seul point qui distingue ce lot
 * d'un reordonnancement qui ne survit pas a un F5.
 *
 * Il mesure, dans cet ordre :
 *   1. les neuf cartes sont rendues, dans l'ordre d'origine (etat de depart) ;
 *   2. chaque carte porte une poignee, et une seule ;
 *   3. un glisser a la vraie souris CHANGE le rang de la carte deplacee ;
 *   4. l'ordre SURVIT a un rechargement complet (donc il est cote serveur) ;
 *   5. le bouton « Remettre l'ordre d'origine » n'apparait QUE quand l'ordre a
 *      change, et le rend exactement a son etat d'origine ;
 *   6. au CLAVIER, une fleche deplace la carte qui a le focus ;
 *   7. a 390 px, les neuf cartes restent dessinees ENTIERES (aucune rognee).
 *
 * L'ordre lu est toujours celui du DOM (`data-dashboard-card`), jamais celui
 * qu'on croit avoir envoye : ce que le banc mesure est ce que l'ecran montre.
 *
 * Le banc REMET l'ordre d'origine en partant, quoi qu'il arrive : il ne laisse
 * pas le tableau de bord range autrement qu'il ne l'a trouve.
 *
 * Besoin : le serveur de la lane (SYNAPMAIL_TEST_URL + identifiants).
 *   node scripts/check-dashboard-reorder.mjs
 */
import puppeteer from 'puppeteer-core'
import { harness } from './bench-imap.mjs'
import { installVisible, visibleBox } from './bench-visible.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDE = { width: 1440, height: 1000 }
/** La largeur etroite que la DoD demande pour ce lot. */
const NARROW_WIDTH = 390
const NAV_TIMEOUT_MS = 120000
/** Temps laisse a React pour reposer la grille apres un depot. */
const SETTLE_MS = 500

const CARD = '[data-dashboard-card]'
const HANDLE = `${CARD} button[aria-label]`
const RESET = '[data-dashboard-order-reset]'

const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
})) {
  if (!v) harness(`${k} n'est pas renseigne`)
}

const failures = []
const check = (label, pass, detail = '') => {
  if (!pass) failures.push(label)
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Attend que la grille soit rendue. Le helper anti-fantome du lot H4h-bis ne
 * sert PAS ici pour attendre : neuf cartes portent le meme selecteur, et il
 * refuse — a raison — de choisir entre plusieurs instances. On attend donc le
 * COMPTE attendu, puis on mesure chaque carte par son identite, qui elle est
 * unique (`[data-dashboard-card="focus"]`) : c'est la que le helper reprend.
 */
const waitCards = (page, timeout = NAV_TIMEOUT_MS) => page.waitForFunction(
  sel => document.querySelectorAll(sel).length >= 9,
  { timeout, polling: 150 }, CARD,
)

/** L'ordre REELLEMENT dessine, lu dans le DOM. */
const readOrder = page => page.$$eval(CARD, els => els.map(el => el.getAttribute('data-dashboard-card')))

/**
 * Un depot a la VRAIE souris : on presse la poignee de `moved`, on traverse
 * jusqu'au centre de `target`, on relache. Puppeteer ne synthetise pas les
 * evenements HTML5 de glisser-deposer derriere une souris reelle : on les emet
 * donc explicitement sur les memes elements, APRES un vrai mousedown — c'est
 * ce mousedown qui arme la carte cote produit.
 */
async function dragCard(page, moved, target) {
  await page.$eval(`[data-dashboard-card="${moved}"] button[aria-label]`, el => el.scrollIntoView({ block: 'center' }))
  const handle = await visibleBox(page, `[data-dashboard-card="${moved}"] button[aria-label]`)
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.$eval(`[data-dashboard-card="${target}"]`, el => el.scrollIntoView({ block: 'center' }))
  const dest = await visibleBox(page, `[data-dashboard-card="${target}"]`)
  await page.mouse.move(dest.x, dest.y, { steps: 12 })
  await page.evaluate((from, to) => {
    const src = document.querySelector(`[data-dashboard-card="${from}"]`)
    const dst = document.querySelector(`[data-dashboard-card="${to}"]`)
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  }, moved, target)
  await page.mouse.up()
  await sleep(SETTLE_MS)
}

/** Remet l'ordre d'origine par la route, sans passer par l'ecran. */
const resetServerOrder = page => page.evaluate(() =>
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dashboard_card_order: null }),
  }).then(r => r.ok))

let browser
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: WIDE })
  const page = await browser.newPage()
  await installVisible(page)

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

  // Etat de depart connu : l'ordre d'origine, quoi qu'ait laisse une execution precedente.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await waitCards(page).catch(() => harness('le tableau de bord ne rend pas ses neuf cartes'))
  if (!await resetServerOrder(page)) harness("impossible de remettre l'ordre d'origine avant de mesurer")
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitCards(page)

  const origin = await readOrder(page)
  console.log(`contexte : ${origin.length} carte(s) — ${origin.join(' > ')}\n`)

  console.log('== 1. les cartes sont rendues, dans un ordre lisible ==')
  check('neuf cartes rendues', origin.length === 9, `${origin.length}`)
  check('aucune identite en double', new Set(origin).size === origin.length)
  check('aucune carte anonyme', origin.every(Boolean))

  console.log('\n== 2. chaque carte porte UNE poignee ==')
  const handles = await page.$$eval(HANDLE, els => els.length)
  check('autant de poignees que de cartes', handles === origin.length, `${handles} poignee(s)`)
  const labelled = await page.$$eval(HANDLE, els =>
    els.every(el => (el.getAttribute('aria-label') ?? '').trim().length > 0))
  check('chaque poignee est nommee (aria-label)', labelled)

  console.log('\n== 3. un glisser a la VRAIE souris change le rang ==')
  const moved = origin[origin.length - 1]   // la derniere carte…
  const target = origin[0]                   // …deposee sur la premiere
  await dragCard(page, moved, target)
  const afterDrag = await readOrder(page)
  check('la carte deplacee a change de rang',
    afterDrag.indexOf(moved) !== origin.indexOf(moved),
    `${origin.indexOf(moved)} -> ${afterDrag.indexOf(moved)}`)
  check('elle est passee AVANT sa cible', afterDrag.indexOf(moved) < afterDrag.indexOf(target),
    afterDrag.join(' > '))
  check('aucune carte perdue par le deplacement',
    [...afterDrag].sort().join() === [...origin].sort().join(), `${afterDrag.length} carte(s)`)

  console.log('\n== 4. l ordre SURVIT a un rechargement (donc il est cote serveur) ==')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitCards(page)
  const afterReload = await readOrder(page)
  check('le meme ordre revient apres F5',
    afterReload.join() === afterDrag.join(), afterReload.join(' > '))
  const stored = await page.evaluate(() =>
    fetch('/api/settings').then(r => r.json()).then(j => j.data?.dashboard_card_order))
  check("l ordre est bien enregistre cote serveur (pas dans le navigateur)",
    Array.isArray(stored) && stored.join() === afterReload.join(),
    Array.isArray(stored) ? `${stored.length} identite(s) en base` : String(stored))

  console.log('\n== 5. remettre l ordre d origine ==')
  const resetShown = await page.$(RESET)
  check("le bouton de remise a zero apparait quand l ordre a change", !!resetShown)
  if (resetShown) {
    const box = await visibleBox(page, RESET)
    await page.mouse.click(box.x, box.y)
    await sleep(SETTLE_MS)
  }
  const afterReset = await readOrder(page)
  check("l ordre d origine est rendu exactement", afterReset.join() === origin.join(), afterReset.join(' > '))
  check("et le bouton disparait, l ordre etant redevenu celui d origine", !await page.$(RESET))

  console.log('\n== 6. au CLAVIER, une fleche deplace la carte ==')
  const kbCard = origin[0]
  await page.focus(`[data-dashboard-card="${kbCard}"] button[aria-label]`)
  await page.keyboard.press('ArrowDown')
  await sleep(SETTLE_MS)
  const afterKey = await readOrder(page)
  check('la carte a avance d un rang', afterKey.indexOf(kbCard) === origin.indexOf(kbCard) + 1,
    `${origin.indexOf(kbCard)} -> ${afterKey.indexOf(kbCard)}`)
  check('aucune carte perdue au clavier',
    [...afterKey].sort().join() === [...origin].sort().join())

  console.log(`\n== 7. a ${NARROW_WIDTH} px, les cartes restent dessinees ENTIERES ==`)
  await page.setViewport({ width: NARROW_WIDTH, height: 900 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitCards(page)
  const narrow = await page.evaluate((sel, width) => {
    const out = []
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      out.push({
        id: el.getAttribute('data-dashboard-card'),
        left: Math.round(r.left), right: Math.round(r.right),
        width: Math.round(r.width), overflows: r.right > width + 1 || r.left < -1,
      })
    }
    return out
  }, CARD, NARROW_WIDTH)
  check(`les ${narrow.length} cartes sont rendues a ${NARROW_WIDTH} px`, narrow.length === origin.length)
  const spilled = narrow.filter(c => c.overflows)
  check('aucune carte ne deborde de la fenetre', spilled.length === 0,
    spilled.map(c => `${c.id} [${c.left};${c.right}]`).join(', ') || `largeurs ${narrow.map(c => c.width).join('/')}`)
  const narrowHandles = await page.$$eval(HANDLE, els => els.length)
  check('les poignees restent atteignables', narrowHandles === origin.length, `${narrowHandles}`)

  // On repart comme on est arrive.
  await resetServerOrder(page)
} catch (err) {
  harness(`le banc n'a pas pu mesurer : ${err.message}`)
} finally {
  await browser?.close().catch(() => {})
}

console.log(`\nrangement du tableau de bord : ${failures.length === 0 ? 'toutes les verifications passent' : `${failures.length} echec(s)`}`)
process.exit(failures.length === 0 ? 0 : 1)
