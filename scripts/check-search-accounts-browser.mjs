#!/usr/bin/env node
/**
 * Browser bench of lot S4b: the "all mailboxes" scope, exercised in a REAL Chrome
 * over the real mailboxes of the test account. It answers the four questions the
 * lot names, plus the geometry the lot inherits from H3c:
 *
 *  A. COLD PATH — the URL `/mail?q=…&scope=accounts` opened DIRECTLY (a reload, a
 *     shared link, the omnibar's own navigation) streams: a first result within
 *     budget, the Stop button present when it lands, and the banner announcing
 *     "N mailboxes out of M" rather than a final "0 result".
 *  B. STOP — pressing Stop ends the stream: the button goes away and the row
 *     count stops growing. Same-run REFERENCE: the growth observed over the same
 *     wall-clock window BEFORE the click, on this very stream.
 *  C. A DOWN MAILBOX DOES NOT BREAK THE SWEEP — a mailbox whose IMAP host cannot
 *     be reached is added for the run, and the sweep must still report the other
 *     mailboxes and NAME the unreachable one. The extra mailbox is created and
 *     DELETED by the bench itself through the app's own API; it points at a
 *     blackhole host, so no real mail server is ever contacted for it.
 *  D. A RESULT FROM ANOTHER MAILBOX OPENS IN ITS OWN MAILBOX — clicking it asks
 *     the API for THAT mailbox and THAT folder, and the active mailbox (what the
 *     sidebar and the settings call the current account) does not change.
 *  E. GEOMETRY at 1100 px and 390 px — no horizontal overflow, and the scope
 *     selector either fits without overlapping its neighbours or folds away.
 *  G. THE SCOPE SELECTOR IS CLICKABLE — from a cold `/mail?q=…`, a REAL mouse
 *     click on each of the three scopes updates the URL, presses that segment and
 *     fires one search for it. A JS `.click()` would pass even when the selector
 *     is buried under another element, so this arm only ever uses the mouse.
 *     Negative control: a mouse click on bare header background changes nothing.
 *
 * Arm B also measures the banner's GEOMETRY: the Stop button and the details icon
 * must stay entirely INSIDE the list column and be what `elementFromPoint` returns
 * at their centre — a button pushed under the reading pane by a long progress text
 * cannot be pressed, and Stop is the most important button of a long sweep.
 *
 * READ ONLY on mail: every mutating request to /api/messages is captured and
 * ABORTED, so no message is created, moved, flagged or deleted, and no body is
 * printed. Arm C is the single exception to "no writes at all" and it is scoped
 * to the ACCOUNT list, never to mail: it POSTs one unreachable mailbox and
 * DELETEs it in a `finally`, whatever happens.
 *
 * Needs a running dev server and SYNAPMAIL_TEST_* credentials (see .env).
 *   node scripts/check-search-accounts-browser.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
// Les deux largeurs que le lot S4b nomme explicitement pour la géométrie.
const GEOMETRY_WIDTHS = [1100, 390]
// Budget du premier résultat, le même nombre que `check-search-accounts-live.mjs`
// pose pour le flux sans navigateur — il vient du lot S4b (« 1er résultat < 10 s »),
// calibré le 20/09/2026 sur le compte de test (7 boîtes, 185 dossiers). Ici le banc
// mesure EN PLUS le coût d'un chargement à froid de la page, donc le budget est
// atteint par un chemin plus long que celui du banc réseau.
const FIRST_RESULT_BUDGET_MS = 10000
// Un balayage complet de toutes les boîtes du compte de test a été mesuré à 27,3 s
// (banc réseau, 20/09/2026) ; la marge couvre une machine chargée.
const STREAM_TIMEOUT_MS = 180000
// Le banc échantillonne la bannière assez souvent pour voir un état qui ne dure
// que quelques centaines de millisecondes.
const SAMPLE_MS = 50
// Un serveur de dev COMPILE /mail et sa route au premier appel : la valeur par
// défaut de puppeteer (30 s) transformerait cette compilation en échec de BANC,
// qui ne dirait rien du produit.
const NAV_TIMEOUT_MS = STREAM_TIMEOUT_MS
const SETTLE_MS = 600
// Hôte IMAP de la boîte en panne de l'arm C : une adresse de DOCUMENTATION
// (RFC 5737, TEST-NET-1), jamais routée vers un vrai serveur.
const BLACKHOLE_HOST = '192.0.2.1'
// Écart minimal entre deux cibles cliquables voisines du header, en pixels CSS —
// la même valeur que `check-omnibar.mjs` (gate humain du 19/09 : « écarts ≥ 4 px »).
const MIN_HIT_GAP_PX = 4

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

// Les noms de paramètres, la portée et l'attribut d'origine sont LUS dans les
// modules livrés : les renommer là-bas casse ce banc, au lieu de lui faire
// mesurer une URL ou un attribut que le produit ne sert plus.
const SEARCH_SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const constOf = (src, name) => src.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1]
const Q_PARAM = constOf(SEARCH_SRC, 'SEARCH_PARAM')
const SCOPE_P = constOf(SEARCH_SRC, 'SCOPE_PARAM')
const SCOPE_ACC = constOf(SEARCH_SRC, 'SCOPE_ACCOUNTS')
/** Lot H3g : la puce de portée dans le champ, et le menu qu'elle ouvre. */
const SCOPE_TRIGGER = '[data-omnibar-scope-trigger]'
const SCOPE_MENU = '[data-omnibar-scope-menu]'
const ORIGIN_SRC = readFileSync(new URL('../lib/mailOrigin.ts', import.meta.url), 'utf8')
const ORIGIN_ATTR = ORIGIN_SRC.match(/MAIL_ORIGIN_ATTR = '([^']+)'/)?.[1]
// L'attribut que la LISTE pose sur son propre conteneur : il sert ici à trouver le
// rectangle de la colonne, plutôt que d'y recopier une largeur (elle est réglable).
const SELECTION_SRC = readFileSync(new URL('../lib/mailSelection.tsx', import.meta.url), 'utf8')
const COLUMN_ATTR = SELECTION_SRC.match(/MAIL_SELECTION_COUNT_ATTR = '([^']+)'/)?.[1]
// Les portées DANS L'ORDRE du sélecteur : `SEARCH_SCOPES` nomme des constantes, on
// résout chacune par sa valeur. La première est la portée PAR DÉFAUT, celle que
// `buildSearchHref` efface de l'URL.
const SCOPES = (SEARCH_SRC.match(/export const SEARCH_SCOPES = \[([^\]]+)\]/)?.[1] ?? '')
  .split(',').map(x => x.trim()).filter(Boolean)
  .map(name => constOf(SEARCH_SRC, name))
// Le libellé « Arrêter » vient de la locale livrée, pas d'une chaîne recopiée.
const FR = JSON.parse(readFileSync(new URL('../locales/fr.json', import.meta.url), 'utf8'))
const STOP_LABEL = FR.mail?.searchStop
for (const [k, v] of Object.entries({ Q_PARAM, SCOPE_P, SCOPE_ACC, ORIGIN_ATTR, COLUMN_ATTR, STOP_LABEL })) {
  if (!v) { console.error(`HARNESS: could not read ${k} from the shipped modules`); process.exit(2) }
}
if (SCOPES.length < 2 || SCOPES.some(v => !v)) {
  console.error(`HARNESS: could not read SEARCH_SCOPES from lib/search.ts (got ${JSON.stringify(SCOPES)})`)
  process.exit(2)
}
const ROW = `[${ORIGIN_ATTR}]`

const failures = []
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
const settle = () => new Promise(r => setTimeout(r, SETTLE_MS))

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  protocolTimeout: NAV_TIMEOUT_MS * 2,
})
// Identifiant de la boîte en panne de l'arm C, retiré dans le `finally` global.
let downAccountId = null
let page = null
try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  // LECTURE SEULE sur le courrier, imposée : toute requête mutante sur l'API des
  // messages est capturée et avortée — elle n'atteint jamais le serveur.
  await page.setRequestInterception(true)
  const blockedWrites = []
  const reads = []          // GET /api/messages/<uid>?… — ce que l'app demande à OUVRIR
  const searchRequests = []
  page.on('request', req => {
    const url = req.url()
    const method = req.method()
    if (method !== 'GET' && /\/api\/messages/.test(url)) {
      blockedWrites.push(`${method} ${url}`)
      req.abort().catch(() => {})
      return
    }
    if (/\/api\/messages\/search\?/.test(url)) searchRequests.push({ url, at: Date.now() })
    const single = new URL(url).pathname.match(/^\/api\/messages\/([^/]+)$/)
    if (single && method === 'GET') {
      const params = new URL(url).searchParams
      reads.push({ uid: single[1], folder: params.get('folder'), account: params.get('account') })
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

  // Une execution TUEE (plafond de tours, Ctrl-C) n'atteint jamais son `finally` :
  // sa boite trou-noir reste et fait attendre chaque balayage suivant. Le banc se
  // nettoie donc a l'ENTREE, pas seulement a la sortie.
  const leaked = await page.evaluate(async host => {
    const all = (await (await fetch('/api/accounts')).json()).data ?? []
    const stale = all.filter(a => a.imapHost === host)
    for (const a of stale) await fetch(`/api/accounts/${a.id}`, { method: 'DELETE' }).catch(() => {})
    return stale.length
  }, BLACKHOLE_HOST)
  if (leaked) console.log(`cleanup: removed ${leaked} leaked bench mailbox(es) from a killed run`)

  const accounts = await page.evaluate(async () =>
    (await (await fetch('/api/accounts')).json()).data ?? [])
  if (accounts.length < 2) harness(`the \"all mailboxes\" scope needs at least 2 mailboxes, the test user has ${accounts.length}`)
  const settings = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).data)
  const active = accounts.find(a => a.id === settings?.active_account_id) ?? accounts.find(a => a.isDefault) ?? accounts[0]
  // Le terme est DÉRIVÉ de la boîte : le banc continue de trouver des résultats
  // après un changement de contenu du compte de test.
  const term = active.email.split('@')[1]
  if (!term) harness(`cannot derive a search term from ${active.email}`)
  console.log(`base           ${BASE}`)
  console.log(`mailboxes      ${accounts.length} (active: ${active.email})`)
  console.log(`term           ${term}\n`)

  // Chauffe : la première compilation de /mail et de la route de recherche n'a
  // rien à voir avec la latence du produit, et serait comptée dans le budget.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-mail-row]', { timeout: NAV_TIMEOUT_MS })
  await page.evaluate(async ([q, qp, sp]) => {
    await fetch(`/api/messages/search?${qp}=${encodeURIComponent(q)}&folder=INBOX&${sp}=folder`).catch(() => {})
  }, [term, Q_PARAM, SCOPE_P])

  const href = `${BASE}/mail?${Q_PARAM}=${encodeURIComponent(term)}&${SCOPE_P}=${SCOPE_ACC}`
  // Un instantané de la bannière, des lignes et du bouton Arrêter, en une frame.
  const snap = () => page.evaluate(() => {
    const p = document.querySelector('[data-search-summary]')
    if (!p) return null
    const box = p.parentElement
    return {
      text: p.textContent.trim(),
      rows: document.querySelectorAll('[data-mail-row]').length,
      accountBadges: document.querySelectorAll('[data-result-account]').length,
      stop: [...box.querySelectorAll('button')].some(b => /Arr[êe]ter|Stop|停止/.test(b.textContent ?? '')),
    }
  })

  /**
   * Géométrie du bandeau de recherche : la colonne de liste, le bouton Arrêter et
   * l'icône de détails, avec ce qu'un clic à leur centre ATTEINDRAIT réellement
   * (`elementFromPoint`). `self` = la cible elle-même ; toute autre valeur nomme
   * l'élément qui la recouvre. La colonne est trouvée par le conteneur de la
   * liste, pas par une largeur recopiée : elle est redimensionnable.
   */
  const bannerGeometry = () => page.evaluate(([stopLabel, columnAttr]) => {
    const p = document.querySelector('[data-search-summary]')
    if (!p) return null
    const box = p.parentElement
    const column = p.closest(`[${columnAttr}]`)
    if (!column) return null
    const stop = [...box.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === stopLabel) ?? null
    const info = box.querySelector('[data-search-details]')
    const rect = el => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left), right: Math.round(r.right),
        cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      }
    }
    const hit = el => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!at) return 'nothing'
      return at === el || el.contains(at) || at.contains(el) ? 'self' : (at.tagName.toLowerCase() + '.' + String(at.className).split(' ').slice(0, 2).join('.'))
    }
    return {
      text: p.textContent.trim(),
      column: rect(column), stop: rect(stop), info: rect(info),
      stopHit: hit(stop), infoHit: hit(info),
    }
  }, [STOP_LABEL, COLUMN_ATTR])

  // ────────────────────────── A. LE CHEMIN À FROID ──────────────────────────
  console.log('A. the cold URL streams every mailbox')
  searchRequests.length = 0
  const t0 = Date.now()
  await page.goto(href, { waitUntil: 'domcontentloaded' })
  let firstRow = null
  let sawAccountProgress = false
  let finalZeroMs = 0
  let zeroSince = null
  const trail = []
  for (;;) {
    const s = await snap()
    const t = Date.now() - t0
    if (s) {
      if (!trail.length || trail[trail.length - 1].text !== s.text || trail[trail.length - 1].stop !== s.stop) {
        trail.push({ t, text: s.text, rows: s.rows, stop: s.stop })
      }
      if (s.rows > 0 && firstRow === null) firstRow = { t, ...s }
      // « N boîtes sur M » : la progression PAR BOÎTE, celle que le lot S4b ajoute
      // à la progression par dossier de S2.
      if (/bo[îi]tes? sur \d|mailboxe?s? (out )?of \d|个邮箱/.test(s.text)) sawAccountProgress = true
      const finalZero = /^0 /.test(s.text) && !s.stop && !/Recherche|Searching|搜索/.test(s.text)
      if (finalZero) { zeroSince ??= t } else if (zeroSince !== null) { finalZeroMs = Math.max(finalZeroMs, t - zeroSince); zeroSince = null }
      // Fin du flux : plus de bouton Arrêter et plus rien qui annonce une progression.
      if (!s.stop && trail.length > 1 && s.rows > 0 && !/Recherche|Searching|搜索|sur \d|of \d/.test(s.text)) break
      // Le reste des arms a besoin d'un flux ENCORE EN COURS : dès que la
      // progression par boîte est visible avec des lignes, l'arm A a ce qu'il veut.
      if (firstRow && sawAccountProgress) break
    }
    if (Date.now() - t0 > STREAM_TIMEOUT_MS) break
    await new Promise(r => setTimeout(r, SAMPLE_MS))
  }
  if (zeroSince !== null) finalZeroMs = Math.max(finalZeroMs, (Date.now() - t0) - zeroSince)
  if (firstRow === null) harness(`no result row appeared in ${Date.now() - t0} ms for "${term}" — the bench cannot judge the cold path`)
  console.log('banner trail (cold load):')
  for (const s of trail.slice(0, 6)) console.log(`  ${String(s.t).padStart(6)} ms | stop=${s.stop ? 'yes' : 'no '} | rows=${String(s.rows).padStart(3)} | ${s.text}`)
  if (trail.length > 6) console.log(`  … ${trail.length - 6} more state(s), last: ${trail[trail.length - 1].text}`)

  check('a first result lands within budget on the cold URL',
    firstRow.t < FIRST_RESULT_BUDGET_MS, `${firstRow.t} ms < ${FIRST_RESULT_BUDGET_MS} ms`)
  check('Stop is offered when the first result is shown', firstRow.stop === true,
    `banner "${firstRow.text}"`)
  check('the banner counts mailboxes, not only folders', sawAccountProgress,
    sawAccountProgress ? 'mailbox progress seen' : 'no "N mailboxes out of M" state ever appeared')
  check('no final "0 result" is claimed while the sweep runs', finalZeroMs === 0,
    finalZeroMs === 0 ? 'never' : `shown as final for ${finalZeroMs} ms`)
  const accountless = searchRequests.filter(r => !/[?&]account=/.test(r.url))
  check('no search fires before the mailbox is resolved', accountless.length === 0,
    accountless.length ? `${accountless.length} request(s) without account=` : `${searchRequests.length} request(s), all scoped`)
  const withBadge = await snap()
  check('a result names the mailbox it comes from',
    withBadge.accountBadges > 0 && withBadge.accountBadges === withBadge.rows,
    `${withBadge.accountBadges} badge(s) for ${withBadge.rows} row(s)`)

  // ─────────────── B. ARRÊTER ARRÊTE (référence du MÊME flux) ───────────────
  console.log('\nB. Stop ends the stream')
  const before = await snap()
  if (!before?.stop) {
    // Sans flux en cours, il n'y a rien à arrêter : ce serait mesurer le vide.
    harness('the stream had already ended before the Stop arm could run')
  }
  // BRAS DE RÉFÉRENCE, MÊME RUN : la croissance de ce flux-ci sur une fenêtre,
  // juste avant le clic. Aucun seuil absolu — un serveur plus lent ou plus rapide
  // déplace les deux mesures ensemble.
  const GROWTH_WINDOW_MS = 3000
  await new Promise(r => setTimeout(r, GROWTH_WINDOW_MS))
  const running = await snap()
  const grewWhileRunning = running.rows - before.rows

  // GÉOMÉTRIE DU BANDEAU, pendant que le flux court — c'est le seul moment où
  // Arrêter existe et où la progression est la plus longue. Le bouton et l'icône
  // doivent tenir DANS la colonne de liste et être ce que `elementFromPoint`
  // renvoie en leur centre : poussés sous le volet de lecture par un texte trop
  // long, ils ne sont plus cliquables (mesuré le 20/09/2026 : Arrêter à 130 px
  // hors de la colonne). C'est le TEXTE qui doit céder, pas les cibles.
  const banner = await bannerGeometry()
  if (!banner) harness('the banner geometry could not be read while the stream was running')
  console.log(`  banner "${banner.text}"`)
  console.log(`  column ${banner.column.left}→${banner.column.right}px | ` +
    `Stop ${banner.stop ? `${banner.stop.left}→${banner.stop.right}px, elementFromPoint=${banner.stopHit}` : '(absent)'} | ` +
    `details ${banner.info ? `${banner.info.left}→${banner.info.right}px, elementFromPoint=${banner.infoHit}` : '(absent)'}`)
  check('the Stop button stays inside the list column',
    !!banner.stop && banner.stop.left >= banner.column.left - 0.5 && banner.stop.right <= banner.column.right + 0.5,
    banner.stop ? `${banner.stop.right}px vs column edge ${banner.column.right}px` : 'no Stop button')
  check('the details icon stays inside the list column',
    !!banner.info && banner.info.left >= banner.column.left - 0.5 && banner.info.right <= banner.column.right + 0.5,
    banner.info ? `${banner.info.right}px vs column edge ${banner.column.right}px` : 'no details icon')
  check('the Stop button is what a click at its centre would hit', banner.stopHit === 'self', banner.stopHit)
  check('the details icon is what a click at its centre would hit', banner.infoHit === 'self', banner.infoHit)

  // VRAI clic souris, jamais `.click()` en JavaScript : un bouton recouvert par un
  // autre élément accepte l'appel JS et refuse le vrai clic — c'est précisément le
  // défaut que ce banc doit voir.
  if (banner.stop) await page.mouse.click(banner.stop.cx, banner.stop.cy)
  else harness('no Stop button to click — the stop arm has no subject')
  await settle()
  const justAfter = await snap()
  await new Promise(r => setTimeout(r, GROWTH_WINDOW_MS))
  const later = await snap()
  const grewAfterStop = later.rows - justAfter.rows
  console.log(`  rows ${before.rows} → ${running.rows} while running (+${grewWhileRunning} in ${GROWTH_WINDOW_MS} ms), ` +
    `${justAfter.rows} → ${later.rows} after Stop (+${grewAfterStop})`)
  check('the Stop button disappears once pressed by a real mouse click', justAfter.stop === false, `stop=${justAfter.stop}`)
  check('no further result arrives after a real mouse click on Stop', grewAfterStop === 0,
    `+${grewAfterStop} row(s) after Stop, against +${grewWhileRunning} over the same window while running (same-run reference)`)

  // ──────── C. UNE BOÎTE EN PANNE N'ARRÊTE PAS LES AUTRES ────────
  console.log('\nC. an unreachable mailbox is named, and the others still report')
  const created = await page.evaluate(async ([host, owner]) => {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'S4b bench — unreachable',
        email: `s4b-down@${host}`,
        imapHost: host, imapPort: 993, imapSecure: true,
        smtpHost: host, smtpPort: 587, smtpSecure: false,
        username: owner, password: 'bench-only-never-used',
        isDefault: false,
      }),
    })
    return res.ok ? (await res.json()).data : { error: `${res.status}` }
  }, [BLACKHOLE_HOST, active.email])
  if (!created?.id) harness(`could not create the unreachable mailbox for arm C (${created?.error ?? 'no id'})`)
  downAccountId = created.id
  console.log(`  added mailbox ${created.email} → ${BLACKHOLE_HOST} (deleted at the end of the run)`)

  // Le flux est lu DIRECTEMENT ici : la liste plafonne l'affichage, la ligne
  // « injoignable » et la couverture par boîte se lisent sur le NDJSON.
  const sweep = await page.evaluate(async ([q, qp, sp, sa, id]) => {
    const res = await fetch(`/api/messages/search?${qp}=${encodeURIComponent(q)}&folder=INBOX&${sp}=${sa}&stream=1&account=${id}`)
    const rd = res.body.getReader(); const dec = new TextDecoder()
    let buf = ''; const lines = []
    for (;;) {
      const { done, value } = await rd.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n'); buf = parts.pop()
      for (const x of parts) if (x.trim()) lines.push(JSON.parse(x))
    }
    const reported = new Set()
    const unreachable = []
    let announced = 0
    for (const l of lines) {
      if (l.accountId) reported.add(l.accountId)
      if (l.accounts) announced = Math.max(announced, l.accounts)
      for (const e of l.unreachable ?? []) if (!unreachable.includes(e)) unreachable.push(e)
    }
    return { status: res.status, lines: lines.length, reported: [...reported], announced, unreachable,
      errorLines: lines.filter(l => l.error).length }
  }, [term, Q_PARAM, SCOPE_P, SCOPE_ACC, active.id])
  console.log(`  ${sweep.lines} NDJSON line(s), ${sweep.reported.length} mailbox(es) reported of ${sweep.announced} announced, ` +
    `unreachable: ${sweep.unreachable.join(', ') || 'none'}`)
  check('the sweep names the unreachable mailbox', sweep.unreachable.includes(created.email),
    sweep.unreachable.join(', ') || 'nothing reported unreachable')
  check('every other mailbox still reports', sweep.reported.length === accounts.length,
    `${sweep.reported.length} reported / ${accounts.length} reachable mailbox(es), ${sweep.announced} announced`)
  check('the stream does not fail on the unreachable mailbox', sweep.errorLines === 0 && sweep.status === 200,
    `status ${sweep.status}, ${sweep.errorLines} error line(s)`)

  // ──────── D. UN RÉSULTAT D'UNE AUTRE BOÎTE S'OUVRE DANS SA BOÎTE ────────
  console.log('\nD. a result from another mailbox opens in ITS mailbox')
  await page.goto(href, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(ROW, { timeout: NAV_TIMEOUT_MS })
  const readRows = () => page.$$eval(ROW, (els, attr) => els.map(el => el.getAttribute(attr)), ORIGIN_ATTR)
  const accountOf = key => decodeURIComponent(key.split('|')[0] ?? '')
  const folderOf = key => decodeURIComponent(key.split('|')[1] ?? '')
  const uidOf = key => decodeURIComponent(key.split('|')[2] ?? '')
  const deadline = Date.now() + STREAM_TIMEOUT_MS
  let keys = []
  let foreign = null
  while (Date.now() < deadline) {
    keys = await readRows()
    foreign = keys.find(k => accountOf(k) && accountOf(k) !== active.id)
    if (foreign) break
    await settle()
  }
  if (!foreign) harness(`no result from a mailbox other than ${active.email} appeared — the cross-mailbox arm has no subject`)
  // Le flux réordonne les lignes : on l'arrête avant de cliquer, sinon la clé lue
  // peut avoir disparu de l'écran au moment du clic (erreur de BANC, pas de produit).
  await page.evaluate(label => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === label)
    b?.click()
  }, STOP_LABEL)
  await settle()
  keys = await readRows()
  foreign = keys.find(k => accountOf(k) && accountOf(k) !== active.id) ?? foreign
  if (!keys.includes(foreign)) harness('the cross-mailbox row left the screen before it could be clicked')
  console.log(`  clicking a result of ${accountOf(foreign)} (${folderOf(foreign)}) while the active mailbox is ${active.id}`)
  reads.length = 0
  blockedWrites.length = 0   // l'arm F ne juge que les écritures nées de CE clic
  await page.click(`[${ORIGIN_ATTR}="${foreign}"]`)
  await settle()
  await settle()
  const opened = reads.filter(r => r.uid === uidOf(foreign))
  console.log(`  open request(s): ${opened.map(r => `uid=${r.uid} folder=${r.folder} account=${r.account}`).join(' | ') || '(none)'}`)
  check('clicking the result asks the API for it', opened.length > 0,
    `${opened.length} read request(s) for uid ${uidOf(foreign)}`)
  check('it is read from ITS mailbox and ITS folder',
    opened.length > 0 && opened.every(r => r.account === accountOf(foreign) && r.folder === folderOf(foreign)),
    opened.map(r => `${r.account}/${r.folder}`).join(' | ') || 'none')
  const activeAfter = await page.evaluate(async () =>
    (await (await fetch('/api/settings')).json()).data?.active_account_id ?? null)
  check('the active mailbox is unchanged', activeAfter === settings?.active_account_id,
    `${activeAfter} (was ${settings?.active_account_id})`)

  // ────────────────────────── E. GÉOMÉTRIE ──────────────────────────
  console.log('\nE. the scope selector fits at the widths the lot names')
  for (const width of GEOMETRY_WIDTHS) {
    await page.setViewport({ ...VIEWPORT, width })
    await page.goto(href, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-search-summary]', { timeout: NAV_TIMEOUT_MS })
    await settle()
    const shot = await page.evaluate(scopeAcc => {
      const gap = (a, b) => Math.max(
        Math.max(a.left, b.left) - Math.min(a.right, b.right),
        Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom),
      )
      const closest = rects => {
        let worst = Infinity
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) worst = Math.min(worst, gap(rects[i], rects[j]))
        }
        return worst === Infinity ? null : worst
      }
      const visible = sel => [...document.querySelectorAll(sel)]
        .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      // Lot H3g : la portée est une PUCE dans le champ, menu fermé. Elle compte pour
      // une cible, comme avant — mais ses distances se mesurent maintenant vis-à-vis
      // du champ qui la CONTIENT : elle doit tenir dedans, pas s'en écarter.
      const chip = visible('[data-omnibar-scope-trigger]')[0]?.getBoundingClientRect() ?? null
      const field = document.querySelector('[data-omnibar-search]')?.getBoundingClientRect() ?? null
      const scopes = chip ? [document.querySelector('[data-omnibar-scope-trigger]')] : []
      const group = chip
      const others = visible('header [data-omnibar-menu], header [data-omnibar-action], header [data-mail-toolbar-more], header [data-omnibar-search], header [data-user-menu-trigger]')
        .map(el => el.getBoundingClientRect())
      const header = document.querySelector('header')?.getBoundingClientRect() ?? null
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        scopes: scopes.length,
        // Le menu est FERMÉ ici : « toutes les boîtes » n'est plus une cible visible,
        // c'est une entrée du menu — l'arm G la mesure en l'ouvrant pour de vrai.
        hasAccountsScope: !!scopeAcc,
        scopeRight: chip?.right ?? null,
        // La puce est DANS le champ : ses bords ne doivent pas en sortir.
        chipInsideField: chip && field
          ? chip.left >= field.left - 0.5 && chip.right <= field.right + 0.5
          : null,
        headerRight: header?.right ?? null,
        // Entre cibles VOISINES du header. La puce de portée est EXCLUE : elle est
        // posée DANS le champ, donc elle le chevauche par construction — c'est
        // `chipInsideField` qui juge son placement, pas une distance au champ.
        worstGap: closest(others),
      }
    }, SCOPE_ACC)
    console.log(`  ${width}px: scope chip=${shot.scopes} (inside field=${shot.chipInsideField}) ` +
      `overflow=${shot.overflow} closest gap=${shot.worstGap === null ? 'n/a' : `${shot.worstGap.toFixed(2)}px`}`)
    check(`no horizontal overflow at ${width}px`, shot.overflow === false, `scrollWidth vs clientWidth`)
    if (shot.scopes === 0) {
      // Replié : le lot l'autorise explicitement (« replier le sélecteur proprement
      // s'il ne tient pas »). Rien à mesurer de plus à cette largeur.
      console.log(`  note the scope selector is folded away at ${width}px — allowed by the lot`)
    } else {
      check(`the scope selector stays inside the header at ${width}px`,
        shot.scopeRight !== null && shot.headerRight !== null && shot.scopeRight <= shot.headerRight + 0.5,
        `selector ends at ${shot.scopeRight?.toFixed(0)}px, header at ${shot.headerRight?.toFixed(0)}px`)
      check(`the header targets keep their distance at ${width}px`,
        shot.worstGap === null || shot.worstGap >= MIN_HIT_GAP_PX,
        `closest pair ${shot.worstGap?.toFixed(2)}px, floor ${MIN_HIT_GAP_PX}px`)
      // Lot H3g : la demande dit « la puce tient dans le champ sans débordement ».
      check(`the scope chip sits entirely inside the search field at ${width}px`,
        shot.chipInsideField === true, `chip inside field: ${shot.chipInsideField}`)
    }
  }

  // ──────── G. LE SÉLECTEUR DE PORTÉE RÉPOND AU VRAI CLIC SOURIS ────────
  // Le reste du banc n'entre dans une portée que par l'URL : il ne dirait donc RIEN
  // d'un sélecteur qui ne réagit plus au clic — le défaut relevé par le gate du
  // 20/09/2026, où l'URL restait sur `?q=…` douze secondes après le clic.
  console.log('\nG. a real mouse click on each scope changes the scope')
  await page.setViewport(VIEWPORT)
  const SCOPE_CLICK_TIMEOUT_MS = 12000
  // Ce bras mesure le PASSAGE de portée, pas sa VITESSE — le budget du premier
  // résultat est mesuré par le bras A, sur le chemin à froid. Une portée large
  // repart ici d'un balayage neuf : 8,0 s pour ses 200 premières lignes sur ce
  // compte (mesuré le 20/09/2026, serveur chaud), plus lent sur une machine
  // chargée. Deux fois le budget du bras A laisse cette marge sans jamais
  // laisser passer une portée qui ne s'applique PAS.
  const SCOPE_OUTCOME_BUDGET_MS = FIRST_RESULT_BUDGET_MS * 2
  // Les portées lues dans `SEARCH_SCOPES` — la liste ORDONNÉE que le sélecteur
  // parcourt lui-même, pas un ratissage des constantes `SCOPE_*` (qui ramasserait
  // `SCOPE_PARAM`, un nom de paramètre d'URL et non une portée). En ajouter une
  // là-bas l'ajoute ici, sans seconde liste à tenir à jour.
  // On repart d'un chargement à FROID de la recherche, portée par défaut : c'est le
  // geste réel (on cherche, puis on élargit).
  await page.goto(`${BASE}/mail?${Q_PARAM}=${encodeURIComponent(term)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(SCOPE_TRIGGER, { timeout: NAV_TIMEOUT_MS })
  await settle()
  // Lot H3g : les portées vivent dans un menu. Ouvrir la puce d'un VRAI clic est
  // le premier geste mesuré — sans lui, aucune portée n'est à l'écran à cliquer.
  const openScopeMenu = async () => {
    if (await page.$(SCOPE_MENU)) return true
    const box = await page.evaluate(sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2)
      const cy = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(cx, cy)
      return { cx, cy, hit: at === el || el.contains(at) ? 'self' : (at?.tagName.toLowerCase() ?? 'nothing') }
    }, SCOPE_TRIGGER)
    if (!box) return false
    check('the scope chip is what a click at its centre would hit', box.hit === 'self', box.hit)
    await page.mouse.click(box.cx, box.cy)
    try { await page.waitForSelector(SCOPE_MENU, { timeout: 2000 }) } catch { return false }
    return true
  }
  check('a real click on the chip opens the scope menu', await openScopeMenu(), 'menu present')
  const scopeState = () => page.evaluate(scopeParam => ({
    scope: new URLSearchParams(location.search).get(scopeParam),
    // Lot H3g : la coche vit sur l'entrée du menu (`aria-checked`). Menu fermé, il
    // n'y a rien à lire — c'est pourquoi la lecture se fait menu OUVERT.
    pressed: [...document.querySelectorAll('[data-omnibar-scope]')]
      .filter(el => el.getAttribute('aria-checked') === 'true')
      .map(el => el.dataset.omnibarScope),
  }), SCOPE_P)
  // L'ordre du geste : élargir d'abord, puis revenir au dossier — revenir en
  // DERNIER, sinon « ce dossier » serait « vérifié » alors qu'on y est déjà.
  const clickOrder = [...SCOPES.filter(v => v !== SCOPES[0]), SCOPES[0]]
  for (const value of clickOrder) {
    // Choisir une portée FERME le menu : il faut le rouvrir avant la suivante.
    if (!(await openScopeMenu())) { console.log(`  note the scope menu did not open before "${value}"`); continue }
    const target = await page.evaluate(v => {
      const el = document.querySelector(`[data-omnibar-scope="${v}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2)
      const cy = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(cx, cy)
      return { cx, cy, hit: at === el || el.contains(at) ? 'self' : (at?.tagName.toLowerCase() ?? 'nothing') }
    }, value)
    if (!target) { console.log(`  note scope "${value}" is not offered (single mailbox, or folded away) — nothing to click`)
      continue }
    check(`the "${value}" menu entry is what a click at its centre would hit`, target.hit === 'self', target.hit)
    searchRequests.length = 0
    const t = Date.now()
    await page.mouse.click(target.cx, target.cy)
    // La portée par défaut ne porte PAS le paramètre (buildSearchHref l'efface).
    const wanted = value === SCOPES[0] ? null : value
    let got = null
    while (Date.now() - t < SCOPE_CLICK_TIMEOUT_MS) {
      got = await scopeState()
      if (got.scope === wanted) break
      await new Promise(r => setTimeout(r, 100))
    }
    const waited = Date.now() - t
    check(`a real mouse click on "${value}" puts it in the URL`, got?.scope === wanted,
      `${SCOPE_P}=${got?.scope ?? '(absent)'} after ${waited} ms, wanted ${wanted ?? '(absent)'}`)
    // Choisir FERME le menu : c'est la demande (« choisir une portée ferme le menu »).
    check(`choosing "${value}" closes the scope menu`, (await page.$(SCOPE_MENU)) === null, 'menu closed')
    // La coche se lit menu ROUVERT — elle n'existe que là, sur l'entrée choisie.
    const checked = (await openScopeMenu()) ? (await scopeState()).pressed : []
    check(`the "${value}" entry alone carries the check mark`,
      checked.length === 1 && checked[0] === value, `checked: ${checked.join(', ') || 'none'}`)
    // Refermer proprement avant la mesure de la liste : le menu ne doit pas rester
    // ouvert par-dessus les résultats qu'on s'apprête à compter.
    await page.keyboard.press('Escape')
    // La navigation ne suffit pas : la LISTE doit effectivement passer dans cette
    // portée. Mesuré sur le rendu, pas sur le réseau — une clé déjà chargée est
    // servie par le cache SWR sans requête, et compter les requêtes déclarerait
    // alors en panne un retour de portée qui marche (mesuré le 20/09/2026 sur
    // « ce dossier », rejoint après la chauffe de l'arm A).
    // Signature observable d'une portée LARGE : chaque résultat dit d'où il vient.
    // On attend les PREMIÈRES lignes de la nouvelle portée, PAS la fin du balayage :
    // une portée large court ~27 s sur ce compte (34 dossiers), et exiger un bandeau
    // au repos ferait échouer ce contrôle sur la DURÉE du balayage, pas sur ce qu'il
    // mesure — le passage de portée (mesuré le 20/09/2026 : « all » toujours en
    // cours à 12 s, donc 0 ligne, alors que l'URL et le segment étaient déjà bons).
    const wide = value !== SCOPES[0]
    let shown = null
    const outcomeDeadline = Date.now() + SCOPE_OUTCOME_BUDGET_MS
    while (Date.now() < outcomeDeadline) {
      shown = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-mail-row]').length,
        origins: document.querySelectorAll('[data-result-folder]').length,
      }))
      if (shown.rows > 0 && (wide ? shown.origins === shown.rows : shown.origins === 0)) break
      await new Promise(r => setTimeout(r, 100))
    }
    check(`the list switches to the "${value}" scope`,
      !!shown && shown.rows > 0 && (wide ? shown.origins === shown.rows : shown.origins === 0),
      `${shown?.rows ?? 0} row(s), ${shown?.origins ?? 0} carrying their origin (wide scope expects one per row, ` +
      `the default scope expects none)`)
    // Le réseau reste RAPPORTÉ, sans être un critère : il distingue une requête
    // neuve d'une réponse servie par le cache, ce qu'un lecteur à froid veut savoir.
    const fired = searchRequests.filter(r => {
      const got = new URL(r.url).searchParams.get(SCOPE_P)
      return wide ? got === value : (got === null || got === value)
    })
    console.log(`  note "${value}": ${fired.length} new search request(s)` +
      `${fired.length === 0 ? ' — served from the SWR cache, key already fetched this run' : ''}`)
  }
  // CONTRÔLE NÉGATIF : un vrai clic sur le fond du header, hors de toute cible, ne
  // doit RIEN changer — sans lui, un banc qui « voit » un changement partout
  // passerait aussi sur un produit qui change de portée au moindre clic.
  const beforeControl = await scopeState()
  const bare = await page.evaluate(() => {
    const header = document.querySelector('header')
    const r = header.getBoundingClientRect()
    // Un point du header qui n'appartient à aucun bouton ni champ.
    for (let x = Math.round(r.left) + 2; x < Math.round(r.right) - 2; x += 4) {
      const y = Math.round(r.top + r.height / 2)
      const at = document.elementFromPoint(x, y)
      if (at && at.tagName === 'HEADER') return { x, y }
    }
    return null
  })
  if (!bare) console.log('  note no bare header point found — negative control skipped')
  else {
    await page.mouse.click(bare.x, bare.y)
    await settle()
    const afterControl = await scopeState()
    check('a real mouse click on bare header background changes no scope',
      afterControl.scope === beforeControl.scope &&
      afterControl.pressed.join(',') === beforeControl.pressed.join(','),
      `${beforeControl.scope ?? '(absent)'}/${beforeControl.pressed.join(',')} → ${afterControl.scope ?? '(absent)'}/${afterControl.pressed.join(',')}`)
  }

  console.log('\nF. read-only guarantee, and where a write WOULD have gone')
  // Chaque écriture est avortée avant d'atteindre le serveur : aucune ne compte
  // comme une violation. Mais ce qu'elle VISAIT est une mesure — ouvrir un
  // résultat d'une autre boîte déclenche un « marquer lu », et c'est exactement
  // là que le défaut du lot S4a envoyait la requête sur la boîte AFFICHÉE.
  console.log(`  ${blockedWrites.length} write(s) captured and aborted: ${blockedWrites.slice(0, 3).join(' | ') || 'none'}`)
  const strayWrites = blockedWrites.filter(w => {
    const m = w.match(/^\S+ (\S+)$/)
    if (!m) return true
    const u = new URL(m[1])
    // Une écriture née du clic de l'arm D : elle doit porter la boîte ET le
    // dossier de la LIGNE, jamais ceux de la boîte active.
    return !(u.searchParams.get('account') === accountOf(foreign) && u.searchParams.get('folder') === folderOf(foreign))
  })
  check('every write the app attempted targets the row\'s own mailbox and folder',
    strayWrites.length === 0,
    strayWrites.slice(0, 3).join(' | ') || `all on ${accountOf(foreign)}/${folderOf(foreign)}`)
} finally {
  // La boîte en panne de l'arm C est retirée QUOI QU'IL ARRIVE — y compris si un
  // contrôle a échoué ou si le banc a jeté : elle ne doit pas survivre au run.
  if (downAccountId && page) {
    const removed = await page.evaluate(async id =>
      (await fetch(`/api/accounts/${id}`, { method: 'DELETE' })).ok, downAccountId).catch(() => false)
    console.log(`\ncleanup: bench mailbox ${downAccountId} ${removed ? 'deleted' : 'NOT deleted — remove it by hand'}`)
    if (!removed) failures.push('the bench could not delete the mailbox it created')
  }
  await browser.close().catch(() => {})
}

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\ncheck-search-accounts-browser: OK')
