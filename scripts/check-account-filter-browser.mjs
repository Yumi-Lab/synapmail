#!/usr/bin/env node
/**
 * Mesure le lot M7b sur l'application qui tourne, au VRAI clavier : déplier la
 * liste des boîtes, taper SANS cliquer dans le champ, filtrer en expression
 * régulière, naviguer aux flèches et basculer à Entrée.
 *
 * Lecture seule : aucun message n'est ouvert, déplacé ni supprimé.
 *
 * Demande un serveur qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 *   node scripts/check-account-filter-browser.mjs
 *   node scripts/check-account-filter-browser.mjs --negative   (contrôle négatif)
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

// Les constantes ne sont PAS retapées : elles sont lues dans le produit au cours
// de CE passage, pour qu'une dérive fasse échouer le banc au lieu de lui faire
// mesurer autre chose.
const SIDEBAR_SRC = readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8')
const FILTER_SRC = readFileSync(new URL('../lib/accountFilter.ts', import.meta.url), 'utf8')
const constant = (name, re, src, file) => {
  const m = src.match(re)
  if (!m) { console.error(`HARNESS: ${name} illisible dans ${file}`); process.exit(2) }
  return m[1]
}
const FILTER_FROM = Number(constant('accountFilterFrom', /accountFilterFrom: (\d+)/, SIDEBAR_SRC, 'Sidebar.tsx'))
const FILTER_MAX = Number(constant('ACCOUNT_FILTER_MAX', /ACCOUNT_FILTER_MAX = (\d+)/, FILTER_SRC, 'accountFilter.ts'))

// Contrôle négatif : le SEUIL du champ est remonté à sa valeur d'avant le lot (8),
// donc le champ n'apparaît plus sur un compte qui a moins de boîtes. Le banc DOIT
// alors échouer — sinon il ne mesure rien.
const NEGATIVE = process.argv.includes('--negative')
const LEGACY_FILTER_FROM = 8

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const ACCOUNT_FILTER = '[data-account-filter]'
const HIGHLIGHTED = '[data-account-highlight="true"]'
const accountRow = id => `[data-sidebar-row="account:${id}"]`

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
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  // React 18 pose ses props à l'HYDRATATION : c'est ce qu'un vrai clic attend.
  const hydrated = async (selector) => {
    await page.waitForSelector(selector, { timeout: 25000 })
    await page.waitForFunction(
      sel => {
        const el = document.querySelector(sel)
        return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$'))
      },
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
  const visible = sel => page.evaluate(s => {
    const el = document.querySelector(s)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }, sel)
  /** Les adresses des lignes actuellement rendues dans la liste dépliée. */
  const listedEmails = () => page.evaluate(() => [...document.querySelectorAll('[data-sidebar-row^="account:"]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map(el => el.getAttribute('data-sidebar-row').slice('account:'.length)))

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
  if (!loggedIn) { console.error('HARNESS: connexion refusée'); process.exit(2) }

  if (NEGATIVE) {
    // Le seuil d'AVANT le lot, réinjecté dans la page : le champ disparaît sous 8
    // autres boîtes, exactement comme Nicolas le vivait.
    await page.evaluateOnNewDocument(from => {
      const hide = () => {
        const field = document.querySelector('[data-account-filter]')
        const rows = document.querySelectorAll('[data-sidebar-row^="account:"]').length
        if (field && rows <= from) field.closest('div').style.display = 'none'
      }
      new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true })
      document.addEventListener('DOMContentLoaded', hide)
    }, LEGACY_FILTER_FROM)
  }

  const accounts = await page.evaluate(async base => {
    const r = await fetch(`${base}/api/accounts`)
    const b = await r.json()
    return (b.data ?? []).map(a => ({ id: a.id, email: a.email, name: a.name ?? '' }))
  }, BASE)
  if (accounts.length < 2) { console.error(`HARNESS: ${accounts.length} boîte(s) — il en faut 2`); process.exit(2) }

  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await hydrated(SIDEBAR_ACCOUNT)

  const activeId = await page.$eval(SIDEBAR_ACCOUNT, el => {
    const img = el.querySelector('[data-sidebar-icon]')
    return img ? img.getAttribute('data-account-id') : null
  }).catch(() => null)
  const others = accounts.filter(a => a.id !== activeId)
  const otherCount = others.length
  console.log(`contexte : ${accounts.length} boîte(s), dont ${otherCount} autre(s) ; seuil du champ = ${FILTER_FROM}`)

  // 1. Le champ apparaît au-dessus du seuil du lot (3), là où l'ancien (8) le cachait.
  await realClick(SIDEBAR_ACCOUNT)
  await new Promise(r => setTimeout(r, 600))
  const fieldShown = await visible(ACCOUNT_FILTER)
  const expectField = otherCount > FILTER_FROM
  check(`champ ${expectField ? 'visible' : 'absent'} avec ${otherCount} autre(s) boîte(s) (seuil ${FILTER_FROM})`,
    fieldShown === expectField, `visible=${fieldShown}, attendu ${expectField}`)
  if (!expectField) {
    console.error(`HARNESS: le compte de test n'a que ${otherCount} autre(s) boîte(s), le seuil du lot est ${FILTER_FROM} — impossible de mesurer le champ`)
    process.exit(2)
  }

  // 2. Le champ a le FOCUS sans qu'on ait cliqué dedans : on tape directement.
  const focused = await page.evaluate(sel => document.activeElement === document.querySelector(sel), ACCOUNT_FILTER)
  check('le champ a le focus à l\'ouverture (aucun clic dedans)', focused)

  // 3. Le bornage de la saisie est celui du module partagé.
  const maxAttr = await page.$eval(ACCOUNT_FILTER, el => Number(el.getAttribute('maxlength')))
  check(`saisie bornée à ${FILTER_MAX} (source unique)`, maxAttr === FILTER_MAX, `maxlength=${maxAttr}`)

  // 4. Expression régulière tapée au clavier, SANS cliquer dans le champ.
  //    L'attendu est calculé sur la MÊME liste que celle que la barre affiche.
  const target = others[0]
  const anchor = `^${(target.name || target.email).slice(0, 2)}`
  await page.keyboard.type(anchor, { delay: 30 })
  await new Promise(r => setTimeout(r, 300))
  const typed = await page.$eval(ACCOUNT_FILTER, el => el.value)
  check('la frappe arrive dans le champ sans clic', typed === anchor, `valeur="${typed}"`)
  const shown = await listedEmails()
  check(`l'ancrage \`${anchor}\` retient la boîte visée`, shown.includes(target.id), `rendu=${JSON.stringify(shown)}`)
  check(`l'ancrage \`${anchor}\` écarte le reste`, shown.length < otherCount, `${shown.length} ligne(s) sur ${otherCount}`)

  // 5. Une expression INVALIDE ne casse rien : retour au texte simple, sans erreur.
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta')
  const literal = (target.name || target.email).slice(0, 3)
  await page.keyboard.type(`${literal}(`, { delay: 30 })
  await new Promise(r => setTimeout(r, 300))
  const stillThere = await visible(ACCOUNT_FILTER)
  check('une expression invalide ne jette pas la page', pageErrors.length === 0 && stillThere,
    pageErrors.length ? pageErrors[0] : `champ visible=${stillThere}`)

  // 6. Échap VIDE le filtre avant de fermer la liste.
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, 200))
  const afterEsc = await page.$eval(ACCOUNT_FILTER, el => el.value).catch(() => null)
  const listStillOpen = await visible(ACCOUNT_FILTER)
  check('Échap vide le filtre et laisse la liste ouverte', afterEsc === '' && listStillOpen,
    `valeur="${afterEsc}", liste ouverte=${listStillOpen}`)

  // 7. ↓ déplace la surbrillance, Entrée bascule sur la ligne en surbrillance.
  const before = await listedEmails()
  await page.keyboard.press('ArrowDown')
  await new Promise(r => setTimeout(r, 200))
  const highlighted = await page.$eval(HIGHLIGHTED, el => el.getAttribute('data-sidebar-row').slice('account:'.length)).catch(() => null)
  check('↓ déplace la surbrillance sur la 2ᵉ ligne', highlighted === before[1],
    `surbrillance=${highlighted}, attendu ${before[1]}`)
  await page.keyboard.press('Enter')
  await new Promise(r => setTimeout(r, 1500))
  const nowActive = await page.$eval(SIDEBAR_ACCOUNT, el => {
    const img = el.querySelector('[data-sidebar-icon]')
    return img ? img.getAttribute('data-account-id') : null
  }).catch(() => null)
  check('Entrée bascule sur la boîte en surbrillance', nowActive === before[1],
    `boîte active=${nowActive}, attendu ${before[1]}`)

  // 8. Barre repliée : pas de champ, comportement d'avant.
  const collapsed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.hasAttribute('data-sidebar-toggle'))
    if (btn) { btn.click(); return true }
    return false
  })
  if (collapsed) {
    await new Promise(r => setTimeout(r, 500))
    await realClick(SIDEBAR_ACCOUNT).catch(() => {})
    await new Promise(r => setTimeout(r, 500))
    check('barre repliée : aucun champ de filtre', !(await visible(ACCOUNT_FILTER)))
  } else {
    console.log('  --   barre repliée : bouton de repli introuvable, point non mesuré')
  }
} finally {
  await browser.close()
}

if (NEGATIVE) {
  if (failures.length === 0) { console.error('check-account-filter-browser --negative : ROUGE ATTENDU, tout est passé'); process.exit(1) }
  console.log(`check-account-filter-browser --negative : rouge comme attendu (${failures.length} échec(s))`)
  process.exit(0)
}
if (failures.length > 0) { console.error(`check-account-filter-browser : ${failures.length} échec(s)`); process.exit(1) }
console.log('check-account-filter-browser: OK')
