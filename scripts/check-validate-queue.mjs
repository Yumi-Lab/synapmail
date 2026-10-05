#!/usr/bin/env node
/**
 * La file « À valider » AU CLAVIER (lot T15, gate du 04/10 NO-GO) — au vrai clavier, sur une
 * boîte semée. Mesure ce que le gate a vu échouer :
 *
 *   Q1. 100 gestes `Entrée` d'affilée traversent la page de 50 : la page suivante EST demandée
 *       quand un geste vide la liste (plus de requêtes `queue=1` qu'au chargement), aucun
 *       blocage, 100 lignes `humain` en base, 0 ligne moteur ajoutée ;
 *   Q2. « à valider » = ce que le serveur dit moins ce qu'on a jugé depuis — jamais soustrait deux
 *       fois après une relance ; les pastilles de raison se décrémentent pendant la session ;
 *   Q3. `s` sur les dernières lignes puis la file se vide : le SECOND TOUR des passées est servi
 *       (« file vide » n'apparaît que quand le compteur dit 0) ;
 *   Q4. `z` SUPPRIME la ligne `humain` qu'on vient d'écrire (0 ligne humaine en base sur cette
 *       question, la ligne du moteur intacte), la ligne revient à l'écran, « validées » − 1 ;
 *   Q5. le chrono est UN chrono de session : il ne redémarre pas à chaque geste et s'arrête
 *       quand la file est vide.
 *
 * Banc DB + navigateur : il sème SA boîte (hôte `.invalid`), la supprime dans son `finally`
 * (CASCADE). Aucun IMAP, aucun moteur, aucune boîte réelle touchée.
 *   node --experimental-strip-types --no-warnings scripts/check-validate-queue.mjs
 *   … --negative : relit la file avec la garde d'avant le correctif (refetch sur l'identité SWR)
 *   simulée côté banc — Q1 DOIT virer au rouge. Ici le contrôle négatif est structurel : on
 *   coupe le réseau sur la 2ᵉ page (`page=` jamais servie → la file reste bloquée au 50ᵉ geste).
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL } = process.env
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL })) if (!v) harness(`${k} n'est pas renseigné`)
const NEGATIVE = process.argv.includes('--negative')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const NAV_TIMEOUT_MS = 180000
/** Le temps laissé à un geste pour se poser (PUT + re-rendu) avant de le compter bloqué. */
const GESTURE_MAX_MS = 15000
const PAGE_SIZE = 50
const GESTURES = 100
/** Assez de lignes pour deux pages et quelques-unes de plus (second tour des passées). */
const MAILS = 60

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

const { initDb, query } = await import('../lib/db.ts')
const store = await import('../lib/tagging/store.ts')
const audit = await import('../lib/tagging/audit.ts')
const { DEFAULT_SET, valuesOf } = await import('../lib/tagging/questions.ts')
await initDb()

const BOX = `validate-bench@bench.invalid`
const JEV = { id: '00000000-0000-4000-8000-0000000015d1', nom: 'JEV banc validate' }
let ACCOUNT = null
let browser = null
console.log(`\nbanc de la file « À valider » au clavier${NEGATIVE ? ' (contrôle négatif)' : ''}\n`)
try {
  const [u] = await query(`SELECT id FROM users WHERE email = $1`, [EMAIL])
  if (!u) harness('utilisateur de banc introuvable')
  await query(`DELETE FROM email_accounts WHERE email = $1`, [BOX])
  const [acc] = await query(
    `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
     VALUES ($1, 'Banc validate', $2, 'imap.bench.invalid', 993, true, 'smtp.bench.invalid', 587, false, $2, 'bench-not-a-real-secret') RETURNING id`, [u.id, BOX])
  ACCOUNT = acc.id
  const QS = ['categorie', 'intention'].map(id => DEFAULT_SET.questionById(id))
  for (let i = 0; i < MAILS; i++) {
    const state = { expediteur: { nom: `Banc ${i}`, adresse: `banc${i}@bench.invalid` }, objet: `Message ${i}`, corps: `Corps du message ${i}.` }
    const tags = QS.map((q, k) => ({ question: q.id, valeur: valuesOf(q)[(i + k) % valuesOf(q).length], confiance: 0.3 }))
    await store.writeTags({ accountId: ACCOUNT, messageId: `<validate-bench-${i}@bench.invalid>`, source: 'jev', auteur: JEV, modele: 'jev-banc', tags,
      position: { folder: 'INBOX', uid: 7000 + i, fromName: `Banc ${i}`, fromAddress: `banc${i}@bench.invalid`, subject: `Message ${i}`, date: new Date(Date.now() - i * 60_000) }, state })
  }
  const seeded = await audit.validationQueue(ACCOUNT, 1, 200)
  if (seeded.total !== MAILS * QS.length) harness(`graine : ${seeded.total} lignes au lieu de ${MAILS * QS.length}`)
  const engineRows = async () => (await query(`SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1 AND source <> 'humain'`, [ACCOUNT]))[0].n
  const humanRows = async () => (await query(`SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1 AND source = 'humain'`, [ACCOUNT]))[0].n
  const engineBefore = await engineRows()

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], protocolTimeout: 240000 })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(NAV_TIMEOUT_MS)
  const queueCalls = []
  page.on('request', req => { if (req.url().includes('queue=1')) queueCalls.push(req.url()) })
  let blockQueue = false
  if (NEGATIVE) {
    // Le contrôle négatif : la suite n'arrive jamais (comme avant le correctif, où elle n'était
    // jamais demandée) — toute requête de file APRÈS le chargement initial est avalée.
    await page.setRequestInterception(true)
    page.on('request', req => { if (blockQueue && req.url().includes('queue=1')) req.abort(); else req.continue() })
  }
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  const loggedIn = await page.evaluate(async ({ base, email, password }) => {
    const { csrfToken } = await (await fetch(`${base}/api/auth/csrf`)).json()
    const res = await fetch(`${base}/api/auth/callback/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfToken, email, password, json: 'true' }) })
    return res.ok
  }, { base: BASE, email: EMAIL, password: PASSWORD })
  if (!loggedIn) harness('connexion refusée')
  const [prefs] = await query(`SELECT active_account_id FROM user_settings WHERE user_id = $1`, [u.id])

  await page.goto(`${BASE}/validate?account=${ACCOUNT}`, { waitUntil: 'domcontentloaded' })
  const rendered = () => page.waitForFunction(a => document.querySelector(`[data-validate-account="${a}"]`) && document.querySelector('[data-validate-list]'), {}, ACCOUNT)
  // Juste après un commit qui touche l'écran, Next dev compile `/validate` à froid : sous charge (load
  // > 150) cette première compilation a dépassé NAV_TIMEOUT (mesuré le 04/10 07:02, 180 s). La page est
  // alors compilée : UN rechargement suffit, et il est dit — un banc qui meurt avant la mesure ne mesure rien.
  try { await rendered() } catch { console.log('  (premier rendu > NAV_TIMEOUT : compilation à froid sous charge — rechargement unique)'); await page.reload({ waitUntil: 'domcontentloaded' }); await rendered() }
  await new Promise(r => setTimeout(r, 1500))
  const callsAtLoad = queueCalls.length
  blockQueue = true

  const read = () => page.evaluate(() => {
    const n = (sel, attr) => { const el = document.querySelector(sel); return el ? Number(el.getAttribute(attr)) : null }
    const act = document.querySelector('[data-validate-active]')
    return {
      done: n('[data-validate-done]', 'data-validate-done'), remaining: n('[data-validate-remaining]', 'data-validate-remaining'),
      clock: n('[data-validate-clock]', 'data-validate-clock'), list: n('[data-validate-list]', 'data-validate-list'),
      empty: !!document.querySelector('[data-validate-empty]'), failed: document.querySelector('[data-validate-failed]')?.textContent ?? null,
      pills: Object.fromEntries([...document.querySelectorAll('[data-validate-reason-count]')].map(e => [e.getAttribute('data-validate-reason-count'), Number(e.getAttribute('data-validate-reason-n'))])),
      current: act ? { question: act.getAttribute('data-validate-item'), value: act.querySelector('[data-validate-value]')?.getAttribute('data-validate-value'), head: act.querySelector('div').textContent } : null,
    }
  })
  /** Un geste, puis l'attente que l'écran ait bougé (validées ou liste), bornée : un blocage est une mesure. */
  const gesture = async (key, pred) => {
    const before = await read()
    const t0 = Date.now()
    await page.keyboard.press(key)
    try {
      await page.waitForFunction(new Function('b', `const n=(s,a)=>{const e=document.querySelector(s);return e?Number(e.getAttribute(a)):null};const done=n('[data-validate-done]','data-validate-done');const list=n('[data-validate-list]','data-validate-list');const empty=!!document.querySelector('[data-validate-empty]');const act=document.querySelector('[data-validate-active]');const head=act?act.querySelector('div').textContent:null;return (${pred})`), { timeout: GESTURE_MAX_MS, polling: 'raf' }, before)
      return { ok: true, ms: Date.now() - t0, before }
    } catch { return { ok: false, ms: Date.now() - t0, before } }
  }
  const s0 = await read()
  check('Q0 la file se rend : 50 lignes, à valider = total, pastille « confiance basse » = total, 0 validée',
    s0.list === PAGE_SIZE && s0.remaining === seeded.total && s0.pills.confidence === seeded.total && s0.done === 0, JSON.stringify(s0))

  // ---- Q1. 100 Entrées d'affilée ----
  const stuck = []
  const times = []
  let crossed = null
  let t0 = Date.now()
  for (let i = 1; i <= GESTURES; i++) {
    const r = await gesture('Enter', 'done === b.done + 1 && (list > 0 || empty) && !!act')
    times.push(r.ms)
    if (!r.ok) { stuck.push({ gesture: i, ms: r.ms, screen: await read() }); break }
    if (i === PAGE_SIZE) crossed = await read()
  }
  const wall = Date.now() - t0
  const s1 = await read()
  const humanAfter = await humanRows()
  const pairs = (await query(`SELECT COUNT(DISTINCT (message_id, question))::int AS n FROM message_tags WHERE account_id = $1 AND source = 'humain'`, [ACCOUNT]))[0].n
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
  check(`Q1a ${GESTURES} gestes Entrée d'affilée, sans blocage ni F5 (médiane ${median} ms/geste, ${(wall / 1000).toFixed(1)} s au total)`,
    stuck.length === 0 && s1.done === GESTURES && !s1.failed, JSON.stringify({ stuck: stuck[0], done: s1.done, failed: s1.failed }))
  check('Q1b la page suivante a été demandée par les gestes (requêtes queue=1 après le chargement ≥ 1), au 50ᵉ geste la liste est repeuplée',
    queueCalls.length > callsAtLoad && crossed && crossed.list > 0 && !crossed.empty, JSON.stringify({ atLoad: callsAtLoad, total: queueCalls.length, crossed }))
  check(`Q1c en base : ${GESTURES} lignes humain sur ${GESTURES} paires (mail, question) distinctes, 0 ligne moteur ajoutée`,
    humanAfter === GESTURES && pairs === GESTURES && (await engineRows()) === engineBefore, JSON.stringify({ humanAfter, pairs, engineBefore, engineNow: await engineRows() }))
  check('Q1d l’objectif : 100 étiquettes en moins de 5 minutes', wall < 300_000, `${wall} ms`)

  // ---- Q2. compteurs ----
  const serverNow = await audit.validationQueue(ACCOUNT, 1, 1)
  check('Q2a « à valider » après 100 gestes et une relance = ce qui reste côté serveur (jamais soustrait deux fois)',
    s1.remaining === serverNow.total && serverNow.total === seeded.total - GESTURES, JSON.stringify({ screen: s1.remaining, server: serverNow.total }))
  check('Q2b la pastille « confiance basse » a suivi : ' + s1.pills.confidence, s1.pills.confidence === serverNow.counts.confidence, JSON.stringify({ pills: s1.pills, server: serverNow.counts }))

  // ---- Q4. défaire ----
  const beforeUndo = await read()
  const lastJudged = (await query(`SELECT message_id, question FROM message_tags WHERE account_id = $1 AND source = 'humain' ORDER BY cree_le DESC LIMIT 1`, [ACCOUNT]))[0]
  const rz = await gesture('z', 'done === b.done - 1 && list === b.list + 1')
  const afterUndo = await read()
  const humanOnUndone = (await query(`SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1 AND message_id = $2 AND question = $3 AND source = 'humain'`, [ACCOUNT, lastJudged.message_id, lastJudged.question]))[0].n
  const engineOnUndone = (await query(`SELECT COUNT(*)::int AS n FROM message_tags WHERE account_id = $1 AND message_id = $2 AND question = $3 AND source <> 'humain'`, [ACCOUNT, lastJudged.message_id, lastJudged.question]))[0].n
  check('Q4a `z` : la ligne revient à l’écran (liste + 1, validées − 1), « à valider » + 1',
    rz.ok && afterUndo.done === beforeUndo.done - 1 && afterUndo.list === beforeUndo.list + 1 && afterUndo.remaining === beforeUndo.remaining + 1, JSON.stringify({ beforeUndo, afterUndo }))
  check('Q4b en base : 0 ligne `humain` sur la question défaite, la ligne du moteur intacte, 99 lignes humain au total',
    humanOnUndone === 0 && engineOnUndone === 1 && (await humanRows()) === GESTURES - 1, JSON.stringify({ humanOnUndone, engineOnUndone, total: await humanRows() }))
  const serverAfterUndo = await audit.validationQueue(ACCOUNT, 1, 200)
  check('Q4c l’item défait est de retour dans la file côté serveur', serverAfterUndo.items.some(i => i.messageId === lastJudged.message_id && i.question === lastJudged.question), String(serverAfterUndo.total))

  // ---- Q5. chrono de session ----
  const clockA = (await read()).clock
  await new Promise(r => setTimeout(r, 2200))
  const clockB = (await read()).clock
  check('Q5a le chrono tourne pendant la session (sans geste, +2 s en 2,2 s) et n’a pas redémarré au geste (≥ durée des 100 gestes)',
    clockB >= clockA + 2 && clockA >= Math.floor(wall / 1000), JSON.stringify({ clockA, clockB, wallS: wall / 1000 }))

  // ---- Q3. passer, puis le second tour ----
  // Il reste 21 lignes (120 − 99). On en passe 2, on juge le reste : le second tour doit servir les 2 passées.
  const r1 = await gesture('s', 'list === b.list - 1')
  const r2 = await gesture('s', 'list === b.list - 1')
  let emptyEarly = null
  for (let i = 0; i < 40; i++) {
    const s = await read()
    if (s.empty) { if (s.remaining > 0) emptyEarly = s; break }
    if (!s.current) break
    const r = await gesture('Enter', 'done === b.done + 1 && (list > 0 || empty)')
    if (!r.ok) { emptyEarly = { stuck: true, screen: await read() }; break }
  }
  const end = await read()
  const finalServer = await audit.validationQueue(ACCOUNT, 1, 1)
  check('Q3a passer ×2 retire les lignes sans écrire ; puis le second tour des passées est servi : la file ne dit « vide » qu’à 0 restant',
    r1.ok && r2.ok && emptyEarly === null && end.empty && end.remaining === 0 && finalServer.total === 0 && (await humanRows()) === seeded.total,
    JSON.stringify({ r1: r1.ok, r2: r2.ok, emptyEarly, end, server: finalServer.total, human: await humanRows() }))
  await new Promise(r => setTimeout(r, 2200))
  const clockEnd = (await read()).clock
  check('Q5b file vide : le chrono est arrêté (figé à ' + end.clock + ' s)', clockEnd === end.clock, JSON.stringify({ atEnd: end.clock, later: clockEnd }))

  // La préférence de boîte active n'a pas bougé (l'écran a basculé sur la boîte de banc par l'URL).
  if (prefs) await query(`UPDATE user_settings SET active_account_id = $2 WHERE user_id = $1`, [u.id, prefs.active_account_id])
} finally {
  if (browser) await browser.close().catch(() => {})
  if (ACCOUNT) await query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]).catch(() => {})
}

if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nfile « À valider » : OK')
process.exit(0)
