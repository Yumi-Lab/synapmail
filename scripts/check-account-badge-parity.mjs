#!/usr/bin/env node
/**
 * Mesure l'OBJET du lot M7c : une boîte porte la MÊME couleur sur TOUS les écrans.
 *
 * Le gate humain du 20/09/2026 a échoué ici, et aucun banc ne le voyait : les scripts
 * purs vérifiaient l'ABSENCE d'un vieux hex dans les sources, pas la couleur CALCULÉE à
 * l'écran. Deux écrans peuvent n'avoir aucun hex en dur et peindre quand même deux
 * couleurs, s'ils classent deux ENSEMBLES de boîtes différents — c'est exactement ce qui
 * s'est produit (tableau de bord : boîtes possédées seules ; barre latérale et réglages :
 * possédées + reçues en partage). Ce banc compare donc des valeurs RENDUES, pas des sources.
 *
 * Pour CHAQUE boîte visible, il lit la couleur de fond calculée de sa bulle sur :
 *   1. la barre latérale (liste des boîtes dépliée, `/mail`)
 *   2. Réglages → Comptes
 *   3. le sélecteur du tableau de bord
 *   4. les pastilles de mails du tableau de bord (listes focus / accusés / différés)
 * puis exige l'IDENTITÉ des quatre. Les initiales sont comparées de la même façon.
 *
 * Lecture seule : aucun message n'est ouvert ni déplacé, aucune couleur n'est écrite.
 *
 * Contrôle négatif OBLIGATOIRE — sans lui le banc ne prouve rien :
 *   node scripts/check-account-badge-parity.mjs --negative
 * réinjecte dans la page le rang LOCAL que le tableau de bord calculait avant le
 * correctif (son index dans sa propre liste, plus courte). Le banc DOIT alors échouer
 * sur un compte qui a au moins une boîte partagée — et il annonce HARNESS, sans rien
 * conclure, sur un compte qui n'en a aucune, puisque les deux listes y sont identiques.
 *
 * Exige un serveur qui tourne et les identifiants SYNAPMAIL_TEST_* (.env).
 *   node scripts/check-account-badge-parity.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import puppeteer from 'puppeteer-core'
// La palette n'est PAS retapée : le contrôle négatif rejoue l'ancien rang avec les
// couleurs du produit, pour qu'une évolution de la palette ne le fasse pas mesurer
// autre chose que ce qu'il prétend rejouer.
import { ACCOUNT_PALETTE } from '../lib/accountColor.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIEWPORT = { width: 1440, height: 900 }
/** Le temps laissé à React pour reposer ses styles après une navigation. */
const SETTLE_MS = 700
// Large : le serveur de développement COMPILE la page au premier passage. Ce délai
// borne une attente d'outillage, pas une mesure du produit.
const NAV_TIMEOUT_MS = 120000
/** Delai laisse a Chrome pour se fermer proprement avant d'etre tue — cf. le `finally`. */
const CLOSE_TIMEOUT_MS = 5000

const NEGATIVE = process.argv.includes('--negative')

/** La bulle publie la boîte qu'elle peint : une seule source de sélecteur, tous écrans. */
const BUBBLE = id => `[data-account-badge="${id}"]`
const SIDEBAR_ACCOUNT = '[data-sidebar-row="account"]'
const DASHBOARD_TRIGGER = '[data-dashboard-account-trigger]'

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
  if (!v) { console.error(`HARNESS: ${k} n'est pas renseigné`); process.exit(2) }
}

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}
/**
 * Sortie d'OUTILLAGE : le banc n'a rien pu mesurer, il ne conclut RIEN sur le produit.
 * `process.exit` court-circuite le `finally`, donc le navigateur est tué ICI : sans cela
 * chaque passage interrompu laissait un Chrome sans tête derrière lui (mesuré : 44
 * processus orphelins, charge moyenne 288, les passages suivants expirant sur le
 * protocole — une panne de banc que rien ne distinguait d'une panne de produit).
 */
let liveBrowser = null
const harness = msg => {
  console.error(`HARNESS: ${msg}`)
  liveBrowser?.process()?.kill('SIGKILL')
  process.exit(2)
}

/**
 * Le défaut ne se manifeste QUE sur un compte qui voit une boîte dont il n'est pas
 * propriétaire : sans partage, la liste réduite du tableau de bord est identique à la
 * liste partagée et les rangs coïncident par accident. Le banc met donc lui-même le
 * compte de test dans cette condition — un partage ACTIF venu d'un autre utilisateur —
 * et le retire dans le `finally`, pour laisser la base comme il l'a trouvée.
 */
const db = new pg.Client({ connectionString: DB_URL })
/** L'identifiant du partage créé par CE passage, s'il l'a créé. */
let borrowedShare = null

const lendOneMailbox = async () => {
  const me = (await db.query('SELECT id FROM users WHERE email = $1', [EMAIL])).rows[0]
  if (!me) harness(`aucun utilisateur ${EMAIL} en base`)
  const lender = (await db.query(
    `SELECT a.id, a.email FROM email_accounts a
      WHERE a.user_id <> $1
        AND NOT EXISTS (SELECT 1 FROM account_shares s
                         WHERE s.account_id = a.id AND s.invitee_user_id = $1)
      ORDER BY a.created_at ASC LIMIT 1`, [me.id])).rows[0]
  if (!lender) return null
  const row = (await db.query(
    `INSERT INTO account_shares (account_id, invited_by, invitee_user_id, status,
       can_send, can_delete, can_organize, can_manage_rules, can_manage_signatures, accepted_at)
     SELECT $1, a.user_id, $2, 'active', true, true, true, true, true, NOW()
       FROM email_accounts a WHERE a.id = $1
     RETURNING id`, [lender.id, me.id])).rows[0]
  console.log(`condition posée : ${lender.email} prêtée au compte de test (partage ${row.id.slice(0, 8)})`)
  return row.id
}

await db.connect().catch(e => harness(`base injoignable — ${e.message}`))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 })
  .catch(e => harness(`Chrome ne démarre pas — ${e.message}`))
liveBrowser = browser

try {
  const page = await browser.newPage()
  await page.setViewport(VIEWPORT)
  page.setDefaultTimeout(NAV_TIMEOUT_MS)

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
  if (!loggedIn) harness('connexion refusée')
  // La CONDITION du défaut, posée avant toute lecture : une boîte visible dont le compte
  // de test n'est pas propriétaire. Sans elle le banc mesure un cas où les deux listes
  // coïncident, et il passe au vert sans rien avoir éprouvé.
  borrowedShare = await lendOneMailbox()
  // La session est posée : on repart d'un document servi AVEC le cookie.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })

  // La liste de RÉFÉRENCE est celle que l'application sert à la barre latérale et aux
  // réglages : c'est elle qui définit l'ensemble ET l'ordre dont dépendent les couleurs.
  // Elle est lue APRÈS une navigation : le cookie de session vient d'être posé par la
  // réponse de connexion, et un `fetch` lancé depuis le document encore en place ne le
  // présente pas (mesuré : 0 boîte renvoyée alors que la base en contient 7).
  const accounts = await page.evaluate(async base => {
    const body = await (await fetch(`${base}/api/accounts`, { credentials: 'same-origin' })).json()
    return (body.data ?? []).map(a => ({ id: a.id, email: a.email, name: a.name ?? '', isShared: !!a.isShared }))
  }, BASE)
  if (accounts.length < 2) harness(`${accounts.length} boîte(s) lues sur le compte de test — il en faut au moins 2`)
  const shared = accounts.filter(a => a.isShared)
  console.log(`contexte : ${accounts.length} boîte(s) visibles, dont ${shared.length} reçue(s) en partage`)
  // Sans boîte reçue, les rangs des deux listes coïncident et le banc ne peut RIEN dire
  // du défaut : c'est une panne de banc, pas un produit sain.
  if (!shared.length) {
    harness('aucune boîte reçue en partage n\'a pu être posée — la liste réduite du tableau '
      + 'de bord serait identique à la liste partagée, et le défaut ne peut pas se manifester')
  }

  if (NEGATIVE) {
    // Le rang tel que le tableau de bord le calculait AVANT le correctif : l'index de la
    // boîte dans SA PROPRE liste — les boîtes POSSÉDÉES seules, donc décalé d'un cran par
    // boîte reçue qui la précède. Il est réinjecté en repeignant les bulles du tableau de
    // bord avec la couleur de ce rang-là ; le style en ligne n'est pas géré par React, il
    // survit aux rendus. Le banc DOIT alors voir rouge.
    const ownedOrder = accounts.filter(a => !a.isShared).map(a => a.id)
    await page.evaluateOnNewDocument((owned, palette) => {
      setInterval(() => {
        if (!location.pathname.startsWith('/dashboard')) return
        for (const b of document.querySelectorAll('[data-account-badge]')) {
          const rank = owned.indexOf(b.getAttribute('data-account-badge'))
          if (rank >= 0) b.style.backgroundColor = palette[rank % palette.length]
        }
      }, 50)
    }, ownedOrder, ACCOUNT_PALETTE)
  }

  /**
   * La couleur de fond CALCULÉE et les initiales RENDUES de chaque bulle présente,
   * indexées par boîte. Une boîte peinte deux fois sur le même écran doit l'être à
   * l'identique : c'est vérifié ici, avant toute comparaison entre écrans.
   */
  const readScreen = async label => {
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const painted = await page.evaluate(() => {
      const out = {}
      for (const el of document.querySelectorAll('[data-account-badge]')) {
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        const id = el.getAttribute('data-account-badge')
        const s = getComputedStyle(el)
        const seen = {
          background: s.backgroundColor,
          letters: el.querySelector('[data-account-initial]')?.textContent ?? '',
        }
        if (!out[id]) { out[id] = seen; continue }
        if (out[id].background !== seen.background || out[id].letters !== seen.letters) {
          out[id].conflict = `${out[id].background}/${out[id].letters} vs ${seen.background}/${seen.letters}`
        }
      }
      return out
    })
    for (const [id, paint] of Object.entries(painted)) {
      if (paint.conflict) check(`${label} : une seule couleur pour la boîte ${id}`, false, paint.conflict)
    }
    console.log(`  ${label} : ${Object.keys(painted).length} bulle(s) lue(s)`)
    return painted
  }

  // 1. La barre latérale, liste des boîtes DÉPLIÉE — l'état est gardé côté serveur, donc
  // il est posé explicitement : un passage précédent a pu la laisser repliée.
  await page.evaluate(async base => {
    await fetch(`${base}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sidebar_collapsed: false }),
    })
  }, BASE)
  // JAMAIS `networkidle2` : l'application garde un flux d'événements (`/api/stream`)
  // ouvert en permanence, donc le réseau ne retombe jamais au calme et l'attente expire
  // sans rien dire du produit. On attend ce qu'on va MESURER : la bulle rendue.
  await page.goto(`${BASE}/mail`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(SIDEBAR_ACCOUNT)
  await page.click(SIDEBAR_ACCOUNT)
  const sidebar = await readScreen('barre latérale')

  // 2. Réglages → Comptes.
  await page.goto(`${BASE}/settings/accounts`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-account-badge]')
  const settings = await readScreen('réglages → comptes')

  // 3. + 4. Le tableau de bord : ses pastilles de mails, puis son sélecteur déplié.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  // Le sélecteur est l'un des QUATRE écrans que le gate humain exige. S'il ne s'ouvre
  // pas, le banc n'a pas le droit de conclure : il le passait en silence et rendait un
  // vert qui ne couvrait que trois écrans sur quatre (mesuré : 0 bulle lue côté
  // sélecteur, aucune ligne au rapport, sortie 0).
  await page.waitForSelector(DASHBOARD_TRIGGER)
    .catch(() => harness('le sélecteur du tableau de bord ne rend pas son bouton — '
      + 'un des quatre écrans exigés ne peut pas être lu'))
  const dashboardRows = await readScreen('tableau de bord (pastilles de mails)')
  await page.click(DASHBOARD_TRIGGER)
  const dashboardPicker = await readScreen('tableau de bord (sélecteur)')
  if (!Object.keys(dashboardPicker).length) {
    harness('le sélecteur du tableau de bord s\'est ouvert sans peindre une seule bulle')
  }

  const screens = [
    ['barre latérale', sidebar],
    ['réglages → comptes', settings],
    ['tableau de bord (pastilles)', dashboardRows],
    ['tableau de bord (sélecteur)', dashboardPicker],
  ]

  // Le critère : pour chaque boîte, les écrans qui la peignent la peignent PAREIL.
  // Une boîte absente d'un écran n'est pas un échec (le tableau de bord ne liste que
  // les boîtes possédées) ; deux couleurs pour une même boîte en est un.
  let compared = 0
  for (const account of accounts) {
    const seen = screens
      .map(([label, paint]) => [label, paint[account.id]])
      .filter(([, paint]) => !!paint)
    const who = `${account.name || account.email}${account.isShared ? ' (reçue en partage)' : ''}`
    if (seen.length < 2) {
      console.log(`  --   ${who} : peinte sur ${seen.length} écran(s), rien à comparer`)
      continue
    }
    compared++
    const colours = [...new Set(seen.map(([, p]) => p.background))]
    check(`${who} : même couleur sur les ${seen.length} écrans qui la peignent`,
      colours.length === 1,
      seen.map(([label, p]) => `${label} = ${p.background}`).join(' | '))
    const letters = [...new Set(seen.map(([, p]) => p.letters))]
    check(`${who} : mêmes initiales sur les ${seen.length} écrans`,
      letters.length === 1,
      seen.map(([label, p]) => `${label} = "${p.letters}"`).join(' | '))
  }
  if (!compared) harness('aucune boîte n\'est peinte sur deux écrans à la fois — le banc n\'a rien mesuré')
  console.log(`${compared} boîte(s) comparées sur au moins deux écrans`)
} finally {
  // La BASE d'abord : le navigateur peut trainer, le partage prete ne doit pas rester.
  if (borrowedShare) await db.query('DELETE FROM account_shares WHERE id = $1', [borrowedShare])
  await db.end()
  // `browser.close()` attend la fermeture propre de chaque page ; or l'application garde
  // un flux `/api/stream` ouvert en permanence, et l'attente ne retombe jamais (mesure :
  // le banc rendait son verdict puis restait bloque la, sans jamais sortir). On lui laisse
  // un delai borne, puis on tue le processus : le verdict a deja ete calcule.
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, CLOSE_TIMEOUT_MS))])
  browser.process()?.kill('SIGKILL')
}

if (NEGATIVE) {
  if (failures.length) {
    console.log(`check-account-badge-parity --negative : rouge comme attendu (${failures.length} échec(s))`)
    process.exit(0)
  }
  console.error('check-account-badge-parity --negative : VERT alors que le rang local est réinjecté — le banc ne mesure rien')
  process.exit(1)
}
if (failures.length) {
  console.error(`check-account-badge-parity : ${failures.length} échec(s)`)
  process.exit(1)
}
console.log('check-account-badge-parity : OK')
