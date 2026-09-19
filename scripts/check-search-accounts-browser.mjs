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
const ORIGIN_SRC = readFileSync(new URL('../lib/mailOrigin.ts', import.meta.url), 'utf8')
const ORIGIN_ATTR = ORIGIN_SRC.match(/MAIL_ORIGIN_ATTR = '([^']+)'/)?.[1]
// Le libellé « Arrêter » vient de la locale livrée, pas d'une chaîne recopiée.
const FR = JSON.parse(readFileSync(new URL('../locales/fr.json', import.meta.url), 'utf8'))
const STOP_LABEL = FR.mail?.searchStop
for (const [k, v] of Object.entries({ Q_PARAM, SCOPE_P, SCOPE_ACC, ORIGIN_ATTR, STOP_LABEL })) {
  if (!v) { console.error(`HARNESS: could not read ${k} from the shipped modules`); process.exit(2) }
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
  await page.evaluate(label => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === label)
    b?.click()
  }, STOP_LABEL)
  await settle()
  const justAfter = await snap()
  await new Promise(r => setTimeout(r, GROWTH_WINDOW_MS))
  const later = await snap()
  const grewAfterStop = later.rows - justAfter.rows
  console.log(`  rows ${before.rows} → ${running.rows} while running (+${grewWhileRunning} in ${GROWTH_WINDOW_MS} ms), ` +
    `${justAfter.rows} → ${later.rows} after Stop (+${grewAfterStop})`)
  check('the Stop button disappears once pressed', justAfter.stop === false, `stop=${justAfter.stop}`)
  check('no further result arrives after Stop', grewAfterStop === 0,
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
    const shot = await page.evaluate(([minGap, scopeAcc]) => {
      const boxes = [...document.querySelectorAll('header [data-omnibar-menu], header [data-omnibar-action], header [data-mail-toolbar-more], header [data-omnibar-search], header [data-user-menu-trigger], header [data-omnibar-scope]')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(b => b.r.width > 0 && b.r.height > 0)
      let worst = Infinity
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r
          const gapX = Math.max(a.left, b.left) - Math.min(a.right, b.right)
          const gapY = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)
          worst = Math.min(worst, Math.max(gapX, gapY))
        }
      }
      const scopes = [...document.querySelectorAll('[data-omnibar-scope]')]
        .filter(el => el.getBoundingClientRect().width > 0)
      const header = document.querySelector('header')?.getBoundingClientRect() ?? null
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        scopes: scopes.length,
        hasAccountsScope: scopes.some(el => el.dataset.omnibarScope === scopeAcc),
        scopeRight: scopes.at(-1)?.getBoundingClientRect().right ?? null,
        headerRight: header?.right ?? null,
        worstGap: worst === Infinity ? null : worst,
        minGap,
      }
    }, [MIN_HIT_GAP_PX, SCOPE_ACC])
    console.log(`  ${width}px: scope buttons=${shot.scopes} (all-mailboxes shown=${shot.hasAccountsScope}) ` +
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
      check(`no two header targets overlap at ${width}px`,
        shot.worstGap === null || shot.worstGap >= MIN_HIT_GAP_PX,
        `closest pair ${shot.worstGap?.toFixed(2)}px, floor ${MIN_HIT_GAP_PX}px`)
    }
  }

  console.log('\nF. read-only guarantee on mail')
  check('no mutating request reached the messages API', blockedWrites.length === 0,
    blockedWrites.slice(0, 3).join(' | ') || 'none')
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
