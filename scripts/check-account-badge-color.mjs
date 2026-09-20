#!/usr/bin/env node
/**
 * Mesure l'OBJET du lot H4c : le compteur de non-lus porte la couleur de SA boite,
 * il reste VISIBLE quand sa ligne est active, son nombre est centre, et il n'est
 * jamais rogne par le bord de la barre laterale.
 *
 * Pourquoi un banc de plus : `check-account-badge-parity.mjs` compare la couleur d'une
 * meme BULLE d'un ecran a l'autre. Il ne regarde pas le COMPTEUR, qui se peignait avec
 * `ACCENT.solid` — l'accent du compte ACTIF — donc les huit compteurs sortaient de la
 * meme couleur pendant que les bulles etaient vertes, bleues, ambrees. Un banc qui ne
 * lit pas l'element defaillant ne peut pas voir le defaut.
 *
 * Ce qui est EXIGE, pour chaque bulle portant un compteur, sur chaque ecran :
 *   1. couleur de fond du compteur == couleur de fond de SA bulle (meme source)
 *   2. le compteur est effectivement a l'ecran et rien ne le recouvre
 *      (`elementFromPoint` a son centre le renvoie, lui ou un de ses enfants)
 *   3. le centre de l'ENCRE du nombre est a moins de CENTER_TOL_PX du centre du
 *      compteur, sur les DEUX axes ; idem pour les initiales dans la bulle
 *   4. le compteur tient entierement dans la boite de la barre laterale (aucun rognage)
 *
 * L'encre n'est PAS le rectangle de l'element : un rectangle d'element est la boite de
 * ligne, qui reserve de la place sous la ligne de base pour des jambages que « 99+ »
 * n'a pas. On la calcule donc avec les metriques de fonte (`TextMetrics`), sinon on
 * mesure une boite vide plutot que le chiffre que l'oeil voit.
 *
 * Lecture seule : aucune requete non-GET vers l'application, aucune couleur ecrite.
 *
 * Controle negatif OBLIGATOIRE :
 *   node scripts/check-account-badge-color.mjs --negative
 * repeint les compteurs avec l'accent du compte actif, comme avant le correctif. Le
 * banc DOIT alors echouer.
 *
 * Exige un serveur qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Le temps laisse a React pour reposer ses styles apres une navigation. */
const SETTLE_MS = 700
/** Large : le serveur de developpement COMPILE la page au premier passage. */
const NAV_TIMEOUT_MS = 120000
const CLOSE_TIMEOUT_MS = 5000
/**
 * Tolerance de centrage, en pixels a l'ecran. 1 px est ce que l'enonce demande ; on ne
 * descend pas plus bas parce que la position d'une encre depend de l'arrondi sous-pixel
 * du moteur de rendu, qui varie d'un ecran a l'autre sans que rien ne bouge a l'oeil.
 * Calibre sur ce banc, Chrome/macOS, viewport 1440x900, zoom 1.
 */
const CENTER_TOL_PX = 1
/**
 * Plancher de couverture : en dessous, le banc n'a pas eprouve assez de compteurs pour
 * conclure et annonce HARNESS plutot qu'un vert. Deux ecrans au moins doivent porter un
 * compteur — c'est ce que l'enonce demande de comparer. Calibre sur le compte de test de
 * ce banc, qui voit 8 boites ; un compte a une seule boite sans non-lu ne peut pas
 * eprouver ce lot, et le banc doit le DIRE au lieu de passer.
 */
const MIN_COUNTERS = 2
/**
 * La taille de bulle qui marque une boite DANS DU TEXTE COURANT (une ligne de message du
 * tableau de bord) : elle dit de quelle boite vient ce message-la, un compteur de non-lus
 * n'y voudrait rien dire. Les bulles de LISTE (`sm`, `md`) le portent, elles.
 */
const INLINE_SIZE = 'xs'
/** Essais de saisie dans la palette avant d'annoncer une panne de banc. */
const TYPE_ATTEMPTS = 4
/** Ce qu'on laisse au champ apres une saisie : son debounce, plus la marge de rendu. */
const TYPE_SETTLE_MS = 900

const NEGATIVE = process.argv.includes('--negative')
/**
 * Second controle negatif, pour le critere AJOUTE par le lot H4c-bis (« une boite qui a
 * des non-lus porte son compteur ») : il rejoue l'etat d'AVANT, ou Reglages -> Comptes et
 * la palette peignaient la bulle sans jamais nourrir le compteur. Sans lui, ce critere
 * pourrait etre vert sans rien mesurer — le premier controle negatif ne repeint que la
 * COULEUR des compteurs deja presents, il ne les fait pas disparaitre.
 */
const NEGATIVE_MISSING = process.argv.includes('--negative-missing')

const BUBBLE = '[data-account-badge]'
const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const DASHBOARD_TRIGGER = '[data-dashboard-account-trigger]'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
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

/**
 * Combien de compteurs le banc a effectivement eprouves, tous ecrans confondus. Sans ce
 * total, ecarter les bulles repliees pourrait tout ecarter : le banc sortirait vert sans
 * avoir rien mesure. Declare ICI, hors du `try`, parce que le verdict se rend APRES le
 * `finally` qui ferme le navigateur. Compare a MIN_COUNTERS a la fin.
 */
let assertedCounters = 0

/**
 * Non-lus par boite, tels que l'API les rend DANS CE PASSAGE. C'est la reference du
 * critere « cette boite doit porter un compteur » : jamais une constante ecrite a la
 * main, qui ne mesurerait plus rien le jour ou la boite de test change.
 */
const UNREAD_BY_ID = new Map()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 })
  .catch(e => harness(`Chrome ne demarre pas — ${e.message}`))
liveBrowser = browser

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)

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

  if (NEGATIVE_MISSING) {
    // L'etat d'AVANT H4c-bis : sur ces deux ecrans la bulle est peinte, le compteur
    // n'est jamais nourri. On retire donc le compteur des bulles qui ne sont NI dans la
    // barre laterale NI dans le tableau de bord — exactement les deux ecrans du lot.
    await page.evaluateOnNewDocument(() => {
      setInterval(() => {
        for (const b of document.querySelectorAll('[data-unread-badge]')) {
          if (b.closest('[data-sidebar]') || b.closest('[data-dashboard-account-trigger]')) continue
          if (b.closest('[data-omnibar-panel]') || b.closest('[data-account-row]')) b.remove()
        }
      }, 50)
    })
  }

  if (NEGATIVE) {
    // L'etat d'AVANT le correctif, rejoue dans la page : le compteur reprend l'accent du
    // compte ACTIF (`--synap-account`), quelle que soit la boite a laquelle il appartient.
    // Le style en ligne n'est pas gere par React, il survit aux rendus.
    await page.evaluateOnNewDocument(() => {
      setInterval(() => {
        for (const b of document.querySelectorAll('[data-unread-badge]')) {
          const accent = getComputedStyle(b).getPropertyValue('--synap-account').trim()
          if (accent) b.style.backgroundColor = accent
        }
      }, 50)
    })
  }

  /**
   * Tout ce qui se mesure sur un ecran, en UN passage dans la page : pour chaque bulle
   * visible, la couleur de sa bulle, celle de son compteur, ce que `elementFromPoint`
   * renvoie au centre du compteur, et le centre de l'ENCRE du nombre et des lettres.
   */
  const readScreen = async label => {
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const seen = await page.evaluate(tol => {
      // Le centre de l'encre d'un element ne contenant qu'une ligne de texte : la boite
      // de ligne donne la position verticale de la ligne de base a partir des metriques
      // de la fonte, puis l'encre du texte rendu se place autour de cette ligne.
      const ctx = document.createElement('canvas').getContext('2d')
      const inkCentre = el => {
        const text = (el.textContent ?? '').trim()
        if (!text) return null
        const box = el.getBoundingClientRect()
        if (!box.width || !box.height) return null
        const s = getComputedStyle(el)
        ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
        const m = ctx.measureText(text)
        const emAscent = m.fontBoundingBoxAscent, emDescent = m.fontBoundingBoxDescent
        // La ligne de base : la boite de ligne centre la boite em de la fonte.
        const baseline = box.top + (box.height - (emAscent + emDescent)) / 2 + emAscent
        const inkTop = baseline - m.actualBoundingBoxAscent
        const inkBottom = baseline + m.actualBoundingBoxDescent
        const inkLeft = box.left + (box.width - m.width) / 2
        return { x: inkLeft + m.width / 2, y: (inkTop + inkBottom) / 2 }
      }
      const rounded = v => Math.round(v * 100) / 100
      const out = []
      let folded = 0
      for (const bubble of document.querySelectorAll('[data-account-badge]')) {
        const bubbleBox = bubble.getBoundingClientRect()
        if (!bubbleBox.width || !bubbleBox.height) continue
        // Une liste de boites REPLIEE garde ses lignes dans le document, avec une boite
        // de mise en page, mais sous `visibility: hidden` — c'est ce qui les sort du
        // parcours clavier. Les mesurer reviendrait a exiger qu'un element volontairement
        // plie soit visible : le banc echouerait sur le comportement voulu. On les compte
        // separement plutot que de les jeter en silence, pour que le rapport dise combien
        // d'elements il a ecartes et pourquoi.
        if (!bubble.checkVisibility({ visibilityProperty: true, opacityProperty: true })) { folded++; continue }
        const host = bubble.parentElement
        const badge = host?.querySelector('[data-unread-badge]')
        const row = {
          id: bubble.getAttribute('data-account-badge'),
          bubble: getComputedStyle(bubble).backgroundColor,
          size: bubble.getAttribute('data-account-badge-size'),
          // Un compteur SOUS la ligne de flottaison ne renvoie rien a
          // `elementFromPoint`, qui ne repond que dans le cadre visible : sans ce
          // drapeau, « hors du cadre » se lirait « recouvert », c'est-a-dire une panne
          // produit inventee par le banc.
          inViewport: bubbleBox.top >= 0 && bubbleBox.bottom <= innerHeight,
        }
        const letters = bubble.querySelector('[data-account-initial]')
        const lettersInk = letters ? inkCentre(letters) : null
        if (lettersInk) {
          row.lettersDx = rounded(lettersInk.x - (bubbleBox.left + bubbleBox.width / 2))
          row.lettersDy = rounded(lettersInk.y - (bubbleBox.top + bubbleBox.height / 2))
        }
        if (badge) {
          const badgeBox = badge.getBoundingClientRect()
          row.badge = getComputedStyle(badge).backgroundColor
          row.badgeBox = { top: rounded(badgeBox.top), right: rounded(badgeBox.right), bottom: rounded(badgeBox.bottom), left: rounded(badgeBox.left) }
          row.badgeText = badge.textContent.trim()
          const cx = badgeBox.left + badgeBox.width / 2, cy = badgeBox.top + badgeBox.height / 2
          // Ce que le point central du compteur renvoie VRAIMENT. Un ancetre y est une
          // information, pas un detail : un ancetre peint SOUS son descendant, donc s'il
          // ressort au centre du compteur, c'est que le compteur n'y est pas peint — il
          // est rogne (`overflow: hidden`) ou hors ecran. On enregistre donc l'element
          // touche pour pouvoir le NOMMER au rapport, au lieu d'un booleen muet.
          const hit = document.elementFromPoint(cx, cy)
          row.badgeReachable = !!hit && (hit === badge || badge.contains(hit))
          row.badgeHit = hit ? `${hit.tagName.toLowerCase()}${hit.className ? `.${String(hit.className).split(' ').slice(0, 3).join('.')}` : ''}` : 'null'
          row.badgeVisibility = getComputedStyle(badge).visibility
          row.badgeOpacity = getComputedStyle(badge).opacity
          const ink = inkCentre(badge)
          if (ink) { row.numberDx = rounded(ink.x - cx); row.numberDy = rounded(ink.y - cy) }
        }
        out.push(row)
      }
      const bar = document.querySelector('[data-sidebar]')?.getBoundingClientRect()
      return { rows: out, folded, sidebar: bar ? { top: bar.top, right: bar.right, bottom: bar.bottom, left: bar.left } : null, tol }
    }, CENTER_TOL_PX)
    const counters = seen.rows.filter(r => r.badge).length
    console.log(`  ${label} : ${seen.rows.length} bulle(s) visible(s), ${counters} compteur(s)`
      + `${seen.folded ? `, ${seen.folded} bulle(s) repliee(s) ecartee(s)` : ''}`)
    seen.counters = counters
    return seen
  }

  /** Les criteres de l'enonce, appliques a un ecran deja lu. */
  const assertScreen = (label, seen, { clipped = false } = {}) => {
    assertedCounters += seen.counters
    for (const r of seen.rows) {
      const who = `${label} / boite ${r.id.slice(0, 8)}`
      // Lot H4c-bis : une boite qui a des non-lus DOIT porter son compteur, sur CET
      // ecran comme sur les autres. La reference n'est pas une constante : c'est le
      // nombre de non-lus que l'API rend dans le MEME passage (`UNREAD_BY_ID`), donc
      // le critere se recalibre tout seul quand la boite de test change. C'est ce qui
      // manquait : Reglages -> Comptes et la palette peignaient la bulle sans jamais
      // nourrir le compteur, et le banc ne voyait rien puisqu'il ne controlait QUE les
      // compteurs deja presents.
      const expected = UNREAD_BY_ID.get(r.id)
      if (expected > 0 && r.size !== INLINE_SIZE) {
        check(`${who} : porte son compteur (l'API annonce ${expected} non-lu(s))`, !!r.badge,
          r.badge ? '' : 'aucun [data-unread-badge] dans la bulle')
      }
      if (r.lettersDx !== undefined) {
        check(`${who} : initiales centrees dans la bulle`,
          Math.abs(r.lettersDx) <= CENTER_TOL_PX && Math.abs(r.lettersDy) <= CENTER_TOL_PX,
          `dx=${r.lettersDx}px dy=${r.lettersDy}px (tolerance ${CENTER_TOL_PX}px)`)
      }
      if (!r.badge) continue
      check(`${who} : le compteur porte la couleur de SA bulle`, r.badge === r.bubble,
        `compteur=${r.badge} bulle=${r.bubble}`)
      // Recouvrement : ne se prononce QUE sur un compteur dans le cadre visible. Sous la
      // ligne de flottaison, `elementFromPoint` rend `null` par construction, et le banc
      // n'a alors rien mesure — il ne doit donc rien conclure.
      if (r.inViewport) {
        check(`${who} : le compteur est a l'ecran et rien ne le recouvre`, r.badgeReachable === true,
          `visibility=${r.badgeVisibility} opacity=${r.badgeOpacity} elementFromPoint=${r.badgeHit} boite=${JSON.stringify(r.badgeBox)}`)
      }
      check(`${who} : nombre « ${r.badgeText} » centre dans le compteur`,
        Math.abs(r.numberDx) <= CENTER_TOL_PX && Math.abs(r.numberDy) <= CENTER_TOL_PX,
        `dx=${r.numberDx}px dy=${r.numberDy}px (tolerance ${CENTER_TOL_PX}px)`)
      if (clipped && seen.sidebar) {
        const b = r.badgeBox, s = seen.sidebar
        check(`${who} : le compteur n'est pas rogne par le bord de la barre`,
          b.left >= s.left - 0.5 && b.right <= s.right + 0.5 && b.top >= s.top - 0.5 && b.bottom <= s.bottom + 0.5,
          `compteur ${JSON.stringify(b)} barre ${JSON.stringify(s)}`)
      }
    }
  }

  // 1. La palette (omnibar) : ses suggestions de boites portent la meme bulle. Mesuree
  // EN PREMIER, sur un document neuf : le champ se relit depuis l'URL, et une portee ou
  // une recherche laissee par un ecran precedent le vidait au moment de la saisie
  // (mesure : champ a « », panneau ferme, alors que la meme saisie sur une page fraiche
  // proposait 5 boites). L'ordre des ecrans est donc une condition du banc, pas un detail.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-omnibar-search]')
  // Ce qu'on tape dans la palette vient des boites REELLES du compte de test, jamais
  // d'une lettre choisie a la main : une lettre en dur ne proposerait plus rien le jour
  // ou les boites changent, et le banc annoncerait une panne de produit.
  // Un SEUL passage sur l'API nourrit deux choses : de quoi interroger la palette, et la
  // REFERENCE de non-lus par boite, lue dans le meme passage que les ecrans mesures.
  const apiAccounts = await page.evaluate(async base => {
    const body = await (await fetch(`${base}/api/accounts`, { credentials: 'same-origin' })).json()
    return (body.data ?? []).map(a => ({ id: a.id, label: ((a.name || a.email) ?? '').trim(), unread: a.unreadCount ?? 0 }))
  }, BASE)
  if (!apiAccounts.length) harness('l\'API ne rend aucune boite')
  for (const a of apiAccounts) UNREAD_BY_ID.set(a.id, a.unread)
  const withUnread = apiAccounts.filter(a => a.unread > 0).length
  console.log(`  reference : ${apiAccounts.length} boite(s), dont ${withUnread} avec des non-lus`)
  if (!withUnread) harness('aucune boite de test n\'a de non-lus — le banc ne peut rien dire du compteur')
  const PALETTE_QUERY = apiAccounts[0].label.slice(0, 2)
  if (PALETTE_QUERY.length < 2) harness('aucune boite lisible pour interroger la palette')
  // La palette ne deroule ses entrees que sur une SAISIE : cliquer le champ ne suffit
  // pas (`showPanel = panelOpen && suggestions.length > 0`). On tape donc la premiere
  // lettre d'une boite, comme un humain qui cherche une boite dans la palette.
  await page.click('[data-omnibar-search]')
  // Vidage caractere par caractere : mesure du 19/09 deja consignee par
  // `check-omnibar.mjs` — dans ce Chrome headless un Cmd+A suivi d'un Backspace
  // n'efface QU'UN caractere, et les saisies s'empilent. On efface ce que le champ
  // porte, puis on tape, puis on VERIFIE que le champ porte bien la saisie : sans ce
  // controle, une saisie tronquee se lisait comme une palette sans boite, c'est-a-dire
  // comme une panne de produit.
  // La saisie du champ n'est pas fiable en une passe : le champ relance la recherche a
  // `SEARCH_DEBOUNCE_MS` et se relit depuis l'URL, ce qui peut avaler des caracteres
  // (mesure : « ni » tape, champ a « i » puis vide). On retape donc jusqu'a ce que le
  // champ porte VRAIMENT la saisie, en nombre borne d'essais, et on annonce HARNESS si
  // on n'y arrive pas — une saisie tronquee ne dit rien du produit.
  let typed = ''
  for (let attempt = 0; attempt < TYPE_ATTEMPTS && typed !== PALETTE_QUERY; attempt++) {
    await page.click('[data-omnibar-search]')
    const before = await page.$eval('[data-omnibar-search]', el => el.value.length)
    for (let i = 0; i < before; i++) await page.keyboard.press('Backspace')
    await page.type('[data-omnibar-search]', PALETTE_QUERY, { delay: 40 })
    await new Promise(r => setTimeout(r, TYPE_SETTLE_MS))
    typed = await page.$eval('[data-omnibar-search]', el => el.value)
  }
  if (typed !== PALETTE_QUERY) harness(`le champ porte « ${typed} » apres ${TYPE_ATTEMPTS} essais de « ${PALETTE_QUERY} »`)
  await page.waitForSelector('[data-omnibar-panel] [data-account-badge]')
    .catch(async () => harness(`la palette ne propose aucune boite pour « ${PALETTE_QUERY} » — `
      + JSON.stringify(await page.evaluate(() => ({
        panel: !!document.querySelector('[data-omnibar-panel]'),
        entries: [...document.querySelectorAll('[data-omnibar-entry]')].map(e => e.dataset.omnibarEntry),
        value: document.querySelector('[data-omnibar-search]')?.value,
      })))))
  const palette = await readScreen('palette (omnibar)')
  if (!palette.rows.length) harness('la palette s\'est ouverte sans peindre une bulle de boite')
  assertScreen('palette', palette)
  // 2. + 3. La barre laterale, liste des boites DEPLIEE puis barre REPLIEE. L'etat vit
  // cote serveur ; il est pose par l'interface elle-meme (clic), pas par une requete
  // d'ecriture : ce banc reste en lecture seule vis-a-vis de l'API.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(SIDEBAR_ACCOUNT)
  const collapsedNow = await page.$eval('[data-sidebar]', el => el.dataset.collapsed === 'true')
  if (collapsedNow) { await page.click('[data-omnibar-menu]'); await new Promise(r => setTimeout(r, SETTLE_MS)) }
  await page.click(SIDEBAR_ACCOUNT)
  assertScreen('barre depliee', await readScreen('barre laterale (depliee)'), { clipped: true })

  await page.click('[data-omnibar-menu]')
  assertScreen('barre repliee', await readScreen('barre laterale (repliee)'), { clipped: true })
  await page.click('[data-omnibar-menu]')
  await new Promise(r => setTimeout(r, SETTLE_MS))

  // 4. Reglages -> Comptes.
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(BUBBLE)
  assertScreen('reglages', await readScreen('reglages -> comptes'))

  // 5. Le tableau de bord : ses pastilles, puis son selecteur deplie.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(DASHBOARD_TRIGGER)
    .catch(() => harness('le selecteur du tableau de bord ne rend pas son bouton'))
  assertScreen('tableau de bord', await readScreen('tableau de bord (pastilles)'))
  await page.click(DASHBOARD_TRIGGER)
  const picker = await readScreen('tableau de bord (selecteur)')
  if (!picker.rows.length) harness('le selecteur du tableau de bord s\'est ouvert sans peindre une bulle')
  assertScreen('selecteur', picker)

} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, CLOSE_TIMEOUT_MS))])
  browser.process()?.kill('SIGKILL')
}

if (assertedCounters < MIN_COUNTERS) {
  console.error(`HARNESS: ${assertedCounters} compteur(s) eprouve(s), il en faut au moins ${MIN_COUNTERS} `
    + '— le banc n\'a pas assez mesure pour conclure quoi que ce soit sur le produit')
  process.exit(2)
}
for (const [flag, on, what] of [
  ['--negative', NEGATIVE, 'l\'accent du compte actif est rejoue'],
  ['--negative-missing', NEGATIVE_MISSING, 'le compteur est retire de Reglages -> Comptes et de la palette'],
]) {
  if (!on) continue
  if (failures.length) {
    console.log(`check-account-badge-color ${flag} : rouge comme attendu (${failures.length} echec(s))`)
    process.exit(0)
  }
  console.error(`check-account-badge-color ${flag} : VERT alors que ${what} — le banc ne mesure rien`)
  process.exit(1)
}
if (failures.length) {
  console.error(`check-account-badge-color : ${failures.length} echec(s)`)
  process.exit(1)
}
console.log('check-account-badge-color : OK')
