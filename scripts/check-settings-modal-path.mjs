#!/usr/bin/env node
/**
 * Mesure le bug du 04/10/2026 : « j'ouvre Réglages → Comptes → Ajouter un compte →
 * Gmail, et la fenêtre repart toute seule sur Profil » (vu en prod, URL
 * `/mail?q=nicolas%403d-expert.fr`, fenêtre restée OUVERTE, rail sur Profil).
 *
 * Deux causes, deux mesures :
 *
 *  1. La fenêtre des réglages déduisait son onglet de N'IMPORTE QUEL chemin :
 *     `/mail` donnait un segment vide, et le repli `|| 'profile'` en faisait
 *     « Profil ». Une URL qui quitte les réglages par l'API d'historique (donc
 *     SANS navigation : rien ne démonte la fenêtre) la faisait sauter sur un
 *     onglet que l'URL ne nomme pas, en effaçant l'assistant en cours.
 *     → hors des réglages, la fenêtre doit SE RETIRER, jamais afficher Profil.
 *
 *  2. La frappe différée de l'omnibar (400 ms) survivait au changement de vue :
 *     le minuteur tombait depuis les réglages avec le `pathname` capturé avant,
 *     prenait la branche « seuls des paramètres changent » et réécrivait
 *     `/mail?q=…` dans la barre d'adresse.
 *     → une frappe abandonnée en quittant la boîte ne doit plus toucher l'URL.
 *
 * Échoue (code 1) sur l'un ou l'autre. Code 2 = erreur de BANC (navigateur absent,
 * serveur injoignable, base sans boîte) — ça ne dit rien du produit.
 *
 * Rien n'est jamais créé : toute requête POST /api/accounts est interceptée et
 * avortée avant de quitter le navigateur.
 *
 * Demande un serveur lancé et les identifiants SYNAPMAIL_TEST_* (voir .env).
 *   node scripts/check-settings-modal-path.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
const MODAL = '[data-slot="settings-modal"]'
/** La racine des réglages — le banc la relit comme le produit (components/settings/SettingsSidebar.tsx). */
const SETTINGS_ROOT = '/settings'
/** La recherche qui a révélé le bug : une adresse, portée par défaut (« ce dossier »). */
const QUERY = 'nicolas@3d-expert.fr'
/** Repos laissé à un rendu après un geste. Au-delà, c'est le produit qui est lent. */
const SETTLE_MS = 1200
/** Débounce de la frappe de l'omnibar (lib/search.ts SEARCH_DEBOUNCE_MS) + marge. */
const DEBOUNCE_MS = 400
const DEBOUNCE_MARGIN_MS = 1200

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
} = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD,
})) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const failures = []
const ok = msg => console.log(`ok   ${msg}`)
const fail = msg => { failures.push(msg); console.log(`FAIL ${msg}`) }
const check = (cond, msg) => (cond ? ok(msg) : fail(msg))
const settle = (ms = SETTLE_MS) => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  .catch(e => { console.error(`HARNESS: cannot launch Chrome — ${e.message}`); process.exit(2) })

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  await page.setRequestInterception(true)
  page.on('request', req => {
    // Aucun compte ne peut être créé par ce banc, quoi que l'écran demande.
    if (req.method() === 'POST' && /\/api\/accounts$/.test(req.url())) { req.abort('failed').catch(() => {}); return }
    req.continue().catch(() => {})
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
  if (!loggedIn) { console.error('HARNESS: credentials login failed'); process.exit(2) }

  /** Ce que l'écran DIT : le chemin, si la fenêtre est là, quel panneau, quel onglet allumé. */
  const read = () => page.evaluate(sel => {
    const m = document.querySelector(sel)
    const txt = m ? (m.textContent || '').replace(/\s+/g, ' ').replace(/^Paramètres.*?Clés API/, '') : ''
    const rail = m ? [...m.querySelectorAll('nav a')].find(a => /violet/.test(a.className)) : null
    return {
      path: location.pathname,
      search: location.search,
      open: !!m,
      profile: /^Profil/.test(txt),
      wizard: /imap\.gmail\.com/.test(txt),
      tab: rail ? rail.textContent.trim() : null,
    }
  }, MODAL)

  const clickInModal = async (text, sel = 'button, a') => {
    for (const el of await page.$$(`${MODAL} ${sel}`)) {
      const txt = await page.evaluate(e => (e.textContent || '').trim().toLowerCase(), el)
      if (!txt.includes(text.toLowerCase())) continue
      // La fenêtre défile : viser une cible hors de sa boîte clique le fond et la ferme.
      await page.evaluate(e => e.scrollIntoView({ block: 'center' }), el)
      await settle(200)
      await el.click()
      return true
    }
    return false
  }

  /** Réglages → Comptes → Ajouter un compte → Gmail, par le chemin de l'utilisateur. */
  const openGmailWizard = async () => {
    await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
    await settle(3000)
    const trigger = await page.$('[data-user-menu-trigger]')
    if (!trigger) { console.error('HARNESS: no user menu in the header'); process.exit(2) }
    await trigger.click(); await settle(400)
    const entry = await page.$('[data-user-menu-item="settings"]')
    if (!entry) { console.error('HARNESS: no settings entry in the user menu'); process.exit(2) }
    await entry.click()
    await page.waitForSelector(MODAL, { timeout: 30000 })
      .catch(() => { console.error('HARNESS: the settings window never opened'); process.exit(2) })
    await settle(1500)
    if (!(await clickInModal('comptes', 'a'))) { console.error('HARNESS: no "Comptes" tab'); process.exit(2) }
    await settle(1800)
    if (!(await clickInModal('ajouter'))) { console.error('HARNESS: no "Ajouter un compte" button'); process.exit(2) }
    await settle()
    for (const el of await page.$$(`${MODAL} button`)) {
      if (/gmail/i.test(await page.evaluate(e => e.textContent || '', el))) { await el.click(); await settle(); return }
    }
    console.error('HARNESS: no Gmail card in the provider grid'); process.exit(2)
  }

  // ── 1. L'URL quitte les réglages sans navigation : la fenêtre se retire ────────
  await openGmailWizard()
  const before = await read()
  check(before.open && before.wizard, `l'assistant Gmail est ouvert (chemin ${before.path})`)
  await page.evaluate(q => window.history.replaceState(null, '', `/mail?q=${encodeURIComponent(q)}`), QUERY)
  await settle()
  const after = await read()
  check(!after.profile, `URL hors réglages : la fenêtre n'affiche PAS Profil (panneau=${after.profile ? 'Profil' : after.wizard ? 'assistant' : 'autre'}, onglet=${after.tab})`)
  check(!after.open, `URL hors réglages (${after.path}) : la fenêtre des réglages s'est retirée`)

  // ── 2. Une frappe abandonnée ne réécrit plus l'URL ────────────────────────────
  // On tape dans l'omnibar puis on part dans les réglages AVANT que le débounce tombe :
  // le minuteur ne doit plus ramener l'adresse sur /mail.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await settle(3000)
  const field = await page.$('[data-omnibar-search-field] input') ?? await page.$('[data-omnibar-search-field]')
  if (!field) { console.error('HARNESS: no omnibar search field'); process.exit(2) }
  await field.click()
  await page.keyboard.type(QUERY, { delay: 10 })
  // Même geste que l'utilisateur : ouvrir les réglages juste après la frappe.
  const menu = await page.$('[data-user-menu-trigger]')
  await menu.click()
  const entry = await page.$('[data-user-menu-item="settings"]')
  await entry.click()
  await page.waitForSelector(MODAL, { timeout: 30000 })
    .catch(() => { console.error('HARNESS: the settings window never opened'); process.exit(2) })
  await settle(DEBOUNCE_MS + DEBOUNCE_MARGIN_MS)
  const late = await read()
  check(late.path.startsWith(SETTINGS_ROOT),
    `frappe abandonnée : l'adresse reste dans les réglages — lue « ${late.path}${late.search} »`)
  check(late.open, `la fenêtre des réglages est toujours ouverte (onglet=${late.tab})`)

  await page.close()
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} écart(s)` : '\nconforme')
process.exit(failures.length ? 1 : 0)
