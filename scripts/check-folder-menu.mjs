#!/usr/bin/env node
/**
 * Lot H3e — le clic droit sur les dossiers de la barre, mesuré avec de VRAIS clics
 * droits, de VRAIES frappes et de VRAIS appels à l'API de l'application.
 *
 * Cycle de vie complet, dans un dossier racine que le banc crée puis supprime :
 * créer → visible dans la barre ; renommer → nom à jour ; marquer lu → compteur à 0 ;
 * supprimer → disparu. Puis la règle d'affichage : un dossier spécial grise
 * « Renommer » et « Supprimer » ; une session sans droits grise TOUT.
 *
 * Ce banc ne touche JAMAIS à un vrai dossier : tout ce qu'il crée vit sous un nom
 * préfixé, et tout ce qu'il supprime, il l'a créé lui-même dans la même exécution.
 * La vérification finale échoue si un dossier du préfixe survit.
 *
 * Nécessite un serveur lancé et les identifiants SYNAPMAIL_TEST_* (voir .env).
 *   node scripts/check-folder-menu.mjs
 */
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
// Une IHM qui se re-rend après une mutation : un re-rendu React, pas un aller-retour réseau.
const SETTLE_MS = 400
// Une mutation de dossier ouvre une connexion IMAP : des ordres de grandeur plus lent.
const IMAP_MS = 60000
/**
 * Préfixe de TOUT ce que ce banc crée. C'est la barrière de sécurité du fichier :
 * aucune suppression n'est émise sur un chemin qui ne commence pas par là.
 */
const PREFIX = 'Tests-lane'

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD } = process.env
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`HARNESS: ${k} is not set`); process.exit(2) }
}

const failures = []
/**
 * Compte TOUTES les assertions, pas seulement celles qui échouent : un « OK » nu ne
 * distingue pas « tout est passé » de « le banc s'est arrêté avant de mesurer ».
 */
let asserted = 0
const check = (ok, message) => { asserted++; if (!ok) failures.push(message); return ok }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
let accountId = null
let page = null
try {
  page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultNavigationTimeout(120000)

  const land = async path => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-sidebar] [data-sidebar-row^="folder:"]', { timeout: 120000 })
  }

  /**
   * Clic droit RÉEL sur une ligne de dossier, menu ouvert. La ligne est d'abord amenée
   * dans la zone visible : la barre défile, et ce compte porte une centaine de dossiers,
   * donc `boundingBox()` d'une ligne hors champ renvoie des coordonnées où la souris ne
   * touche rien — le menu ne s'ouvre jamais et le banc échoue sans avoir rien mesuré.
   */
  const rightClick = async path => {
    const selector = `[data-sidebar-row="folder:${path}"]`
    await page.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'center' }), selector)
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const box = await (await page.$(selector)).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await page.waitForSelector('[data-folder-context-menu]', { timeout: 5000 })
  }

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
  if (!loggedIn) { console.error('HARNESS: credentials login failed'); process.exit(2) }

  await land('/mail')

  // Le compte MESURÉ est une boîte POSSÉDÉE qui donne « supprimer », choisie sur les
  // droits que l'API annonce — pas la boîte active. La section 8 déplace la boîte active
  // vers une boîte PARTAGÉE sans « supprimer » : si elle meurt avant de la remettre, hériter
  // de cette préférence fait mesurer le cycle de vie complet sur une boîte qui n'a pas le
  // droit de supprimer, et le banc rapporte 8 échecs PRODUIT pour un état laissé par le banc
  // (vécu). Lire les droits au lieu de la préférence rend ce choix indépendant du passé.
  const active = await page.evaluate(async base => {
    const accounts = (await (await fetch(`${base}/api/accounts`)).json()).data ?? []
    const acc = accounts.find(a => !a.isShared && a.permissions?.canDelete && a.permissions?.canOrganize)
    return acc ? { id: acc.id, label: acc.name || acc.email } : null
  }, BASE)
  if (!active) { console.error('HARNESS: no owned mailbox granting delete+organize — nothing to measure'); process.exit(2) }
  accountId = active.id
  console.log(`mesuré sur « ${active.label} » (${accountId})`)

  // `sidebar_collapsed` et `active_account_id` sont des préférences SERVEUR : elles
  // survivent d'une exécution à l'autre. Le banc les ÉPINGLE toutes deux au lieu d'hériter
  // de ce que la session précédente a laissé — une barre repliée n'affiche pas le champ de
  // saisie, et une boîte active héritée n'est pas forcément celle qu'on mesure.
  await page.evaluate(async ({ base, id }) => {
    await fetch(`${base}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidebar_collapsed: false, active_account_id: id }),
    })
  }, { base: BASE, id: accountId })
  await land('/mail')

  /** Appelle l'API de l'application depuis la page (mêmes cookies de session). */
  const api = (path, init) => page.evaluate(async ({ base, path, init }) => {
    const res = await fetch(`${base}${path}`, init)
    return { status: res.status, body: await res.json().catch(() => null) }
  }, { base: BASE, path, init })

  const folders = () => page.evaluate(async ({ base, id }) =>
    (await (await fetch(`${base}/api/folders?account=${id}`)).json()).data ?? [], { base: BASE, id: accountId })

  const jsonPost = (path, payload) => api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })

  // ── 1. CRÉER ──────────────────────────────────────────────────────────────────
  const created = await jsonPost('/api/folders', { accountId, name: PREFIX })
  if (created.status !== 200) { console.error(`HARNESS: création impossible (${created.status} ${JSON.stringify(created.body)})`); process.exit(2) }
  const rootPath = created.body.data.path
  if (!rootPath.startsWith(PREFIX)) { console.error(`HARNESS: le serveur a renvoyé un chemin hors préfixe (${rootPath})`); process.exit(2) }

  await land('/mail')
  const seen = await page.$(`[data-sidebar-row="folder:${rootPath}"]`)
  check(!!seen, `créer : le dossier « ${rootPath} » n'apparaît pas dans la barre`)

  // Un nom portant le délimiteur du serveur est REFUSÉ, il ne crée pas de hiérarchie.
  const delimiter = (await folders()).find(f => f.delimiter)?.delimiter ?? '/'
  const bad = await jsonPost('/api/folders', { accountId, name: `${PREFIX}${delimiter}x` })
  check(bad.status === 400, `nom invalide : attendu 400, reçu ${bad.status}`)

  // ── 2. LE MENU S'OUVRE SUR UN VRAI CLIC DROIT ────────────────────────────────
  await rightClick(rootPath)

  const readMenu = () => page.evaluate(() => {
    const menu = document.querySelector('[data-folder-context-menu]')
    if (!menu) return null
    const box = menu.getBoundingClientRect()
    return {
      path: menu.dataset.folderPath,
      inWindow: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      items: Object.fromEntries([...menu.querySelectorAll('[data-menu-item]')]
        .map(b => [b.dataset.menuItem, !b.disabled])),
    }
  })

  const normal = await readMenu()
  check(normal?.path === rootPath, `le menu vise ${normal?.path}, attendu ${rootPath}`)
  check(normal?.inWindow, 'le menu déborde de la fenêtre')
  for (const action of ['create', 'createChild', 'rename', 'markRead', 'remove']) {
    check(normal?.items[action] === true, `dossier ordinaire : « ${action} » devrait être actif`)
  }
  // Défaut 3 du gate : « vider » n'est pas AFFICHÉ GRISÉ sur un dossier ordinaire, il
  // est ABSENT. Une entrée grisée en permanence sur vingt dossiers est du bruit.
  check(!('empty' in (normal?.items ?? {})), `dossier ordinaire : « vider » ne doit pas figurer au menu (entrées : ${Object.keys(normal?.items ?? {}).join(', ')})`)

  // Fermeture en UN clic dehors.
  await page.mouse.click(VIEWPORT.width - 5, VIEWPORT.height / 2)
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check(!(await page.$('[data-folder-context-menu]')), 'le menu ne se ferme pas en un clic dehors')

  // ── 3. DOSSIER SPÉCIAL : RENOMMER ET SUPPRIMER SONT GRISÉS ───────────────────
  const all = await folders()
  const trash = all.find(f => f.special === 'trash')
  const special = trash ?? all.find(f => f.special)
  if (!special) { console.error('HARNESS: ce compte ne déclare aucun dossier spécial'); process.exit(2) }
  await rightClick(special.path)
  const specialMenu = await readMenu()
  check(specialMenu?.items.rename === false, `${special.path} (${special.special}) : « renommer » devrait être grisé`)
  check(specialMenu?.items.remove === false, `${special.path} (${special.special}) : « supprimer » devrait être grisé`)
  check(specialMenu?.items.markRead === true, `${special.path} : « tout marquer comme lu » doit rester offert`)
  check(('empty' in (specialMenu?.items ?? {})) === (special.special === 'trash' || special.special === 'spam'),
    `${special.path} (${special.special}) : « vider » ne figure au menu que sur la corbeille et les indésirables`)
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check(!(await page.$('[data-folder-context-menu]')), 'le menu ne se ferme pas avec Échap')

  // Le serveur refuse aussi, pas seulement l'IHM : une entrée grisée est un refus réel.
  const renameSpecial = await api('/api/folders', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, path: special.path, name: `${PREFIX}-interdit` }),
  })
  check(renameSpecial.status === 403, `renommer un dossier spécial : attendu 403, reçu ${renameSpecial.status}`)

  // ── 4. UN PARENT NE SE SUPPRIME PAS ──────────────────────────────────────────
  const child = await jsonPost('/api/folders', { accountId, parent: rootPath, name: 'enfant' })
  check(child.status === 200, `créer un sous-dossier : attendu 200, reçu ${child.status}`)
  const childPath = child.body?.data?.path
  const removeParent = await api(`/api/folders?account=${accountId}&path=${encodeURIComponent(rootPath)}`, { method: 'DELETE' })
  check(removeParent.status === 403, `supprimer un parent : attendu 403, reçu ${removeParent.status}`)

  await land('/mail')
  await rightClick(rootPath)
  const parentMenu = await readMenu()
  check(parentMenu?.items.remove === false, 'un dossier qui a des sous-dossiers ne doit pas offrir « supprimer »')
  await page.keyboard.press('Escape')

  // ── 5. RENOMMER PAR LE CHAMP EN LIGNE (de vraies frappes) ────────────────────
  const renamed = `${PREFIX}-renomme`
  await rightClick(childPath)
  await page.click('[data-folder-context-menu] [data-menu-item="rename"]')
  await page.waitForSelector('[data-folder-name-input] input', { timeout: 5000 })
  // Aucun `window.prompt` : la saisie est un champ DANS la barre.
  const inline = await page.$eval('[data-folder-name-input] input', el => ({ tag: el.tagName, focused: el === document.activeElement }))
  check(inline.tag === 'INPUT' && inline.focused, 'la saisie du nom doit être un champ en ligne, déjà actif')
  // Le champ arrive PRÉ-REMPLI du nom actuel : il faut le VIDER, sinon la frappe s'ajoute
  // et le dossier est renommé « <ancien><nouveau> ». `Meta+A` ne sélectionne rien ici
  // (Chrome piloté, pas de couche clavier macOS) : on efface par autant de Backspace que
  // le champ porte de caractères, et le banc VÉRIFIE qu'il est vide avant de taper.
  const nameLength = await page.$eval('[data-folder-name-input] input', el => el.value.length)
  for (let i = 0; i < nameLength; i++) await page.keyboard.press('Backspace')
  check(await page.$eval('[data-folder-name-input] input', el => el.value) === '',
    'renommer : le champ doit être vide avant la frappe, sinon le nom se concatène')
  await page.type('[data-folder-name-input] input', renamed)
  await page.keyboard.press('Enter')
  // On compare le SEGMENT FINAL, pas la fin de la chaîne : `endsWith` accepte
  // « enfantTests-lane-renomme », c'est-à-dire exactement le défaut de concaténation
  // que cette section doit attraper — il est passé inaperçu sous `endsWith`.
  const leafIs = (path, leaf) => path.slice(path.lastIndexOf(delimiter) + 1) === leaf
  /** `path` est-il rangé SOUS `parent` ? Le préfixe seul ne suffit pas. */
  const isUnder = (path, parent) => path.startsWith(`${parent}${delimiter}`)
  await page.waitForFunction(
    ({ name, sep }) => [...document.querySelectorAll('[data-sidebar-row^="folder:"]')].some(r => {
      const p = r.dataset.sidebarRow.slice('folder:'.length)
      return p.slice(p.lastIndexOf(sep) + 1) === name
    }),
    { timeout: IMAP_MS }, { name: renamed, sep: delimiter },
  ).catch(() => {})
  const afterRename = await folders()
  const renamedPath = afterRename.map(f => f.path).find(p => leafIs(p, renamed))
  check(!!renamedPath, `renommer : aucun dossier ne s'appelle « ${renamed} » (liste : ${afterRename.map(f => f.path).filter(p => p.startsWith(PREFIX)).join(', ')})`)

  // Échap annule la saisie sans rien créer.
  const before = (await folders()).length
  await rightClick(rootPath)
  await page.click('[data-folder-context-menu] [data-menu-item="create"]')
  await page.waitForSelector('[data-folder-name-input] input', { timeout: 5000 })
  await page.type('[data-folder-name-input] input', `${PREFIX}-annule`)
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  check(!(await page.$('[data-folder-name-input]')), 'Échap doit fermer le champ de saisie')
  check((await folders()).length === before, 'Échap ne doit créer aucun dossier')

  // ── 5bis. LES TROIS AUTRES DÉFAUTS RELEVÉS PAR LE GATE ───────────────────────
  // Défaut 1 : un refus porte un corps LISIBLE à CHAQUE fois, pas seulement à la
  // première requête de la vie du processus. On rejoue le MÊME refus trois fois.
  const ghost = `${PREFIX}-inexistant`
  for (const attempt of [1, 2, 3]) {
    const res = await api('/api/folders', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, path: ghost, name: `${PREFIX}-x` }),
    })
    check(res.status === 404 && res.body?.error,
      `refus répété n°${attempt} : attendu 404 AVEC un corps, reçu ${res.status} ${JSON.stringify(res.body)}`)
  }
  // Même exigence sur l'autre route et sur un autre refus : c'est le motif qu'on traque.
  for (const attempt of [1, 2]) {
    const res = await jsonPost('/api/folders/actions', { action: 'empty', accountId, path: rootPath })
    check(res.status === 403 && res.body?.error,
      `refus 403 répété n°${attempt} : attendu un corps lisible, reçu ${res.status} ${JSON.stringify(res.body)}`)
  }

  // Défaut 2 : un nom que le client sait déjà invalide ne part PAS au serveur. Le champ
  // reste ouvert, le message s'affiche, et le compteur de requêtes n'a pas bougé.
  await page.evaluate(() => {
    window.__folderPosts = 0
    const real = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      if (url.includes('/api/folders') && (init?.method === 'POST' || init?.method === 'PATCH')) window.__folderPosts++
      return real(input, init)
    }
  })
  await rightClick(rootPath)
  await page.click('[data-folder-context-menu] [data-menu-item="create"]')
  await page.waitForSelector('[data-folder-name-input] input', { timeout: 5000 })
  await page.type('[data-folder-name-input] input', `a${delimiter}b`)
  await page.keyboard.press('Enter')
  await new Promise(r => setTimeout(r, SETTLE_MS))
  const posted = await page.evaluate(() => window.__folderPosts)
  check(posted === 0, `nom invalide : ${posted} requête(s) partie(s), le client devait refuser seul`)
  const shownError = await page.$eval('[data-folder-error]', el => el.textContent).catch(() => null)
  check(!!shownError, 'nom invalide : aucun message affiché sous le champ')
  check(!!(await page.$('[data-folder-name-input] input')), 'nom invalide : le champ doit rester ouvert pour corriger')
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, SETTLE_MS))

  // Défaut 4 : renommer un dossier qui a des sous-dossiers emmène TOUT le sous-arbre.
  // Mesuré sur les faits du serveur : après le renommage, plus aucun dossier ne vit
  // sous l'ancien chemin, et l'enfant est bien rangé sous le nouveau.
  const subParent = await jsonPost('/api/folders', { accountId, name: `${PREFIX}-arbre` })
  check(subParent.status === 200, `arbre : création du parent, attendu 200, reçu ${subParent.status}`)
  const subParentPath = subParent.body?.data?.path
  const subChild = await jsonPost('/api/folders', { accountId, parent: subParentPath, name: 'sous' })
  check(subChild.status === 200, `arbre : création de l'enfant, attendu 200, reçu ${subChild.status}`)
  const movedTo = `${PREFIX}-arbre-neuf`
  const moved = await api('/api/folders', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, path: subParentPath, name: movedTo }),
  })
  check(moved.status === 200, `arbre : renommage, attendu 200, reçu ${moved.status} ${JSON.stringify(moved.body)}`)
  const afterTree = (await folders()).map(f => f.path)
  const newParent = moved.body?.data?.path
  check(!afterTree.some(p => p === subParentPath || isUnder(p, subParentPath)),
    `arbre : des dossiers vivent encore sous l'ancien chemin (${afterTree.filter(p => p === subParentPath || isUnder(p, subParentPath)).join(', ')})`)
  check(afterTree.some(p => isUnder(p, newParent)),
    `arbre : l'enfant n'a pas suivi sous « ${newParent} » (liste : ${afterTree.filter(p => p.startsWith(PREFIX)).join(', ')})`)
  // Mesuré : l'arbre repart tout de suite — la section 7 exige zéro survivant du préfixe.
  for (const path of afterTree.filter(p => p === newParent || isUnder(p, newParent)).sort((a, b) => b.length - a.length)) {
    await api(`/api/folders?account=${accountId}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  }

  // ── 6. TOUT MARQUER COMME LU → COMPTEUR À 0 ──────────────────────────────────
  const markRead = await jsonPost('/api/folders/actions', { action: 'markRead', accountId, path: rootPath })
  check(markRead.status === 200 && markRead.body?.data?.unreadCount === 0,
    `marquer lu : attendu 200 + unreadCount 0, reçu ${markRead.status} ${JSON.stringify(markRead.body)}`)

  // « Vider » n'existe pas hors corbeille / indésirables, quoi que le client demande.
  const emptyNormal = await jsonPost('/api/folders/actions', { action: 'empty', accountId, path: rootPath })
  check(emptyNormal.status === 403, `vider un dossier ordinaire : attendu 403, reçu ${emptyNormal.status}`)

  // ── 7. SUPPRIMER → DISPARU ───────────────────────────────────────────────────
  for (const path of [renamedPath, rootPath].filter(Boolean)) {
    const res = await api(`/api/folders?account=${accountId}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    check(res.status === 200, `supprimer « ${path} » : attendu 200, reçu ${res.status} ${JSON.stringify(res.body)}`)
  }
  await land('/mail')
  const left = (await folders()).filter(f => f.path.startsWith(PREFIX))
  check(left.length === 0, `supprimer : ${left.length} dossier(s) de test survivent (${left.map(f => f.path).join(', ')})`)
  check(!(await page.$(`[data-sidebar-row="folder:${rootPath}"]`)), 'supprimer : la ligne est encore dans la barre')

  // ── 8. PERMISSION REFUSÉE → ENTRÉE GRISÉE ET SERVEUR QUI REFUSE ──────────────
  // Une boîte PARTAGÉE dont le partage ne donne pas « supprimer ». La session est la
  // même — c'est le compte visé qui change de droits, pas l'utilisateur. Le banc ne
  // crée aucun partage : il mesure celui qui existe, et se tait s'il n'y en a pas.
  const shared = (await page.evaluate(async base =>
    ((await (await fetch(`${base}/api/accounts`)).json()).data ?? [])
      .filter(a => a.isShared)
      .map(a => ({ id: a.id, email: a.email, permissions: a.permissions })), BASE))
    .find(a => a.permissions && a.permissions.canDelete === false)

  if (!shared) {
    console.log('permissions : aucune boîte partagée sans « supprimer » dans cette base — arm non mesuré')
  } else {
    await page.evaluate(async ({ base, id }) => {
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_account_id: id, sidebar_collapsed: false }),
      })
    }, { base: BASE, id: shared.id })
    // La cible du refus est un dossier que le banc CRÉE dans la boîte partagée (le partage
    // donne « organiser », pas « supprimer »), jamais un dossier RÉEL de l'utilisateur :
    // si la vérification de permission régressait un jour, le DELETE ci-dessous partirait
    // pour de bon — il ne doit alors emporter qu'un dossier de test. Le banc se rabat sur
    // un dossier existant seulement s'il ne peut rien créer, et le dit.
    // La création précède le chargement de la page : une ligne créée APRÈS le rendu n'est
    // pas dans la barre, et le clic droit vise alors un sélecteur qui ne résout rien.
    const madeHere = await jsonPost('/api/folders', { accountId: shared.id, name: `${PREFIX}-partage` })
    if (madeHere.status !== 200) {
      console.log(`permissions : création refusée sur « ${shared.email} » (${madeHere.status}) — cible repliée sur un dossier existant`)
    }
    await land('/mail')

    const sharedFolders = await page.evaluate(async ({ base, id }) =>
      (await (await fetch(`${base}/api/folders?account=${id}`)).json()).data ?? [], { base: BASE, id: shared.id })
    const ordinary = madeHere.status === 200
      ? sharedFolders.find(f => f.path === madeHere.body?.data?.path)
      : sharedFolders.find(f => !f.special && !f.path.startsWith(PREFIX))
    if (!ordinary) {
      console.log(`permissions : « ${shared.email} » ne montre aucun dossier ordinaire — arm non mesuré`)
    } else {
      await rightClick(ordinary.path)
      const denied = await readMenu()
      check(denied?.items.remove === false,
        `sans la permission « supprimer », « supprimer » doit être grisé sur ${ordinary.path}`)
      check(!('empty' in (denied?.items ?? {})),
        `dossier ordinaire partagé : « vider » ne doit pas figurer au menu sur ${ordinary.path}`)
      await page.keyboard.press('Escape')

      // Le grisage n'est pas la barrière : le serveur refuse la même chose. Il répond 404,
      // pas 403 — `getAccessibleAccount` rend `null` quand une permission EXIGÉE manque, et
      // la route ne distingue pas ce cas de « ce compte n'existe pas » : une permission
      // refusée ne doit rien révéler de l'existence de la boîte. Le 403 est réservé au cas
      // où l'accès est acquis mais la RÈGLE du dossier refuse (renommer un dossier spécial).
      const forbidden = await api(
        `/api/folders?account=${shared.id}&path=${encodeURIComponent(ordinary.path)}`, { method: 'DELETE' })
      check(forbidden.status === 404,
        `supprimer sans la permission : attendu 404 (accès non révélé), reçu ${forbidden.status}`)
      console.log(`permissions : mesuré sur « ${shared.email} » (partage sans « supprimer »), dossier « ${ordinary.path} »`)
    }
  }
} finally {
  // La boîte active est une préférence SERVEUR : la section 8 l'a déplacée sur la boîte
  // partagée. La remise en place vit ICI et non à la fin de la section, pour qu'un échec
  // en cours de route ne laisse pas la préférence sur une boîte sans droit de suppression
  // — l'exécution suivante mesurerait alors le mauvais compte (vécu : 8 échecs imputés au
  // produit, tous causés par cet état laissé par le banc).
  if (page && accountId) {
    await page.evaluate(async ({ base, id }) => {
      await fetch(`${base}/api/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_account_id: id }),
      })
    }, { base: BASE, id: accountId }).catch(() => {})
  }
  // Filet de sécurité : ce que le banc a créé ne reste JAMAIS derrière lui, même
  // sur un échec en cours de route. Aucun chemin hors préfixe n'est touché.
  if (page && accountId) {
    // Le balayage passe sur TOUTES les boîtes accessibles, pas seulement l'active : la
    // section 8 crée dans une boîte PARTAGÉE, et une boîte partagée apparaît DEUX fois
    // dans la liste (la ligne possédée et la ligne partagée) — un nettoyage limité à la
    // boîte active laissait ses dossiers derrière lui (observé : « Tests-lane » survivant
    // sur deux comptes après une exécution pourtant verte).
    const leftovers = await page.evaluate(async ({ base, prefix }) => {
      const accounts = (await (await fetch(`${base}/api/accounts`)).json()).data ?? []
      const done = []
      for (const acc of accounts) {
        const list = (await (await fetch(`${base}/api/folders?account=${acc.id}`)).json()).data ?? []
        // Du plus profond au moins profond : un parent ne se supprime pas avant ses enfants.
        const mine = list.filter(f => f.path.startsWith(prefix)).map(f => f.path).sort((a, b) => b.length - a.length)
        for (const path of mine) {
          const res = await fetch(`${base}/api/folders?account=${acc.id}&path=${encodeURIComponent(path)}`, { method: 'DELETE' })
          done.push(`${acc.email}/${path}:${res.status}`)
        }
      }
      return done
    }, { base: BASE, prefix: PREFIX }).catch(() => [])
    if (leftovers.length) console.log(`nettoyage : ${leftovers.join(', ')}`)
  }
  await browser.close()
}

if (failures.length) {
  console.error(`check-folder-menu: ${failures.length} échec(s) sur ${asserted} assertions`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`check-folder-menu: OK — ${asserted} assertions`)
