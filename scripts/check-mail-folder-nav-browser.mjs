#!/usr/bin/env node
/**
 * Mesure le lot R7 sur l'application qui tourne, à la VRAIE souris : le courrier
 * ne charge que ce qui est à l'écran.
 *
 *   (a) ouvrir /mail n'émet AUCUNE requête `_rsc` vers /mail (le préchargement
 *       automatique de chaque lien de dossier de la barre) ;
 *   (b) cliquer un dossier n'émet AUCUNE requête `_rsc` et la liste du dossier arrive ;
 *   (c) exactement UNE requête de liste `/api/messages` par ouverture, à la taille
 *       de page des réglages (pas au repli 30) ;
 *   (d) le retour arrière ramène au dossier précédent, sans rechargement.
 *
 * Le préchargement de `next/link` n'existe qu'en BUILD DE PRODUCTION (en dev il
 * est coupé) : ce banc se lance contre `next start`, pas contre le serveur dev —
 * sur un serveur dev, (a) et (b) sont verts quel que soit le code, et le banc le
 * dit (HARNESS) au lieu de passer pour vert.
 *
 * Lecture seule sur les boîtes : seules des requêtes GET de liste sont provoquées.
 * Il écrit la taille de page de l'utilisateur de test (pour que (c) distingue la
 * bonne taille du repli) et la REMET telle qu'elle était.
 *
 * Demande un serveur de production qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 *   SYNAPMAIL_TEST_URL=http://localhost:3111 node scripts/check-mail-folder-nav-browser.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

const CONTRACT = readFileSync(new URL('../app/(app)/mail/mailboxUrl.ts', import.meta.url), 'utf8')
const constant = (name, re, src = CONTRACT, file = 'mailboxUrl.ts') => {
  const m = src.match(re)
  if (!m) { console.error(`HARNESS: ${name} illisible dans ${file}`); process.exit(2) }
  return m[1]
}
const FOLDER_PARAM = constant('FOLDER_PARAM', /FOLDER_PARAM = '([^']+)'/)
const DEFAULT_FOLDER = constant('DEFAULT_FOLDER', /DEFAULT_FOLDER = '([^']+)'/)
const MAIL_PATH = constant('MAIL_PATH', /MAIL_PATH = '([^']+)'/, readFileSync(new URL('../lib/compose.ts', import.meta.url), 'utf8'), 'compose.ts')
const SIDEBAR_SRC = readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8')
const ACTIVE_TOKEN = constant('ROW_ACTIVE', /ROW_ACTIVE = cn\(ACCENT\.(\w+),/, SIDEBAR_SRC, 'Sidebar.tsx')
const AVATAR_SRC = readFileSync(new URL('../components/layout/AccountAvatar.tsx', import.meta.url), 'utf8')
const ACTIVE_MARKER = constant('ACCENT.' + ACTIVE_TOKEN, new RegExp(`\\b${ACTIVE_TOKEN}: '([^']+)'`), AVATAR_SRC, 'AccountAvatar.tsx')
// Le repli que le lot retire : lu dans la route des réglages, pas retapé.
const SETTINGS_SRC = readFileSync(new URL('../app/api/settings/route.ts', import.meta.url), 'utf8')
const DEFAULT_PER_PAGE = Number(constant('messages_per_page', /messages_per_page: (\d+),/, SETTINGS_SRC, 'settings/route.ts'))
/** Une taille ≠ du repli : la requête à la bonne taille se distingue de celle au repli. */
const TEST_PER_PAGE = DEFAULT_PER_PAGE + 20

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const folderRow = path => `[data-sidebar-row="folder:${path}"]`
/** Une liste sur un vrai compte IONOS : large, et mesuré, pas deviné. */
const LIST_SETTLE_MS = 12000

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigné`); process.exit(2) }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
const failures = []
let savedPerPage = null
let page
try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 25000 })
    await page.waitForFunction(
      sel => { const el = document.querySelector(sel); return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$')) },
      { timeout: 25000 }, selector,
    )
  }
  const realClick = async (selector) => {
    await hydrated(selector)
    const box = await page.$eval(selector, el => {
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
    })
    if (box.w === 0 || box.h === 0) { console.error(`HARNESS: ${selector} est rendu avec une taille nulle`); process.exit(2) }
    await page.mouse.click(box.x, box.y)
  }
  const settle = ms => new Promise(r => setTimeout(r, ms))

  // Toutes les requêtes, classées : préchargements `_rsc` de la page du courrier,
  // et requêtes de LISTE (`/api/messages` seul — ni search, ni thread, ni [id]).
  let rsc = [], lists = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname === MAIL_PATH && u.searchParams.has('_rsc')) rsc.push(u.search)
    if (u.pathname === '/api/messages') lists.push({ folder: u.searchParams.get(FOLDER_PARAM), perPage: u.searchParams.get('perPage'), page: u.searchParams.get('page') })
  })
  const reset = () => { rsc = []; lists = [] }

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) { console.error('HARNESS: connexion refusée'); process.exit(2) }

  // Un serveur de DEV ne précharge jamais : le banc ne mesurerait rien sur (a)/(b).
  const isDev = await page.evaluate(async base => {
    const html = await (await fetch(`${base}/login`)).text()
    return html.includes('/_next/static/chunks/webpack.js') || html.includes('react-refresh')
  }, BASE)
  if (isDev) { console.error('HARNESS: serveur de développement — `next/link` n’y précharge pas, lancer contre `next start`'); process.exit(2) }

  // Taille de page ≠ repli, remise à la fin.
  const settings = await page.evaluate(async (base, n) => {
    const before = (await (await fetch(`${base}/api/settings`)).json()).data
    const res = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages_per_page: n }) })
    return { before: before?.messages_per_page ?? null, ok: res.ok }
  }, BASE, TEST_PER_PAGE)
  if (!settings.ok) { console.error('HARNESS: impossible d’écrire messages_per_page'); process.exit(2) }
  savedPerPage = settings.before

  const activeFolderRows = async () => page.evaluate(marker =>
    [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
      .filter(el => el.className.includes(marker))
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length)),
    ACTIVE_MARKER)

  // --- (a) + (c) : ouverture de /mail ---
  reset()
  await page.goto(`${BASE}${MAIL_PATH}?${FOLDER_PARAM}=${encodeURIComponent(DEFAULT_FOLDER)}`, { waitUntil: 'domcontentloaded' })
  await hydrated(SIDEBAR_ACCOUNT)
  await page.waitForSelector('[data-sidebar-row^="folder:"]', { timeout: 25000 })
  await settle(LIST_SETTLE_MS)
  const folderCount = await page.$$eval('[data-sidebar-row^="folder:"]', els => els.length)
  const firstLists = lists.filter(l => l.page === '1')
  console.log(`\n[ouverture] ${folderCount} dossiers dans la barre`)
  console.log(`  requêtes _rsc vers ${MAIL_PATH} : ${rsc.length}`)
  console.log(`  requêtes de liste (page 1)  : ${firstLists.length} → ${firstLists.map(l => `${l.folder}@${l.perPage}`).join(', ') || '(aucune)'}`)
  if (rsc.length !== 0) failures.push(`(a) ${rsc.length} requête(s) _rsc à l'ouverture (préchargement des dossiers)`)
  if (firstLists.length !== 1) failures.push(`(c) ${firstLists.length} requête(s) de liste à l'ouverture, attendu 1`)
  if (!firstLists.every(l => l.perPage === String(TEST_PER_PAGE))) failures.push(`(c) une requête de liste au repli ${DEFAULT_PER_PAGE} au lieu de ${TEST_PER_PAGE}`)

  // --- (b) : clic sur un dossier ---
  const target = await page.evaluate(inbox =>
    [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
      .find(p => p !== inbox) ?? null, DEFAULT_FOLDER)
  if (!target) { console.error('HARNESS: la barre ne rend aucun dossier hors réception'); process.exit(2) }
  await page.evaluate(() => { window.__r7_alive = true })
  reset()
  await realClick(folderRow(target))
  await settle(LIST_SETTLE_MS)
  const afterClick = new URL(page.url())
  const clickLists = lists.filter(l => l.folder === target)
  console.log(`\n[clic « ${target} »] URL ${afterClick.search}`)
  console.log(`  requêtes _rsc : ${rsc.length} ; listes vers le dossier : ${clickLists.length}`)
  if (afterClick.searchParams.get(FOLDER_PARAM) !== target) failures.push(`(b) le clic n'a pas porté (URL ${afterClick.search})`)
  if (rsc.length !== 0) failures.push(`(b) ${rsc.length} requête(s) _rsc au clic sur un dossier`)
  if (clickLists.length < 1) failures.push(`(b) aucune requête de liste vers « ${target} »`)
  const highlighted = await activeFolderRows()
  if (!highlighted.includes(target)) failures.push(`(b) la barre n'allume pas « ${target} » (${highlighted.join(', ') || 'rien'})`)

  // --- (d) : retour arrière ---
  reset()
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(LIST_SETTLE_MS)
  const afterBack = new URL(page.url())
  const alive = await page.evaluate(() => window.__r7_alive === true)
  const backRows = await activeFolderRows()
  console.log(`\n[retour] URL ${afterBack.search} ; page conservée : ${alive} ; _rsc : ${rsc.length} ; surbrillance : ${backRows.join(', ') || '(aucune)'}`)
  if (afterBack.searchParams.get(FOLDER_PARAM) !== DEFAULT_FOLDER) failures.push(`(d) le retour n'a pas ramené à ${DEFAULT_FOLDER} (${afterBack.search})`)
  if (!alive) failures.push('(d) le retour a rechargé la page')
  if (!backRows.includes(DEFAULT_FOLDER)) failures.push(`(d) la barre n'allume pas ${DEFAULT_FOLDER} après le retour`)
} finally {
  if (page && savedPerPage !== null) {
    await page.evaluate(async (base, n) => {
      await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages_per_page: n }) })
    }, BASE, savedPerPage).catch(() => {})
  }
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-mail-folder-nav-browser : ${failures.length} ÉCHEC(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-mail-folder-nav-browser : OK')
