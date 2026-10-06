#!/usr/bin/env node
/**
 * Mesure le lot R7b sur l'application qui tourne, à la VRAIE souris : ouvrir le
 * menu du compte puis cliquer « Réglages » OUVRE la fenêtre des réglages, à chaque
 * fois, quel que soit le délai entre les deux clics.
 *
 * Cause mesurée le 06/10/2026 (staging, Chrome réel) : à l'ouverture du menu, le
 * lien « Réglages » PRÉCHARGEAIT `/settings` (`_rsc` + `next-router-prefetch: 1`) ;
 * un clic pendant ce préchargement réutilisait la réponse en vol — faite sans
 * l'en-tête qui active la route INTERCEPTÉE `@modal/(.)settings` — et la
 * navigation ne se terminait jamais. D'où la latence émulée (300 ms) et les
 * délais 0 / 300 / 1000 / 3000 ms : le clic tombe pendant, juste après et bien
 * après un préchargement. Depuis /mail ET depuis un dossier atteint par clic
 * (l'URL poussée par l'API d'historique, chemin du lot R7).
 *
 * Critères : (1) aucun préchargement de /settings à l'ouverture du menu ;
 * (2) la fenêtre `[data-slot="settings-modal"]` s'ouvre en < 5 s à CHAQUE essai.
 *
 * Le préchargement de `next/link` n'existe qu'en BUILD DE PRODUCTION : ce banc
 * se lance contre `next start`, pas contre le serveur dev (HARNESS sinon).
 * Lecture seule : aucune donnée n'est écrite.
 *
 *   SYNAPMAIL_TEST_URL=http://localhost:3111 node scripts/check-settings-open-browser.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Latence émulée : un préchargement dure au moins ça, le clic à 0 et 300 ms tombe dedans. */
const LATENCY_MS = 300
const DELAYS_MS = [0, 300, 1000, 3000]
const TRIALS = 5
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
const SETTINGS_ROOT = constant('SETTINGS_ROOT', /SETTINGS_ROOT = '([^']+)'/, readFileSync(new URL('../components/settings/SettingsSidebar.tsx', import.meta.url), 'utf8'), 'SettingsSidebar.tsx')

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

  // Toutes les requêtes `_rsc` vers /settings, préchargement ou navigation.
  let prefetches = [], navigations = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname !== SETTINGS_ROOT || !u.searchParams.has('_rsc')) return
    if (req.headers()['next-router-prefetch']) prefetches.push(u.search); else navigations.push(u.search)
  })
  const reset = () => { prefetches = []; navigations = [] }

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

  const isDev = await page.evaluate(async base => {
    const html = await (await fetch(`${base}/login`)).text()
    return html.includes('/_next/static/chunks/webpack.js') || html.includes('react-refresh')
  }, BASE)
  if (isDev) { console.error('HARNESS: serveur de développement — `next/link` n’y précharge pas, lancer contre `next start`'); process.exit(2) }

  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY_MS, downloadThroughput: -1, uploadThroughput: -1 })

  const openMail = async () => {
    await page.goto(`${BASE}${MAIL_PATH}`, { waitUntil: 'domcontentloaded' })
    await hydrated(SIDEBAR_ACCOUNT)
    await page.waitForSelector('[data-sidebar-row^="folder:"]', { timeout: 25000 })
  }
  await openMail()
  const target = await page.evaluate(inbox =>
    [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
      .find(p => p !== inbox) ?? null, DEFAULT_FOLDER)
  if (!target) { console.error('HARNESS: la barre ne rend aucun dossier hors réception'); process.exit(2) }

  const starts = [
    { label: MAIL_PATH, prepare: openMail },
    { label: `${MAIL_PATH}?${FOLDER_PARAM}=${target} (par clic)`, prepare: async () => {
      await openMail()
      await realClick(folderRow(target))
      await page.waitForFunction((p, f) => new URL(location.href).searchParams.get(p) === f, { timeout: 25000 }, FOLDER_PARAM, target)
    } },
  ]

  console.log(`\nlatence émulée ${LATENCY_MS} ms ; ${TRIALS} essais × délais ${DELAYS_MS.join('/')} ms × 2 points de départ`)
  for (const start of starts) {
    console.log(`\n[depuis ${start.label}]`)
    for (const delay of DELAYS_MS) {
      const results = []
      for (let i = 0; i < TRIALS; i++) {
        await start.prepare()
        reset()
        await realClick(MENU_TRIGGER)
        await page.waitForSelector(MENU_SETTINGS, { timeout: 25000 })
        await settle(delay)
        const prefetched = prefetches.length
        const t0 = Date.now()
        await realClick(MENU_SETTINGS)
        const opened = await page.waitForSelector(MODAL, { timeout: OPEN_BUDGET_MS }).then(() => true).catch(() => false)
        const ms = Date.now() - t0
        results.push({ opened, ms, prefetched, navigated: navigations.length })
        if (prefetched) failures.push(`(1) préchargement de ${SETTINGS_ROOT} à l'ouverture du menu (depuis ${start.label}, délai ${delay} ms, essai ${i + 1})`)
        if (!opened) failures.push(`(2) fenêtre non ouverte en ${OPEN_BUDGET_MS} ms (depuis ${start.label}, délai ${delay} ms, essai ${i + 1} ; URL ${new URL(page.url()).pathname})`)
      }
      const ok = results.filter(r => r.opened).length
      console.log(`  délai ${String(delay).padStart(4)} ms : ouverte ${ok}/${TRIALS} ; ${results.map(r => `${r.opened ? r.ms + 'ms' : 'JAMAIS'}${r.prefetched ? '·préch' : ''}${r.navigated ? '·nav' : ''}`).join(', ')}`)
    }
  }
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-settings-open-browser : ${failures.length} ÉCHEC(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-settings-open-browser : OK')
