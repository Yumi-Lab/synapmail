#!/usr/bin/env node
/**
 * Mesure la section « Lettres d'information » du tableau de bord, a la VRAIE
 * souris, sur l'application qui tourne.
 *
 * AUCUN desabonnement reel n'est jamais declenche : toute requete
 * `POST /api/subscriptions/unsubscribe` est INTERCEPTEE et se voit repondre un
 * rapport fabrique (done / manual / failed), pour que les trois rendus soient
 * mesurables sans quitter une seule liste. La LISTE, elle, vient de l'API
 * reelle en lecture seule.
 *
 * Mesure : le compteur en tete = le nombre de lignes rendues ; le clic simple,
 * le Cmd-clic et le Maj-clic a la vraie souris ; la confirmation qui NOMME
 * combien de lettres partent ; le rendu des trois resultats ; le refus au-dela
 * de MAX_UNSUBSCRIBE_BATCH ; et la bulle de boite identique a celle de la barre
 * laterale (meme couleur de fond, memes initiales).
 *
 * Besoin : un serveur de developpement de la lane et les identifiants
 * SYNAPMAIL_TEST_* (.env).
 *   node scripts/check-subscriptions-screen.mjs
 *   node scripts/check-subscriptions-screen.mjs --negative   (controle negatif)
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { MAX_UNSUBSCRIBE_BATCH } from '../lib/subscriptionsContract.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Temps laisse a React pour reposer ses lignes apres un clic. */
const SETTLE_MS = 400
// Large : le serveur de developpement COMPILE la page au premier passage, et la
// liste est lue par IMAP. Ce delai borne une attente d'OUTILLAGE, pas une mesure.
const NAV_TIMEOUT_MS = 180000
/** Delai laisse a Chrome pour se fermer proprement avant d'etre tue. */
const CLOSE_TIMEOUT_MS = 5000
/** Il faut au moins trois lignes pour qu'une plage au Maj-clic veuille dire quelque chose. */
const MIN_ROWS = 3

const NEGATIVE = process.argv.includes('--negative')

const CARD = '[data-subs-list]'
const ROW = '[data-subs-row]'
const SELECTED = '[data-subs-selected="true"]'
const UNSUB = '[data-subs-unsubscribe]'
const TOO_MANY = '[data-subs-too-many]'
const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'

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

/**
 * Sortie d'OUTILLAGE : le banc n'a rien pu mesurer, il ne conclut RIEN sur le
 * produit. `process.exit` court-circuite le `finally`, donc Chrome est tue ICI,
 * sinon chaque passage interrompu laisse un navigateur sans tete derriere lui.
 */
let liveBrowser = null
const harness = msg => {
  console.error(`HARNESS: ${msg}`)
  liveBrowser?.process()?.kill('SIGKILL')
  process.exit(2)
}

/** Les rapports que l'interception renvoie : un de chaque forme rendue a l'ecran. */
const FAKE_OUTCOMES = ['done', 'manual', 'failed']
/**
 * Compteur GLOBAL, pas l'index dans un appel : les ids visees peuvent arriver
 * en plusieurs requetes (une par boite), et un index remis a zero a chaque
 * requete ne servait que `done` quand chaque appel ne portait qu'une id — le
 * banc declarait alors « failed » manquant alors que le produit n'avait jamais
 * eu a le rendre.
 */
let served = 0
const fakeReport = id => {
  const outcome = FAKE_OUTCOMES[served++ % FAKE_OUTCOMES.length]
  if (outcome === 'manual') return { id, outcome, method: 'link', url: 'https://example.org/leave' }
  if (outcome === 'failed') return { id, outcome, method: 'one-click', reason: 'timeout' }
  return { id, outcome, method: 'one-click' }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000,
}).catch(e => harness(`Chrome ne demarre pas — ${e.message}`))
liveBrowser = browser

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  // Pose AVANT toute navigation : branche a la fin, l'ecouteur ne pouvait plus
  // voir une erreur levee au rendu, et son « 0 erreur » ne mesurait rien.
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  // Le garde-fou du banc : plus AUCUN desabonnement reel ne peut sortir d'ici.
  let interceptedCalls = 0
  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    if (req.method() === 'POST' && url.includes('/api/subscriptions/unsubscribe')) {
      interceptedCalls++
      let ids = []
      try { ids = JSON.parse(req.postData() ?? '{}').ids ?? [] } catch { ids = [] }
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: ids.map(id => fakeReport(id)) }),
      })
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

  // La bulle de REFERENCE : celle de la barre laterale, lue avant le tableau de bord.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(SIDEBAR_ACCOUNT, { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness('la barre laterale ne rend aucune boite'))
  const sidebarBubbles = await page.evaluate(() =>
    [...document.querySelectorAll('[data-account-badge]')].map(el => ({
      id: el.getAttribute('data-account-badge'),
      bg: getComputedStyle(el).backgroundColor,
      text: (el.textContent ?? '').trim(),
    })))
  if (!sidebarBubbles.length) harness('aucune bulle de boite dans la barre laterale')

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(CARD, { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness('la section des lettres d\'information ne rend jamais sa liste'))
  // La liste vient d'IMAP : elle peut arriver apres la carte.
  await page.waitForFunction(
    (sel, min) => document.querySelectorAll(sel).length >= min,
    { timeout: NAV_TIMEOUT_MS }, ROW, MIN_ROWS,
  ).catch(() => harness(`moins de ${MIN_ROWS} lettres d'information sur le compte de test — le banc ne peut rien conclure`))

  const rowIds = await page.$$eval(ROW, els => els.map(el => el.getAttribute('data-subs-row')))
  console.log(`contexte : ${rowIds.length} lettre(s) d'information rendues, ${sidebarBubbles.length} bulle(s) en barre laterale`)

  console.log('== le compteur dit ce que la liste montre ==')
  const headline = await page.$eval(CARD, el => {
    const card = el.closest('section')
    return (card?.querySelector('h2')?.textContent ?? '').trim()
  })
  const announced = Number((headline.match(/(\d+)/) ?? [])[1])
  check('le nombre annonce en tete = le nombre de lignes',
    announced === rowIds.length, `annonce ${announced}, rendu ${rowIds.length}`)

  console.log('== selection a la vraie souris ==')
  const rowHandles = await page.$$(ROW)
  const clickRow = async (i, keys = []) => {
    for (const k of keys) await page.keyboard.down(k)
    await rowHandles[i].click()
    for (const k of keys) await page.keyboard.up(k)
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }
  const selectedIds = () => page.$$eval(SELECTED, els => els.map(el => el.getAttribute('data-subs-row')))

  await clickRow(0)
  check('un clic simple ne garde que sa ligne',
    JSON.stringify(await selectedIds()) === JSON.stringify([rowIds[0]]), JSON.stringify(await selectedIds()))

  await clickRow(2, ['Meta'])
  const afterMeta = await selectedIds()
  check('Cmd-clic ajoute la ligne visee, sans perdre la premiere',
    afterMeta.length === 2 && afterMeta.includes(rowIds[0]) && afterMeta.includes(rowIds[2]), JSON.stringify(afterMeta))

  await clickRow(0)
  await clickRow(2, ['Shift'])
  const afterShift = await selectedIds()
  check('Maj-clic prend la plage entiere, bornes comprises',
    JSON.stringify(afterShift) === JSON.stringify(rowIds.slice(0, 3)), JSON.stringify(afterShift))

  console.log('== la confirmation NOMME ce qui part ==')
  let confirmText = null
  page.on('dialog', async dialog => {
    confirmText = dialog.message()
    // Le PREMIER passage refuse : rien ne doit partir tant qu'on mesure le libelle.
    await dialog.dismiss()
  })
  await page.click(UNSUB)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check('une confirmation est demandee avant tout depart', confirmText !== null)
  check('elle nomme le nombre de lettres visees',
    !!confirmText && confirmText.includes('3'), String(confirmText))
  check('refuser la confirmation n\'envoie RIEN',
    interceptedCalls === 0, `${interceptedCalls} appel(s) partis`)

  console.log('== les trois resultats se rendent ==')
  page.removeAllListeners('dialog')
  page.on('dialog', dialog => dialog.accept())
  await page.click(UNSUB)
  await page.waitForSelector('[data-subs-report]', { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness('aucun resultat rendu apres un depart accepte'))
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const outcomes = await page.$$eval('[data-subs-report]', els =>
    els.map(el => ({ outcome: el.getAttribute('data-subs-report'), text: (el.textContent ?? '').trim() })))
  check('accepter envoie exactement un appel par boite visee', interceptedCalls >= 1, `${interceptedCalls}`)
  for (const want of FAKE_OUTCOMES) {
    check(`le resultat « ${want} » est rendu a sa ligne`, outcomes.some(o => o.outcome === want),
      JSON.stringify(outcomes.map(o => o.outcome)))
  }
  const manual = outcomes.find(o => o.outcome === 'manual')
  check('une sortie manuelle MONTRE son lien, sans l\'ouvrir',
    !!manual && manual.text.includes('https://example.org/leave'), String(manual?.text))
  // Chrome garde son onglet `about:blank` de demarrage : ce qu'on compte, ce sont
  // les pages qui ont VRAIMENT navigue quelque part.
  const realTabs = (await browser.pages()).map(p => p.url()).filter(u => u !== 'about:blank')
  check('aucune fenetre ne s\'est ouverte toute seule',
    realTabs.length === 1, realTabs.join(' | '))

  console.log('== le refus au-dela du plafond ==')
  // « Tout selectionner » ne depasse le plafond que si la boite en porte assez :
  // sinon le refus n'est pas observable, et le banc le DIT plutot que de le taire.
  const tooManyObservable = rowIds.length > MAX_UNSUBSCRIBE_BATCH
  if (!tooManyObservable) {
    console.log(`  --   refus au-dela de ${MAX_UNSUBSCRIBE_BATCH} NON mesure : ${rowIds.length} lettre(s) seulement`)
  } else {
    const before = interceptedCalls
    await page.click('[data-subs-select-all]')
    await new Promise(r => setTimeout(r, SETTLE_MS))
    await page.waitForSelector(TOO_MANY, { timeout: NAV_TIMEOUT_MS })
      .catch(() => check(`au-dela de ${MAX_UNSUBSCRIBE_BATCH} la phrase de refus s'affiche`, false))
    check('le bouton refuse de partir au-dela du plafond', interceptedCalls === before)
  }

  console.log('== la bulle est CELLE de la barre laterale ==')
  // Depuis le lot H4d, une ligne RETENUE remplace sa bulle par la case a cocher
  // (le meme selecteur que la liste des messages) : il n'y a donc plus de bulle
  // a comparer tant que la selection tient. On la relache AVANT de lire les
  // couleurs. Sans ce relachement, le banc concluait « aucune bulle » sur un
  // ecran qui se comportait exactement comme demande — une faute de BANC.
  const stillSelected = await page.$$(SELECTED)
  if (stillSelected.length) {
    await page.click('[data-subs-select-all]')
    await new Promise(r => setTimeout(r, SETTLE_MS))
  }
  const dashBubbles = await page.$$eval(`${CARD} [data-account-badge]`, els =>
    els.map(el => ({
      id: el.getAttribute('data-account-badge'),
      bg: getComputedStyle(el).backgroundColor,
      text: (el.textContent ?? '').trim(),
    })))
  if (!dashBubbles.length) harness('aucune bulle de boite sur les lignes d\'abonnement')
  const byId = new Map(sidebarBubbles.map(b => [b.id, b]))
  let compared = 0
  for (const b of dashBubbles) {
    const ref = byId.get(b.id)
    if (!ref) continue
    compared++
    const same = NEGATIVE
      // Le defaut rejoue : une teinte decidee sur place au lieu de la bulle partagee.
      ? b.bg === 'rgb(99, 102, 241)'
      : b.bg === ref.bg && b.text === ref.text
    check(`bulle ${b.id.slice(0, 8)} identique des deux cotes`, same,
      `barre laterale ${ref.bg} « ${ref.text} », abonnements ${b.bg} « ${b.text} »`)
  }
  if (!compared) harness('aucune bulle comparable entre les deux ecrans')

  check('0 erreur de page', pageErrors.length === 0, pageErrors.join(' | '))
  console.log(`\ndesabonnements REELS declenches : 0 (${interceptedCalls} appel(s) intercepte(s))`)
} finally {
  await Promise.race([
    browser.close(),
    new Promise(r => setTimeout(r, CLOSE_TIMEOUT_MS)),
  ]).catch(() => {})
  browser.process()?.kill('SIGKILL')
}

console.log(`\nabonnements a l'ecran : ${failures.length === 0 ? 'toutes les verifications passent' : `${failures.length} echec(s)`}`)
if (NEGATIVE) {
  if (failures.length === 0) {
    console.error('CONTROLE NEGATIF : la faute rejouee n\'a PAS ete vue — le banc ne mesure rien')
    process.exit(1)
  }
  console.log(`CONTROLE NEGATIF : rouge comme attendu (${failures.length} echec(s))`)
  process.exit(0)
}
process.exit(failures.length === 0 ? 0 : 1)
