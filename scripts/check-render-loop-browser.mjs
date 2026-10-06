#!/usr/bin/env node
/**
 * Mesure que la page /mail, une fois chargée, ne se RE-REND PAS en boucle — à
 * plusieurs tailles de fenêtre, dont celles où la boucle a été vue.
 *
 * Cause mesurée le 06/10/2026 (build de prod et serveur dev, Chrome sans tête) :
 * à 1440×844, 1280×720 et 1536×864 — pas à 1440×900 — `ThinScroll` relançait
 * son effet de mesure après CHAQUE commit : 500 à 800 commits par seconde,
 * processeur saturé, rien de cliquable tant que tout n'était pas chargé, et la
 * navigation « Réglages » annulée par le routeur (lot R7b). Une mise à jour
 * périmée restée dans la file du hook (voie « idle » de React) faisait rendre à
 * l'updater `setThumb(prev => …)` un objet neuf à chaque rejeu de la file.
 *
 * Le banc compte les commits React d'une page au repos (hook
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` posé avant le chargement) pendant
 * `IDLE_MS` à chaque taille : au-delà de `MAX_COMMITS`, c'est une boucle. Il
 * rejoue ensuite le chemin du lot R7b à la taille fautive : clic sur un VRAI
 * dossier de la barre (URL poussée par l'API d'historique, lot R7), menu du
 * compte, « Réglages » → la fenêtre `[data-slot="settings-modal"]` s'ouvre en
 * moins de `OPEN_BUDGET_MS`, à chaque essai, latence émulée `LATENCY_MS`.
 *
 * Tourne contre le serveur dev ou un build de prod (`next start`) ; la boucle se
 * voit sur les deux. Lecture seule : aucune donnée n'est écrite.
 *
 *   SYNAPMAIL_TEST_URL=http://localhost:3111 node scripts/check-render-loop-browser.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** 1440×900 ne bouclait pas : il est là comme témoin. Les trois autres bouclaient. */
const VIEWPORTS = [[1440, 900], [1440, 844], [1280, 720], [1536, 864]]
const IDLE_MS = 3000
/** Une page au repos commet quelques fois (sondages SWR) ; une boucle en fait des centaines. */
const MAX_COMMITS = 20
const LATENCY_MS = 300
const TRIALS = 3
const OPEN_BUDGET_MS = 5000

const constant = (name, re, src, file) => {
  const m = src.match(re)
  if (!m) { console.error(`HARNESS: ${name} illisible dans ${file}`); process.exit(2) }
  return m[1]
}
const MAILBOX_SRC = readFileSync(new URL('../app/(app)/mail/mailboxUrl.ts', import.meta.url), 'utf8')
const FOLDER_PARAM = constant('FOLDER_PARAM', /FOLDER_PARAM = '([^']+)'/, MAILBOX_SRC, 'mailboxUrl.ts')
const DEFAULT_FOLDER = constant('DEFAULT_FOLDER', /DEFAULT_FOLDER = '([^']+)'/, MAILBOX_SRC, 'mailboxUrl.ts')
const MAIL_PATH = constant('MAIL_PATH', /MAIL_PATH = '([^']+)'/, readFileSync(new URL('../lib/compose.ts', import.meta.url), 'utf8'), 'compose.ts')

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const folderRow = path => `[data-sidebar-row="folder:${path}"]`
const MENU_TRIGGER = '[data-user-menu-trigger]'
const MENU_SETTINGS = '[data-user-menu-item="settings"]'
const MODAL = '[data-slot="settings-modal"]'

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
try {
  const page = await browser.newPage()
  // React s'annonce à ce hook au démarrage et l'appelle à chaque commit : c'est le compteur.
  await page.evaluateOnNewDocument(() => {
    window.__commits = 0
    window.__reactSeen = false
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true, inject: () => { window.__reactSeen = true; return 1 },
      onCommitFiberRoot: () => { window.__commits++ },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    }
  })

  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 60000 })
    await page.waitForFunction(
      sel => { const el = document.querySelector(sel); return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$')) },
      { timeout: 60000 }, selector,
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

  const openMail = async () => {
    await page.goto(`${BASE}${MAIL_PATH}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await hydrated(SIDEBAR_ACCOUNT)
    await page.waitForSelector('[data-sidebar-row^="folder:"]', { timeout: 60000 })
  }

  console.log(`\n[repos] commits React en ${IDLE_MS} ms une fois ${MAIL_PATH} chargé (seuil ${MAX_COMMITS})`)
  let worst = null
  for (const [width, height] of VIEWPORTS) {
    await page.setViewport({ width, height })
    await openMail()
    await settle(4000)
    await page.evaluate(() => { window.__commits = 0 })
    await settle(IDLE_MS)
    const commits = await page.evaluate(() => window.__commits)
    const hooked = await page.evaluate(() => window.__reactSeen)
    if (!hooked) { console.error('HARNESS: React ne s’est pas annoncé au hook — le compteur ne compte rien'); process.exit(2) }
    console.log(`  ${width}×${height} : ${commits} commits`)
    if (commits > MAX_COMMITS) failures.push(`(1) ${width}×${height} : ${commits} commits en ${IDLE_MS} ms au repos (> ${MAX_COMMITS}) — boucle de rendu`)
    if (!worst || commits > worst.commits) worst = { width, height, commits }
  }

  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 })
  await page.setViewport({ width: worst.width, height: worst.height })
  await openMail()
  const target = await page.evaluate(inbox =>
    [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
      .find(p => p !== inbox) ?? null, DEFAULT_FOLDER)
  if (!target) { console.error('HARNESS: la barre ne rend aucun dossier hors réception'); process.exit(2) }

  console.log(`\n[clic dossier → menu → Réglages] à ${worst.width}×${worst.height}, latence émulée ${LATENCY_MS} ms, ${TRIALS} essais`)
  const results = []
  for (let i = 0; i < TRIALS; i++) {
    await openMail()
    await realClick(folderRow(target))
    await page.waitForFunction((p, f) => new URL(location.href).searchParams.get(p) === f, { timeout: 25000 }, FOLDER_PARAM, target)
    await settle(2500)
    await realClick(MENU_TRIGGER)
    await page.waitForSelector(MENU_SETTINGS, { timeout: 25000 })
    await settle(300)
    const t0 = Date.now()
    await realClick(MENU_SETTINGS)
    const opened = await page.waitForSelector(MODAL, { timeout: OPEN_BUDGET_MS }).then(() => true).catch(() => false)
    const ms = Date.now() - t0
    results.push(opened ? `${ms}ms` : 'JAMAIS')
    if (!opened) failures.push(`(2) fenêtre des réglages non ouverte en ${OPEN_BUDGET_MS} ms après un clic de dossier (essai ${i + 1} ; URL ${new URL(page.url()).pathname})`)
    await page.keyboard.press('Escape')
    await settle(500)
  }
  console.log(`  ouverte ${results.filter(r => r !== 'JAMAIS').length}/${TRIALS} ; ${results.join(', ')}`)
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-render-loop-browser : ${failures.length} ÉCHEC(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-render-loop-browser : OK')
