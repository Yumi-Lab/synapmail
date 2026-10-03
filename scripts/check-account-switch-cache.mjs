#!/usr/bin/env node
/**
 * Mesure, à la vraie souris, que CHANGER DE BOÎTE hors de la page de courrier puis y
 * arriver ouvre la NOUVELLE boîte — et non l'ancienne lue dans un cache périmé.
 *
 * Le cas (gate T14, point 4) : `switchAccount` (components/layout/AccountAvatar.tsx) écrit
 * la préférence en base, mais la page de courrier, montée APRÈS le clic par `router.push`,
 * lit `active_account_id` dans le cache SWR `/api/settings`. Si ce cache n'est pas mis à
 * jour dans le même geste, la liste part chercher l'ANCIENNE boîte. Le chemin mesuré ici
 * est la palette de l'omnibar depuis les réglages (même `switchAccount` + `router.push`
 * que le bouton « Valider » de l'écran « Fiabilité », sans dépendre d'un tirage d'audit).
 *
 * Lecture seule : seules des requêtes GET de liste sont provoquées ; la préférence de
 * boîte active est remise à sa valeur d'origine à la fin.
 *
 * Demande un serveur qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 *   node scripts/check-account-switch-cache.mjs
 * Contrôle négatif : relancer avec le correctif retiré (`git stash` sur AccountAvatar.tsx)
 * — le banc DOIT alors compter au moins une requête de liste vers l'ancienne boîte.
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
const SEARCH_SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const DEBOUNCE_MS = Number(SEARCH_SRC.match(/SEARCH_DEBOUNCE_MS = (\d+)/)?.[1] ?? 0)
if (!DEBOUNCE_MS) { console.error('HARNESS: SEARCH_DEBOUNCE_MS illisible dans search.ts'); process.exit(2) }
const SETTLE_MS = 800
/** Le temps que la page de courrier ÉMETTE ses requêtes de liste (pas qu'elles répondent). */
const REQUESTS_SETTLE_MS = 6000
/** Le temps laissé à la page de courrier pour émettre sa PREMIÈRE requête de liste : sous
 *  forte charge (load 190, 13 lanes en vérification) le montage dépasse 6 s — 0 requête en
 *  6 s n'est pas un verdict produit, c'est une page pas encore montée (HARNESS). */
const FIRST_REQUEST_MAX_MS = 90000
const OMNIBAR_SEARCH = '[data-omnibar-search]'
const omnibarAccount = id => `[data-omnibar-entry="account:${id}"]`

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
let original = null
let page
try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 25000 })
    await page.waitForFunction(sel => {
      const el = document.querySelector(sel)
      return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$'))
    }, { timeout: 25000 }, selector)
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

  // Toutes les requêtes de LISTE, avec la boîte qu'elles visent.
  const listCalls = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname === '/api/messages' || u.pathname === '/api/tags') {
      listCalls.push({ path: u.pathname, account: u.searchParams.get('account') })
    }
  })

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

  const accounts = await page.evaluate(async base =>
    ((await (await fetch(`${base}/api/accounts`)).json()).data ?? []).map(a => ({ id: a.id, email: a.email, isDefault: a.isDefault })), BASE)
  // La page de courrier, avant de lire la préférence, retombe sur la boîte par défaut (sinon
  // la première) : cette requête-là est antérieure au lot et n'est pas ce qu'on mesure. Les
  // deux boîtes du banc sont donc prises HORS de ce repli.
  const fallback = accounts.find(a => a.isDefault) ?? accounts[0]
  const candidates = accounts.filter(a => a.id !== fallback?.id)
  if (candidates.length < 2) { console.error(`HARNESS: ${accounts.length} boîte(s) — il en faut 3 (repli + ancienne + nouvelle)`); process.exit(2) }
  const [from, to] = candidates
  original = await page.evaluate(async base => (await (await fetch(`${base}/api/settings`)).json()).data?.active_account_id ?? null, BASE)

  // Boîte active = l'ANCIENNE, puis une page hors courrier (son cache /api/settings la porte).
  await page.evaluate(async ({ base, id }) => fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active_account_id: id }),
  }), { base: BASE, id: from.id })
  await page.goto(`${BASE}/settings/profile`, { waitUntil: 'domcontentloaded' })
  await hydrated(OMNIBAR_SEARCH)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  listCalls.length = 0

  console.log(`\nboîtes : ${from.email} → ${to.email} (repli hors mesure : ${fallback?.email})`)
  await realClick(OMNIBAR_SEARCH)
  await page.type(OMNIBAR_SEARCH, to.email, { delay: 25 })
  // Le clic part AVANT que la frappe ne soit soumise comme recherche : passé le débounce,
  // l'omnibar navigue elle-même vers /mail?q=… et le banc mesurerait alors une page de
  // courrier montée AVANT le changement de boîte (qui lit, à bon droit, l'ancienne).
  await new Promise(r => setTimeout(r, DEBOUNCE_MS / 4))
  const before = await page.evaluate(() => location.pathname)
  if (before === '/mail') { console.error(`HARNESS: déjà sur /mail avant le clic (débounce ${DEBOUNCE_MS} ms dépassé)`); process.exit(2) }
  await realClick(omnibarAccount(to.id))
  await page.waitForFunction(() => location.pathname === '/mail', { timeout: 25000 })
  for (const t0 = Date.now(); !listCalls.length; await new Promise(r => setTimeout(r, 250))) {
    if (Date.now() - t0 > FIRST_REQUEST_MAX_MS) { console.error(`HARNESS: aucune requête de liste émise en ${FIRST_REQUEST_MAX_MS} ms — page de courrier pas montée`); process.exit(2) }
  }
  await new Promise(r => setTimeout(r, REQUESTS_SETTLE_MS))

  const toOld = listCalls.filter(c => c.account === from.id)
  const toNew = listCalls.filter(c => c.account === to.id)
  const saved = await page.evaluate(async base => (await (await fetch(`${base}/api/settings`)).json()).data?.active_account_id ?? null, BASE)
  console.log(`  URL                       : ${page.url().replace(BASE, '')}`)
  console.log(`  requêtes de liste         : ${listCalls.length}`)
  for (const c of listCalls) console.log(`    ${c.path} account=${c.account === from.id ? 'ANCIENNE' : c.account === to.id ? 'nouvelle' : c.account}`)
  console.log(`  vers l'ANCIENNE boîte     : ${toOld.length}`)
  console.log(`  vers la NOUVELLE boîte    : ${toNew.length}`)
  console.log(`  préférence en base        : ${saved === to.id ? 'nouvelle' : saved === from.id ? 'ANCIENNE' : saved}`)
  if (toOld.length) failures.push(`${toOld.length} requête(s) de liste vers l'ancienne boîte ${from.email} après le changement`)
  if (!toNew.length) failures.push(`aucune requête de liste vers la nouvelle boîte ${to.email}`)
  if (saved !== to.id) failures.push(`la préférence en base n'est pas la nouvelle boîte (${saved})`)
} finally {
  if (page && original !== undefined) {
    await page.evaluate(async ({ base, id }) => fetch(`${base}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active_account_id: id }),
    }), { base: BASE, id: original }).catch(() => {})
  }
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`check-account-switch-cache : ${failures.length} ÉCHEC(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-account-switch-cache : OK')
