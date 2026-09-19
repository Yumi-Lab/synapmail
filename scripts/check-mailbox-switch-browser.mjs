#!/usr/bin/env node
/**
 * Mesure le lot M7 sur l'application qui tourne, à la VRAIE souris : ouvrir une
 * boîte, cliquer un dossier PERSONNALISÉ, puis changer de boîte — par le
 * sélecteur de la barre latérale ET par la palette de l'omnibar — doit ramener
 * l'URL sur la réception de la NOUVELLE boîte, allumer « Boîte de réception »
 * dans la barre, et n'envoyer AUCUNE requête de liste vers l'ancien dossier.
 *
 * Lecture seule : aucun message n'est ouvert, déplacé ni supprimé ; seules des
 * requêtes GET de liste sont provoquées.
 *
 * Demande un serveur qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 *   node scripts/check-mailbox-switch-browser.mjs
 *   node scripts/check-mailbox-switch-browser.mjs --negative   (contrôle négatif)
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }

// Les noms de paramètres ne sont PAS retapés : ils sont lus dans le contrat
// partagé, au cours de CE passage, pour qu'une dérive fasse échouer ce banc au
// lieu de lui faire mesurer autre chose.
const CONTRACT = readFileSync(new URL('../app/(app)/mail/mailboxUrl.ts', import.meta.url), 'utf8')
const constant = (name, re, src = CONTRACT, file = 'mailboxUrl.ts') => {
  const m = src.match(re)
  if (!m) { console.error(`HARNESS: ${name} illisible dans ${file}`); process.exit(2) }
  return m[1]
}
const FOLDER_PARAM = constant('FOLDER_PARAM', /FOLDER_PARAM = '([^']+)'/)
const DEFAULT_FOLDER = constant('DEFAULT_FOLDER', /DEFAULT_FOLDER = '([^']+)'/)
const SEARCH_SRC = readFileSync(new URL('../lib/search.ts', import.meta.url), 'utf8')
const SEARCH_PARAM = constant('SEARCH_PARAM', /SEARCH_PARAM = '([^']+)'/, SEARCH_SRC, 'search.ts')
const SCOPE_PARAM = constant('SCOPE_PARAM', /SCOPE_PARAM = '([^']+)'/, SEARCH_SRC, 'search.ts')
const SCOPE_ACCOUNTS = constant('SCOPE_ACCOUNTS', /SCOPE_ACCOUNTS = '([^']+)'/, SEARCH_SRC, 'search.ts')
const SCOPE_ALL = constant('SCOPE_ALL', /SCOPE_ALL = '([^']+)'/, SEARCH_SRC, 'search.ts')
const DEBOUNCE_MS = Number(constant('SEARCH_DEBOUNCE_MS', /SEARCH_DEBOUNCE_MS = (\d+)/, SEARCH_SRC, 'search.ts'))

// Contrôle négatif : l'écouteur est remis dans son état d'AVANT le lot (il ne
// réécrit plus l'URL), en neutralisant l'API d'historique que le correctif
// utilise. Le banc DOIT alors échouer — sinon il ne mesure rien.
const NEGATIVE = process.argv.includes('--negative')

const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const accountRow = id => `[data-sidebar-row="account:${id}"]`
const folderRow = path => `[data-sidebar-row="folder:${path}"]`
const OMNIBAR_SEARCH = '[data-omnibar-search]'
const omnibarAccount = id => `[data-omnibar-entry="account:${id}"]`
// La classe qui MARQUE la ligne active, lue dans la barre elle-même.
const SIDEBAR_SRC = readFileSync(new URL('../components/layout/Sidebar.tsx', import.meta.url), 'utf8')
const ACTIVE_TOKEN = constant('ROW_ACTIVE', /ROW_ACTIVE = cn\(ACCENT\.(\w+),/, SIDEBAR_SRC, 'Sidebar.tsx')
const AVATAR_SRC = readFileSync(new URL('../components/layout/AccountAvatar.tsx', import.meta.url), 'utf8')
const ACTIVE_MARKER = constant('ACCENT.' + ACTIVE_TOKEN,
  new RegExp(`\\b${ACTIVE_TOKEN}: '([^']+)'`), AVATAR_SRC, 'AccountAvatar.tsx')

const SETTLE_MS = 800
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
try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)

  // Le flux SSE reste ouvert tant que la page vit : `networkidle2` ne peut donc
  // JAMAIS se poser. On attend le DOM, l'élément, puis son HYDRATATION — React 18
  // pose ses props sur le nœud à l'hydratation, et c'est exactement ce dont un
  // vrai clic a besoin pour ne pas être perdu.
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
  const visit = async (path, selector) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    if (selector) await hydrated(selector)
  }
  /** Vrai clic souris, au CENTRE de l'élément réellement rendu. */
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

  // Toutes les requêtes de LISTE, dans l'ordre : c'est la preuve qu'aucune n'est
  // partie vers l'ancien dossier sur la nouvelle boîte.
  let listCalls = []
  page.on('request', req => {
    const u = new URL(req.url())
    if (u.pathname === '/api/messages' || u.pathname === '/api/messages/search') {
      listCalls.push({ path: u.pathname, folder: u.searchParams.get(FOLDER_PARAM), account: u.searchParams.get('account') })
    }
  })

  await visit('/login')
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
    // L'écouteur d'avant le lot : il ne touchait pas à l'URL. On neutralise donc
    // l'écriture d'historique AVANT tout script de la page.
    await page.evaluateOnNewDocument(() => {
      const keep = history.replaceState.bind(history)
      history.replaceState = function (state, title, url) {
        // Seules les réécritures qui RETIRENT le dossier sont neutralisées : les
        // autres usages de l'application continuent, comme avant le lot.
        if (typeof url === 'string' && !url.includes('folder=')) return
        return keep(state, title, url)
      }
    })
  }

  const accounts = await page.evaluate(async base => {
    const r = await fetch(`${base}/api/accounts`)
    const b = await r.json()
    return (b.data ?? []).map(a => ({ id: a.id, email: a.email }))
  }, BASE)
  if (accounts.length < 2) { console.error(`HARNESS: ${accounts.length} boîte(s) — il en faut 2`); process.exit(2) }

  /** La boîte ACTIVE — c'est la sienne que la barre latérale déplie. */
  const activeAccount = async () => {
    const id = await page.evaluate(async base => {
      const r = await fetch(`${base}/api/settings`)
      return (await r.json()).data?.active_account_id ?? null
    }, BASE)
    return accounts.find(a => a.id === id) ?? accounts[0]
  }
  /** Une AUTRE boîte que celle passée : la cible du changement. */
  const otherThan = acc => accounts.find(a => a.id !== acc.id)

  /**
   * Amène l'écran sur un dossier PERSONNALISÉ de la boîte active, à la souris.
   * Le dossier est choisi dans ce que la barre REND vraiment (et non dans une
   * liste calculée avant coup) : la boîte active change d'une passe à l'autre,
   * et viser un dossier d'une autre boîte ne cliquerait sur rien.
   */
  const standOnCustomFolder = async () => {
    await visit(`/mail?${FOLDER_PARAM}=${encodeURIComponent(DEFAULT_FOLDER)}`, SIDEBAR_ACCOUNT)
    await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
    const path = await page.evaluate(inbox => {
      const rows = [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
        .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length))
        .filter(p => p !== inbox)
      return rows[0] ?? null
    }, DEFAULT_FOLDER)
    if (!path) { console.error('HARNESS: la barre ne rend aucun dossier hors réception'); process.exit(2) }
    await realClick(folderRow(path))
    await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
    const url = new URL(page.url())
    if (url.searchParams.get(FOLDER_PARAM) !== path) {
      console.error(`HARNESS: le clic sur « ${path} » n'a pas porté (URL ${url.search})`); process.exit(2)
    }
    listCalls = []
    return path
  }

  /**
   * La surbrillance, lue sur la classe RENDUE : la barre n'expose pas d'attribut
   * d'état, et la classe active n'est PAS retapée ici — elle est lue dans
   * `Sidebar.tsx` au cours de ce passage (`ROW_ACTIVE`), donc un changement de
   * style fait échouer ce banc au lieu de lui faire mesurer un autre élément.
   */
  const activeFolderRow = async () => page.evaluate(marker =>
    [...document.querySelectorAll('[data-sidebar-row^="folder:"]')]
      .filter(el => el.className.includes(marker))
      .map(el => el.getAttribute('data-sidebar-row').slice('folder:'.length)),
    ACTIVE_MARKER)

  /** Une passe complète : dossier personnalisé → changement de boîte → mesures. */
  const run = async (label, switchToNewAccount) => {
    const oldFolder = await standOnCustomFolder()
    const before = new URL(page.url())
    const from = await activeAccount()
    const to = otherThan(from)
    console.log(`\n[${label}] boîtes : ${from.email} → ${to.email}`)
    await switchToNewAccount(to)
    await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
    const after = new URL(page.url())
    const active = await activeFolderRow()
    // Ce que la case interdit : une requête vers l'ancien dossier SUR LA NOUVELLE
    // boîte. Les requêtes encore en vol vers l'ANCIENNE boîte sont comptées à part
    // et affichées — elles étaient légitimes au moment où elles sont parties.
    const toOldFolder = listCalls.filter(c => c.folder === oldFolder)
    const stray = toOldFolder.filter(c => c.account === to.id)
    const inFlight = toOldFolder.length - stray.length
    console.log(`  URL                 : ${before.search || '(nu)'}  →  ${after.search || '(nu)'}`)
    console.log(`  dossier quitté      : ${oldFolder}`)
    console.log(`  ${FOLDER_PARAM} dans l'URL   : ${after.searchParams.get(FOLDER_PARAM) ?? '(absent)'}`)
    console.log(`  surbrillance        : ${active.length ? active.join(', ') : '(aucune)'}`)
    console.log(`  requêtes de liste   : ${listCalls.length}`)
    console.log(`  ancien dossier SUR LA NOUVELLE boîte : ${stray.length}  (encore en vol sur l'ancienne : ${inFlight})`)
    if (after.searchParams.get(FOLDER_PARAM) !== null) {
      failures.push(`[${label}] l'URL garde ${FOLDER_PARAM}="${after.searchParams.get(FOLDER_PARAM)}"`)
    }
    if (!active.includes(DEFAULT_FOLDER)) {
      failures.push(`[${label}] la surbrillance est sur ${active.join(', ') || '(aucune ligne)'}, attendu ${DEFAULT_FOLDER}`)
    }
    if (stray.length) {
      failures.push(`[${label}] ${stray.length} requête(s) de liste vers « ${oldFolder} » sur la NOUVELLE boîte`)
    }
  }

  /** Changer de boîte par le sélecteur de la barre latérale, à la souris. */
  const switchBySidebar = async target => {
    await realClick(SIDEBAR_ACCOUNT)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    await realClick(accountRow(target.id))
  }
  /**
   * Changer de boîte par la palette de l'omnibar, à la souris. La palette ne se
   * déroule qu'une fois quelque chose TAPÉ (elle ne recouvre pas le contenu pour
   * rien) : on tape donc l'adresse visée, puis on clique SA ligne.
   */
  const switchByPalette = async target => {
    await realClick(OMNIBAR_SEARCH)
    await page.type(OMNIBAR_SEARCH, target.email, { delay: 25 })
    await new Promise(r => setTimeout(r, DEBOUNCE_MS + SETTLE_MS))
    await realClick(omnibarAccount(target.id))
  }

  // --- 1. Par le sélecteur de la barre latérale ---
  await run('barre latérale', switchBySidebar)

  // --- 2. Par la palette de l'omnibar ---
  await run('palette', switchByPalette)

  // --- 3. Une recherche « toutes les boîtes » est GARDÉE ---
  await standOnCustomFolder()
  await realClick(OMNIBAR_SEARCH)
  await page.type(OMNIBAR_SEARCH, 'facture', { delay: 30 })
  await new Promise(r => setTimeout(r, DEBOUNCE_MS + SETTLE_MS))
  await page.evaluate((sel, param, scope) => {
    const u = new URL(location.href); u.searchParams.set(param, scope); history.replaceState(null, '', u)
  }, OMNIBAR_SEARCH, SCOPE_PARAM, SCOPE_ACCOUNTS)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  await switchBySidebar(otherThan(await activeAccount()))
  await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
  const wide = new URL(page.url())
  console.log(`\n[recherche « toutes les boîtes »] → ${wide.search || '(nu)'}`)
  if (wide.searchParams.get(SEARCH_PARAM) !== 'facture') failures.push(`la recherche « toutes les boîtes » a été perdue (${SEARCH_PARAM}=${wide.searchParams.get(SEARCH_PARAM)})`)
  if (wide.searchParams.get(FOLDER_PARAM) !== null) failures.push(`la recherche gardée traîne encore ${FOLDER_PARAM}`)

  // --- 4. Une recherche « tous les dossiers » part avec le dossier ---
  await standOnCustomFolder()
  await page.evaluate((param, scope, sp, q) => {
    const u = new URL(location.href); u.searchParams.set(sp, q); u.searchParams.set(param, scope); history.replaceState(null, '', u)
  }, SCOPE_PARAM, SCOPE_ALL, SEARCH_PARAM, 'facture')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  await switchBySidebar(otherThan(await activeAccount()))
  await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
  const narrow = new URL(page.url())
  console.log(`[recherche « tous les dossiers »] → ${narrow.search || '(nu)'}`)
  if (narrow.searchParams.get(SEARCH_PARAM) !== null) failures.push(`la recherche « tous les dossiers » a survécu (${SEARCH_PARAM}=${narrow.searchParams.get(SEARCH_PARAM)})`)

  // --- 5. Hors de la boîte, changer de compte ne navigue nulle part ---
  await visit('/settings/profile', SIDEBAR_ACCOUNT)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const settingsBefore = page.url()
  await switchBySidebar(otherThan(await activeAccount()))
  await new Promise(r => setTimeout(r, LIST_SETTLE_MS))
  const settingsAfter = page.url()
  console.log(`\n[réglages] ${new URL(settingsBefore).pathname} → ${new URL(settingsAfter).pathname}`)
  if (new URL(settingsAfter).pathname !== new URL(settingsBefore).pathname) {
    failures.push(`depuis les réglages, changer de boîte a navigué vers ${new URL(settingsAfter).pathname}`)
  }
} finally {
  await browser.close()
}

console.log('')
if (NEGATIVE) {
  // Le contrôle négatif RÉUSSIT quand le banc échoue : sinon le banc ne mesure rien.
  if (failures.length) {
    console.log(`contrôle négatif : OK — le banc voit bien la régression (${failures.length} échec(s))`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(0)
  }
  console.error('contrôle négatif : ÉCHEC — sans le correctif, le banc reste vert : il ne mesure rien')
  process.exit(1)
}
if (failures.length) {
  console.error(`check-mailbox-switch-browser : ${failures.length} ÉCHEC(S)`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log('check-mailbox-switch-browser : OK')
