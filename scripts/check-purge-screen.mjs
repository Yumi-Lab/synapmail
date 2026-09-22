#!/usr/bin/env node
/**
 * Lot H4f — la purge de l'historique d'une newsletter DEPUIS L'INTERFACE.
 *
 * Le banc SEME ses propres messages par APPEND dans un dossier de test, les
 * purge a la VRAIE SOURIS depuis le tableau de bord, verifie les temoins d'une
 * AUTRE newsletter, puis nettoie derriere lui. Modele :
 * `scripts/gate-purge.mjs` de la lane `promptguard`, qui mesure la meme API en
 * ligne de commande. Ici on mesure l'ECRAN, sur la MEME semence.
 *
 * Il ne touche JAMAIS un vrai message : tout ce qu'il deplace, il l'a cree.
 * Aucun `POST /api/subscriptions/purge` n'est intercepte — la purge mesuree est
 * la VRAIE, sur la semence. Seule la portee est deviee : le tableau de bord lit
 * `INBOX` par defaut, donc le banc reecrit le `folder` des deux routes de
 * lecture de la carte vers le dossier de test, et rien d'autre.
 *
 * Mesure, dans cet ordre :
 *   1. la newsletter semee apparait dans la carte, avec son nombre ;
 *   2. aucune poubelle par ligne : zero bouton de purge DANS les lignes ;
 *   3. un seul clic ne purge rien — le premier temps est un DENOMBREMENT AFFICHE ;
 *   4. le nombre affiche = N seme, et il nomme le nombre de dossiers ;
 *   5. la confirmation NOMME la corbeille ;
 *   6. ANNULER n'envoie rien : zero `POST /api/subscriptions/purge` observe ;
 *   7. confirmer deplace exactement N messages, les M temoins restent intacts,
 *      et les N sont RECUPERABLES dans la corbeille.
 *
 * Besoin : le serveur de la lane (SYNAPMAIL_TEST_URL + identifiants) ET les
 * secrets serveur (DATABASE_URL, ENCRYPTION_KEY) pour semer par IMAP.
 *   node scripts/check-purge-screen.mjs
 *   node scripts/check-purge-screen.mjs --cancel-only   (seulement le temps 6)
 */
import puppeteer from 'puppeteer-core'
import { openTestMailbox, harness as benchHarness } from './bench-imap.mjs'
import { installVisible, visibleBox, waitVisible } from './bench-visible.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Les quatre etats que la DoD demande : deux largeurs, deux themes. */
const WIDTHS = [1440, 390]
const THEMES = ['light', 'dark']
/** Temps laisse a React pour reposer la carte apres un clic. */
const SETTLE_MS = 400
/**
 * Le denombrement balaie TOUTE la boite : 20 s mesurees sur une boite reelle au
 * lot N (cf. GOAL.md, regle 3 de H4f). Cette borne est une attente d'OUTILLAGE,
 * pas un critere : le banc ne mesure pas une duree, il mesure ce qui s'affiche.
 */
const COUNT_TIMEOUT_MS = 180000
const NAV_TIMEOUT_MS = 180000
const CLOSE_TIMEOUT_MS = 5000

/** Le dossier que le banc cree, remplit, et supprime. Jamais un dossier reel. */
const TEST_FOLDER = 'Tests-gate-purge-ecran'
/** Combien de messages de la newsletter CIBLE, et combien de TEMOINS d'une autre. */
const SEEDED = 5
const WITNESSES = 2

const CANCEL_ONLY = process.argv.includes('--cancel-only')

const CARD = '[data-subs-list]'
const ROW = '[data-subs-row]'
const PURGE = '[data-subs-purge]'
const PANEL = '[data-subs-purge-panel]'
const COUNT = '[data-subs-purge-count]'
const CONFIRM = '[data-subs-purge-confirm]'
const CANCEL = '[data-subs-purge-cancel]'

const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
})) {
  if (!v) benchHarness(`${k} n'est pas renseigne`)
}

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

/**
 * Sortie d'OUTILLAGE : rien n'a ete mesure, donc RIEN n'est conclu du produit.
 * `process.exit` court-circuite le `finally`, donc Chrome est tue ICI, sinon
 * chaque passage interrompu laisse un navigateur sans tete derriere lui.
 */
let liveBrowser = null
const harness = msg => {
  console.error(`HARNESS: ${msg}`)
  liveBrowser?.process()?.kill('SIGKILL')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Semence : nos propres messages, dans NOTRE dossier.
// ---------------------------------------------------------------------------
const stamp = Date.now()
const TARGET_LIST = `h4f-cible-${stamp}.example.invalid`
const WITNESS_LIST = `h4f-temoin-${stamp}.example.invalid`

const { client, config, close } = await openTestMailbox()

/** Deux NOMS distincts : la ligne cible ne peut jamais etre confondue avec un temoin. */
const TARGET_NAME = `H4f cible ${stamp}`
const WITNESS_NAME = `H4f temoin ${stamp}`

/** Un message de newsletter minimal mais COMPLET : sans `List-Id`, rien ne groupe. */
const seedMessage = (listId, n) => Buffer.from(
  `From: ${listId === TARGET_LIST ? TARGET_NAME : WITNESS_NAME} <h4f-${listId.split('.')[0]}@example.invalid>\r\n`
  + `To: <${config.username}>\r\n`
  + `Subject: message de test H4f ${n}\r\n`
  + `Date: ${new Date(stamp - n * 86400000).toUTCString()}\r\n`
  + `List-Id: Gate H4f <${listId}>\r\n`
  + `List-Unsubscribe: <mailto:stop@example.invalid>\r\n`
  + `Message-ID: <h4f-${listId}-${n}>\r\n\r\ncorps de test\r\n`)

try { await client.mailboxCreate(TEST_FOLDER) } catch { /* deja la : on reutilise */ }
for (let i = 1; i <= SEEDED; i++) {
  await client.append(TEST_FOLDER, seedMessage(TARGET_LIST, i), ['\\Seen'])
}
for (let i = 1; i <= WITNESSES; i++) {
  await client.append(TEST_FOLDER, seedMessage(WITNESS_LIST, i), ['\\Seen'])
}
console.log(`semence : ${SEEDED} message(s) cible + ${WITNESSES} temoin(s) dans ${TEST_FOLDER}`)

/** Combien de messages d'une liste donnee un dossier porte. `null` = pas de dossier. */
const countIn = async (folder, listId) => {
  let lock
  try { lock = await client.getMailboxLock(folder) } catch { return null }
  try {
    return ((await client.search({ header: { 'list-id': listId } }, { uid: true })) || []).length
  } finally { lock.release() }
}

/** Ou la purge a pu poser les messages : on cherche le dossier qui les porte. */
const TRASH_CANDIDATES = ['Trash', 'INBOX.Trash', 'Corbeille', 'INBOX.Corbeille', '[Gmail]/Trash']
const findInTrash = async listId => {
  for (const name of TRASH_CANDIDATES) {
    const n = await countIn(name, listId)
    if (n) return { folder: name, count: n }
  }
  return { folder: null, count: 0 }
}

/** Menage : nos messages, partout ou ils ont pu finir, puis le dossier de test. */
const cleanup = async () => {
  for (const listId of [TARGET_LIST, WITNESS_LIST]) {
    for (const folder of [TEST_FOLDER, ...TRASH_CANDIDATES]) {
      let lock
      try { lock = await client.getMailboxLock(folder) } catch { continue }
      try {
        const uids = (await client.search({ header: { 'list-id': listId } }, { uid: true })) || []
        if (uids.length) await client.messageDelete(uids, { uid: true })
      } catch { /* dossier illisible : rien a retirer ici */ } finally { lock.release() }
    }
  }
  try { await client.mailboxDelete(TEST_FOLDER) } catch { /* deja parti */ }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000,
}).catch(e => harness(`Chrome ne demarre pas — ${e.message}`))
liveBrowser = browser

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  // Le garde-fou du lot H4h-bis : toute mesure passe par l'instance qu'un humain
  // REGARDE, et echoue bruyamment plutot que de mesurer une boite a 0 px.
  await installVisible(page)

  /**
   * On ne DEVIE que la PORTEE des deux lectures de la carte, du dossier par
   * defaut vers le dossier de test : la carte ne propose pas de choisir un
   * dossier, et semer dans la boite de reception reviendrait a melanger nos
   * messages au vrai courrier. La purge, elle, n'est jamais touchee : son
   * `folder` vient du listing, donc il suit.
   */
  let purgeCalls = 0
  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = new URL(req.url())
    const scoped = url.pathname === '/api/subscriptions'
      || url.pathname === '/api/subscriptions/history'
    if (req.method() === 'GET' && scoped) {
      url.searchParams.set('folder', TEST_FOLDER)
      req.continue({ url: url.toString() })
      return
    }
    if (req.method() === 'POST' && url.pathname === '/api/subscriptions/purge') purgeCalls++
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

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(CARD, { timeout: NAV_TIMEOUT_MS })
    .catch(() => harness("la carte des newsletters ne rend jamais sa liste"))
  await page.waitForFunction(
    sel => document.querySelectorAll(sel).length > 0,
    { timeout: NAV_TIMEOUT_MS }, ROW,
  ).catch(() => harness('la carte ne rend aucune ligne dans le dossier de test'))

  // Le nombre est lu sur l'ATTRIBUT que la ligne porte, pas dans son texte : le
  // nom d'une newsletter peut contenir des chiffres, et une expression sur le
  // texte les collerait au compteur — le banc mesurerait alors sa propre
  // semence au lieu du nombre que le produit affiche.
  const rows = await page.$$eval(ROW, els => els.map(el => ({
    id: el.getAttribute('data-subs-row'),
    count: Number(el.getAttribute('data-subs-count')),
    text: (el.textContent ?? '').trim(),
  })))
  console.log(`contexte : ${rows.length} ligne(s) rendues depuis ${TEST_FOLDER}`)

  console.log("== 1. la newsletter semee apparait, avec son nombre ==")
  // L'identifiant NE SE DEVINE PAS : il vient du listing rendu a l'ecran.
  const target = rows.find(r => r.text.includes(TARGET_NAME))
  if (!target) harness("la newsletter semee n'apparait pas dans la carte")
  const witnessRows = rows.filter(r => r.text.includes(WITNESS_NAME))
  if (!witnessRows.length) harness("la newsletter TEMOIN n'apparait pas : le banc ne pourrait pas prouver qu'elle survit")
  check('la newsletter semee est listee', !!target, target?.id)
  check(`son nombre affiche = les ${SEEDED} messages semes`,
    target.count === SEEDED, `affiche ${target.count}`)

  console.log('== 2. aucune poubelle sur chaque ligne ==')
  const inRow = await page.$$eval(ROW, (els, sel) =>
    els.reduce((n, el) => n + el.querySelectorAll(sel).length, 0), PURGE)
  check('zero bouton de purge DANS les lignes (la vue par defaut reste epuree)',
    inRow === 0, `trouves ${inRow}`)

  console.log('== 3. un seul clic ne purge rien : premier temps = denombrement ==')
  const rowHandles = await page.$$(ROW)
  const idx = rows.findIndex(r => r.id === target.id)
  await rowHandles[idx].click()
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const purgeBtn = await page.$(PURGE)
  if (!purgeBtn) harness("le bouton de purge n'existe pas a cote de « Se desabonner »")
  await purgeBtn.click()
  const beforeCount = purgeCalls
  await page.waitForSelector(COUNT, { timeout: COUNT_TIMEOUT_MS })
    .catch(() => harness('le denombrement ne s\'affiche jamais'))
  check('le premier clic n\'a envoye AUCUNE purge',
    purgeCalls === beforeCount && purgeCalls === 0, `purges observees : ${purgeCalls}`)

  console.log('== 4. le denombrement affiche dit N et combien de dossiers ==')
  const counted = await page.$eval(COUNT, el => (el.textContent ?? '').trim())
  console.log(`       denombrement affiche : ${counted}`)
  check(`le denombrement affiche les ${SEEDED} messages`,
    new RegExp(`\\b${SEEDED}\\b`).test(counted), counted)
  check('il nomme aussi le nombre de dossiers',
    (counted.match(/\d+/g) ?? []).length >= 2, counted)

  console.log('== 5. la confirmation nomme la CORBEILLE ==')
  const panelText = await page.$eval(PANEL, el => (el.textContent ?? '').trim())
  check('la confirmation dit ou partent les messages (corbeille / trash / 回收站)',
    /corbeille|trash|回收站/i.test(panelText), panelText.slice(0, 200))
  // Le nombre est cherche dans le LABEL DU BOUTON, pas dans tout le panneau :
  // celui-ci porte aussi le nom de la newsletter, qui peut contenir des chiffres.
  const goLabel = await page.$eval(CONFIRM, el => (el.textContent ?? '').trim())
  check('le bouton de confirmation REPREND le nombre denombre',
    new RegExp(`\\b${SEEDED}\\b`).test(goLabel), goLabel)

  console.log('== 6. annuler n\'envoie RIEN ==')
  await page.click(CANCEL)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const stillOpen = await page.$(PANEL)
  check('annuler ferme le panneau', stillOpen === null)
  check('annuler n\'a envoye aucune purge', purgeCalls === 0, `purges observees : ${purgeCalls}`)
  const afterCancel = await countIn(TEST_FOLDER, TARGET_LIST)
  check(`apres annulation, les ${SEEDED} messages sont TOUJOURS la`,
    afterCancel === SEEDED, `restants=${afterCancel}`)

  if (CANCEL_ONLY) {
    console.log('--cancel-only : la purge reelle n\'est pas jouee')
  } else {
    console.log('== 7. confirmer purge exactement N, et epargne les temoins ==')
    await (await page.$(PURGE)).click()
    await page.waitForSelector(CONFIRM, { timeout: COUNT_TIMEOUT_MS })
      .catch(() => harness('le second denombrement ne s\'affiche jamais'))
    await page.click(CONFIRM)
    await page.waitForSelector('[data-subs-purge-moved]', { timeout: COUNT_TIMEOUT_MS })
      .catch(async () => {
        const why = await page.$eval(PANEL, el => (el.textContent ?? '').trim()).catch(() => '(panneau parti)')
        harness(`la purge ne rend jamais son compte — panneau : ${why}`)
      })
    const moved = Number(await page.$eval('[data-subs-purge-moved]', el =>
      el.getAttribute('data-subs-purge-moved')))
    check(`l'ecran annonce ${SEEDED} messages deplaces`, moved === SEEDED, `moved=${moved}`)
    check('une seule purge a ete envoyee', purgeCalls === 1, `purges observees : ${purgeCalls}`)

    const leftTarget = await countIn(TEST_FOLDER, TARGET_LIST)
    check('le dossier de test ne porte plus la newsletter purgee',
      leftTarget === 0, `restants=${leftTarget}`)
    const leftWitness = await countIn(TEST_FOLDER, WITNESS_LIST)
    check(`les ${WITNESSES} temoins d'une AUTRE newsletter sont intacts`,
      leftWitness === WITNESSES, `restants=${leftWitness}`)
    check(`la carte garde les ${witnessRows.length} autre(s) ligne(s)`, witnessRows.length >= 1)

    const trash = await findInTrash(TARGET_LIST)
    check(`les ${SEEDED} messages sont RECUPERABLES dans la corbeille`,
      trash.count === SEEDED, `trouves ${trash.count} dans ${trash.folder ?? '(aucune corbeille)'}`)
  }

  console.log('== 8. le panneau des deux temps est ENTIEREMENT dessine, 4 etats ==')
  // Le denombrement est relance pour chaque etat, sur la ligne TEMOIN : apres le
  // temps 7 la cible n'a plus de message dans le dossier de test. La ligne est
  // visee par SON id, pas par `[data-subs-row]` : le selecteur generique
  // designe plusieurs lignes, et le helper de visibilite REFUSE (a juste titre)
  // de choisir a la place du banc.
  const WITNESS_ROW = `[data-subs-row="${witnessRows[0].id}"]`
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const where = `${String(width).padEnd(4)} px / ${theme.padEnd(5)}`
      await page.setViewport({ width, height: VIEWPORT.height })
      await page.evaluate(t => document.documentElement.classList.toggle('dark', t === 'dark'), theme)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.evaluate(t => document.documentElement.classList.toggle('dark', t === 'dark'), theme)
      await page.waitForFunction(
        sel => document.querySelectorAll(sel).length > 0,
        { timeout: NAV_TIMEOUT_MS }, WITNESS_ROW,
      ).catch(() => harness(`${where} : la ligne temoin n'est pas rendue`))

      // La carte vit bas dans une colonne qui defile : sans l'amener a l'ecran,
      // sa boite dessinee est nulle et le helper de visibilite REFUSE de la
      // mesurer — a juste titre, un element hors du cadre n'est pas regarde.
      const bring = async sel => {
        await page.$eval(sel, el => el.scrollIntoView({ block: 'center' }))
        await new Promise(r => setTimeout(r, SETTLE_MS))
      }
      await bring(WITNESS_ROW)

      // Clic a la VRAIE souris, au centre de l'instance VISIBLE : a 390 px le
      // tableau de bord n'a pas la meme mise en page, et un `elem.click()` de
      // Puppeteer passerait outre un element recouvert.
      const rowBox = await visibleBox(page, WITNESS_ROW).catch(e => harness(`${where} : ${e.message}`))
      await page.mouse.click(rowBox.x, rowBox.y)
      await new Promise(r => setTimeout(r, SETTLE_MS))
      await bring(PURGE)
      const btn = await visibleBox(page, PURGE).catch(e => harness(`${where} : ${e.message}`))
      await page.mouse.click(btn.x, btn.y)
      await waitVisible(page, COUNT, { timeout: COUNT_TIMEOUT_MS })
        .catch(() => harness(`${where} : le denombrement ne s'affiche jamais`))

      // Une boite DESSINEE non nulle = le panneau n'est ni rogne par une cage
      // `overflow-hidden` ni replie : c'est exactement le piege du lot H4h-bis.
      await bring(PANEL)
      const panel = await visibleBox(page, PANEL).catch(e => harness(`${where} : ${e.message}`))
      const confirm = await visibleBox(page, CONFIRM).catch(e => harness(`${where} : ${e.message}`))
      check(`${where} — le panneau est dessine en entier`,
        panel.width > 0 && panel.height > 0, JSON.stringify(panel))
      check(`${where} — le bouton de confirmation est atteignable a la souris`,
        confirm.width > 0 && confirm.height > 0 && confirm.left >= panel.left - 1
          && confirm.right <= panel.right + 1,
        `bouton ${JSON.stringify(confirm)} dans ${JSON.stringify(panel)}`)

      // On ANNULE : aucun de ces quatre passages ne doit deplacer un message.
      const cancelBox = await visibleBox(page, CANCEL).catch(e => harness(`${where} : ${e.message}`))
      await page.mouse.click(cancelBox.x, cancelBox.y)
      await new Promise(r => setTimeout(r, SETTLE_MS))
    }
  }
  check(`les 4 etats n'ont envoye aucune purge de plus`,
    purgeCalls === (CANCEL_ONLY ? 0 : 1), `purges observees : ${purgeCalls}`)

  check('aucune erreur levee par la page', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await cleanup()
  await close()
  const closed = browser.close()
  await Promise.race([closed, new Promise(r => setTimeout(r, CLOSE_TIMEOUT_MS))])
  browser.process()?.kill('SIGKILL')
  console.log(`menage : messages de test retires, ${TEST_FOLDER} supprime`)
}

if (failures.length) {
  console.error(`\ncheck-purge-screen: ${failures.length} echec(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('\ncheck-purge-screen: tout est vert')
