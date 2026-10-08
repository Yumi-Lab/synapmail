#!/usr/bin/env node
/**
 * Mesure le lot H4a sur un serveur qui tourne, dans un VRAI navigateur : la section
 * d'identite de l'instance (nom et icone de l'onglet) se REND dans Reglages ->
 * Apparence pour un administrateur, n'y rend RIEN de plus pour un non-administrateur,
 * n'existe plus qu'a cet endroit (la page d'administration ne la porte plus), et le
 * lien de la navigation y conduit VRAIMENT -- l'ancre amene la section a l'ecran.
 *
 * Le role du compte de banc est pilote par le banc lui-meme (les DEUX cotes de la
 * garde sont mesures) et remis exactement comme il l'a trouve dans le `finally`.
 *
 * Sortie 0 si tout tient, 1 sur un echec PRODUIT, 2 sur une erreur de BANC -- pas de
 * navigateur, serveur injoignable, compte de banc absent -- qui ne dit rien du produit.
 *   node --experimental-strip-types scripts/check-appearance-branding-live.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import puppeteer from 'puppeteer-core'
/**
 * Les constantes sont LUES dans les sources qui les portent, et non recopiees ici :
 * un banc qui reecrirait l'ancre ou le chemin cesserait de mesurer le produit le jour
 * ou le produit changerait. (Node ne sait pas importer un `.tsx`, d'ou la lecture.)
 */
const literal = (file, name) => {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const m = src.match(new RegExp(`export const ${name} = '([^']+)'`))
  if (!m) { console.error(`HARNESS: ${name} introuvable dans ${file}`); process.exit(2) }
  return m[1]
}
const BRANDING_ANCHOR = literal('components/admin/BrandingSection.tsx', 'BRANDING_ANCHOR')
const APPEARANCE_HREF = literal('components/settings/SettingsSidebar.tsx', 'APPEARANCE_HREF')
const ADMIN_HREF = literal('components/settings/SettingsSidebar.tsx', 'ADMIN_HREF')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
const SETTLE_MS = 600
/** Marge sous le haut du panneau : `scroll-mt-16` vaut 4rem, soit 64 px. */
const ANCHOR_TOP_MAX_PX = 64

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const {
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
} = process.env
for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
})) {
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigne`); process.exit(2) }
}

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`ok   ${msg}`)
  else { failures.push(msg); console.log(`FAIL ${msg}`) }
}

if (!existsSync(CHROME)) { console.error('HARNESS: pas de navigateur'); process.exit(2) }
const db = new pg.Client({ connectionString: DB_URL })
let browser
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
} catch (e) { console.error(`HARNESS: navigateur — ${e.message}`); process.exit(2) }

const login = async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' })
  return page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
}

/** La section est-elle presente ET visible (pas seulement dans le DOM) ? */
const sectionSeen = (page) => page.evaluate((anchor) => {
  const el = document.getElementById(anchor)
  if (!el) return { present: false, visible: false, top: null }
  const r = el.getBoundingClientRect()
  return { present: true, visible: r.width > 0 && r.height > 0, top: r.top }
}, BRANDING_ANCHOR)

const setRole = (role) => db.query('UPDATE users SET role = $1 WHERE email = $2', [role, EMAIL])
/** Le role trouve au depart, remis tel quel quoi qu'il arrive. */
let originalRole = null
let page

try {
  await db.connect().catch(e => { console.error(`HARNESS: base — ${e.message}`); process.exit(2) })
  const bench = await db.query('SELECT role FROM users WHERE email = $1', [EMAIL])
  if (!bench.rows.length) { console.error('HARNESS: le compte de banc n\'existe pas'); process.exit(2) }
  originalRole = bench.rows[0].role

  page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  console.log('== administrateur : la section se rend DANS Apparence ==')
  // Le role entre dans le jeton A LA CONNEXION (`lib/auth.ts`) : le poser APRES se
  // connecter mesurerait le role precedent, pas celui qu'on croit tester.
  await setRole('admin')
  if (!(await login(page))) { console.error('HARNESS: connexion refusee'); process.exit(2) }
  await page.goto(`${BASE}${APPEARANCE_HREF}`, { waitUntil: 'networkidle2' })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const asAdmin = await sectionSeen(page)
  check(asAdmin.present, 'la section d\'identite est dans la page Apparence')
  check(asAdmin.visible, 'elle y est visible a l\'ecran (largeur et hauteur non nulles)')
  // Le champ du nom et le choix de fichier sont bien la : c'est ce que Nicolas cherchait.
  const controls = await page.evaluate(() => ({
    name: !!document.getElementById('branding-name'),
    file: !!document.querySelector('input[type="file"]'),
  }))
  check(controls.name, 'le champ du nom de l\'onglet y est')
  check(controls.file, 'le choix de l\'icone y est')

  console.log('== l\'ancre de la navigation amene la section a l\'ecran ==')
  await page.goto(`${BASE}${APPEARANCE_HREF}#${BRANDING_ANCHOR}`, { waitUntil: 'networkidle2' })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const anchored = await sectionSeen(page)
  check(anchored.visible, 'arrive par l\'ancre, la section est a l\'ecran')
  check(anchored.top !== null && anchored.top >= 0 && anchored.top <= VIEWPORT.height,
    `son haut est dans la fenetre (top=${anchored.top === null ? 'absent' : Math.round(anchored.top)} px)`)

  console.log('== la page d\'administration ne la porte PLUS (une seule copie) ==')
  await page.goto(`${BASE}${ADMIN_HREF}`, { waitUntil: 'networkidle2' })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const onAdmin = await sectionSeen(page)
  check(!onAdmin.present, 'la section n\'est plus rendue dans Administration')

  console.log('== non-administrateur : rien de plus dans Apparence ==')
  await setRole('user')
  // La session porte le role : la relire depuis zero, sinon on mesurerait l'ancienne.
  await page.deleteCookie(...(await page.cookies()))
  if (!(await login(page))) { console.error('HARNESS: reconnexion refusee'); process.exit(2) }
  await page.goto(`${BASE}${APPEARANCE_HREF}`, { waitUntil: 'networkidle2' })
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const asUser = await sectionSeen(page)
  check(!asUser.present, 'un non-administrateur ne voit pas la section d\'identite')
  const userControls = await page.evaluate(() => !!document.getElementById('branding-name'))
  check(!userControls, 'il n\'a pas non plus le champ du nom de l\'onglet')
  // Le reste de la page reste la : la garde retire la section, pas la page.
  const stillThere = await page.evaluate(() => document.body.innerText.length > 0)
  check(stillThere, 'le reste d\'Apparence lui reste accessible')
} finally {
  try { if (originalRole !== null) await setRole(originalRole) }
  catch (e) { console.error(`HARNESS: role non restaure — ${e.message}`) }
  await db.end().catch(() => {})
  await browser.close().catch(() => {})
}

console.log(failures.length === 0 ? '\ncheck-appearance-branding-live: OK' : `\ncheck-appearance-branding-live: ${failures.length} FAIL`)
process.exit(failures.length === 0 ? 0 : 1)
