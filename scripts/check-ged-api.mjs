#!/usr/bin/env node
/**
 * Banc du lot G5 (décision 7) : les routes `/api/documents/*` tiennent leurs refus et font ce
 * qu'elles disent. Mesure sur une instance VIVE, avec de vraies requêtes HTTP et de vraies lignes en
 * base — pas une lecture de source. Neuf bras :
 *
 *   A. la PORTÉE : une clé sans `documents:read` est refusée par un 403 QUI LA NOMME ; sans
 *      `documents:write`, idem en écriture ;
 *   B. la BOÎTE : une clé à qui la boîte n'est pas cochée est refusée par un 403 qui NOMME la boîte —
 *      par `?account=` ET par l'OBJET du chemin (un dossier d'une autre boîte : `ACCOUNT_BY_OBJECT`) ;
 *   C. les DOSSIERS : créer (201), doublon de frère (409), renommer efface `auto`, déplacer sous
 *      soi-même (409), supprimer → les documents retombent « à ranger », jamais effacés ;
 *   D. le RANGEMENT : une session range en `humain` et apprend ; une clé range en `agent` ; la liste
 *      filtre par dossier, `unfiled`, et cherche dans le texte OCR ;
 *   E. la FUSION (remarque du gate G3/G4) : un dossier proposé fusionné dans un dossier humain — ses
 *      documents, motifs et sous-dossiers y passent, `into` cesse d'être proposé, `from` disparaît ;
 *      fusion dans soi-même 409, dans un dossier d'une autre boîte 404 ;
 *   F. les MOTIFS : un SIRET à clé fausse est refusé par un 422 qui le nomme ; un IBAN entier entre
 *      RÉDUIT et ne ressort jamais en clair ; lister, supprimer ;
 *   G. les identifiants PROPRES : genre interdit 422, boîte non GED 409, aller-retour ;
 *   H. la GARDE : à une clé, le texte OCR et le nom de fichier sont annoncés donnée EXTERNE
 *      (`aiSafety.untrustedFields`) ; à une session, rien de tel ;
 *   I. PDF et PAGES : page 0 et dpi hors borne → 400 ; document inconnu → 404 ; boîte injoignable → 502.
 *
 * DANGER, respecté ici : la boîte d'essai vise un hôte VOLONTAIREMENT injoignable (`.invalid`,
 * RFC 2606) et elle est supprimée dans le `finally` (CASCADE sur toutes les tables ged_*). Seul le
 * bras I ouvre une connexion IMAP — vers cet hôte qui n'existe pas. Aucun tesseract, aucun moteur.
 *
 *   node --experimental-strip-types scripts/check-ged-api.mjs
 *   node --experimental-strip-types scripts/check-ged-api.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les clés reçoivent TOUTES les portées et TOUTES les boîtes —
 * l'état du produit si la barrière ne restreignait rien. A et B DOIVENT tomber ; le reste tient.
 */
import './alias-resolver.mjs'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

const { ALL_SCOPES } = await import('../lib/apiScopes.ts')
const { HUMAN_SOURCE } = await import('../lib/tagging/engine.ts')
const { AUTO_ROOT_NAME } = await import('../lib/ged/filing.ts')
const { UNFILED } = await import('../lib/ged/documents.ts')

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}
const { SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
for (const [k, v] of Object.entries({ SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL, SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL })) if (!v) harness(`${k} n'est pas renseigné`)

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}
const call = async (path, { method = 'GET', key, cookie, body } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* rapporté via `text` */ }
  return { status: res.status, body: parsed, text, type: res.headers.get('content-type') ?? '' }
}
const brief = r => `reçu ${r.status} — ${r.text.slice(0, 160)}`

// Clés VRAIES (Luhn / TVA / mod 97), les mêmes fixtures que check-ged-filing.mjs.
// L'IBAN en clair se cherche dans les `valeur` SEULEMENT : le corps entier porte des UUID aléatoires
// (id, folderId) où la suite « 0112 » finit par tomber — F4 rouge sans qu'aucun IBAN ne fuie.
const SIRET_A = '912 345 678 00011', TVA_A = 'FR74912345678', IBAN_A = 'FR76 3000 6000 0112 3456 7890 189', SIRET_B = '845 210 367 00015'
const TEXT_FEDEX = n => `FEDEX EXPRESS FR SAS\n2 rue du Test, 75000 Paris\nSIRET ${SIRET_A}  TVA intracom. ${TVA_A}\nFacture n° ${n}  Total 12,34 EUR\nIBAN ${IBAN_A}\fPage 2. Détail des prestations.`
const TEXT_ARTI = n => `ARTILLERY3D SARL\nZone industrielle\nSIRET ${SIRET_B}\nFacture AR-${n}  Total 567,89 EUR\fPage 2.`

console.log(`\nbanc des routes documents GED (lot G5)${NEGATIVE ? ' — CONTRÔLE NÉGATIF (tout accordé)' : ''}\n`)

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [], accounts: [] }
const tag = crypto.randomBytes(4).toString('hex')

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id
  if ((await call('/login')).status !== 200) harness(`le serveur de dev ne répond pas sur ${BASE}/login`)

  const makeKey = async (name, scopes, accountIds) => {
    const raw = `syn_${crypto.randomBytes(24).toString('hex')}`
    const row = await pool.query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW(), NOW()) RETURNING id`,
      [userId, `bench g5 ${name}`, raw.slice(0, 12), crypto.createHash('sha256').update(raw).digest('hex'), NEGATIVE ? ALL_SCOPES : scopes])
    created.keys.push(row.rows[0].id)
    const granted = NEGATIVE ? (await pool.query('SELECT id FROM email_accounts WHERE user_id = $1', [userId])).rows.map(r => r.id) : accountIds
    for (const a of granted) await pool.query('INSERT INTO api_key_accounts (api_key_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.rows[0].id, a])
    return raw
  }
  const insertMailbox = async (ged) => {
    const email = `g5-${tag}-${crypto.randomBytes(2).toString('hex')}@banc-g5.invalid`
    const row = await pool.query(
      `INSERT INTO email_accounts (user_id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_encrypted)
       VALUES ($1, 'banc g5', $2, 'imap.banc-g5.invalid', 993, true, 'smtp.banc-g5.invalid', 587, false, $2, 'banc-not-a-real-secret') RETURNING id`, [userId, email])
    created.accounts.push(row.rows[0].id)
    if (ged) await pool.query(`INSERT INTO ged_mailboxes (account_id) VALUES ($1)`, [row.rows[0].id])
    return row.rows[0].id
  }
  const ACCOUNT = await insertMailbox(true)
  const CLOSED = await insertMailbox(true)
  const PLAIN = await insertMailbox(false)

  const doc = async (account, n, text) => (await pool.query(
    `INSERT INTO ged_documents (account_id, message_id, folder, uid, part_idx, filename, from_address, subject, ocr_status, ocr_text, pages)
     VALUES ($1, $2, 'INBOX', $3, 0, $4, 'copieur@banc-g5.invalid', 'scan', 'fait', $5, 2) RETURNING id`,
    [account, `<g5-${tag}-${n}@banc-g5.invalid>`, n, `doc0${n}.pdf`, text])).rows[0].id
  const dbFolder = async (account, nom, parent = null, auto = false) => (await pool.query(
    `INSERT INTO ged_folders (account_id, parent_id, nom, auto) VALUES ($1, $2, $3, $4) RETURNING id`, [account, parent, nom, auto])).rows[0].id

  const D1 = await doc(ACCOUNT, 1, TEXT_FEDEX(1))
  const D2 = await doc(ACCOUNT, 2, TEXT_FEDEX(2))
  const D3 = await doc(ACCOUNT, 3, TEXT_ARTI(3))
  const closedFolder = await dbFolder(CLOSED, 'Ailleurs')

  const readerKey = await makeKey('reader', ['documents:read'], [ACCOUNT])
  const writerKey = await makeKey('writer', ['documents:read', 'documents:write'], [ACCOUNT])
  const blindKey = await makeKey('blind', ['messages:read'], [ACCOUNT])

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`connexion par identifiants refusée (${loginRes.status})`)

  // ---- A. la portée --------------------------------------------------------------------------
  console.log('A. la portée')
  const a1 = await call(`/api/documents?account=${ACCOUNT}`, { key: blindKey })
  check('A1 sans `documents:read` : 403 qui NOMME la portée', a1.status === 403 && a1.body?.missingScope === 'documents:read', brief(a1))
  const a2 = await call('/api/documents/folders', { method: 'POST', key: readerKey, body: { accountId: ACCOUNT, nom: 'X' } })
  check('A2 sans `documents:write` : 403 qui NOMME la portée', a2.status === 403 && a2.body?.missingScope === 'documents:write', brief(a2))

  // ---- B. la boîte ---------------------------------------------------------------------------
  console.log('B. la boîte')
  const b1 = await call(`/api/documents?account=${CLOSED}`, { key: readerKey })
  check('B1 boîte non cochée par `?account=` : 403 qui NOMME la boîte', b1.status === 403 && b1.body?.missingAccount === CLOSED, brief(b1))
  const b2 = await call(`/api/documents/folders/${closedFolder}`, { method: 'PATCH', key: writerKey, body: { nom: 'Pris' } })
  check('B2 boîte non cochée déduite de l’OBJET (dossier) : 403 qui NOMME la boîte', b2.status === 403 && b2.body?.missingAccount === CLOSED, brief(b2))
  const b3 = await call(`/api/documents?account=${CLOSED}`, { cookie })
  check('B3 une session n’est bornée par aucune liste de boîtes', b3.status === 200 && b3.body?.data?.documents?.length === 0, brief(b3))

  // ---- C. les dossiers -----------------------------------------------------------------------
  console.log('C. les dossiers')
  const c1 = await call('/api/documents/folders', { method: 'POST', cookie, body: { accountId: ACCOUNT, nom: '  FedEx  ' } })
  check('C1 créer : 201, nom nettoyé, racine', c1.status === 201 && c1.body?.data?.nom === 'FedEx' && c1.body.data.parentId === null && c1.body.data.auto === false, brief(c1))
  const FEDEX = c1.body?.data?.id
  const c2 = await call('/api/documents/folders', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, nom: 'FedEx' } })
  check('C2 un frère du même nom : 409 qui le nomme', c2.status === 409 && c2.body?.nom === 'FedEx', brief(c2))
  const c3 = await call('/api/documents/folders', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, nom: '2026', parentId: FEDEX } })
  check('C3 un sous-dossier : 201 avec son parent', c3.status === 201 && c3.body?.data?.parentId === FEDEX, brief(c3))
  const SUB = c3.body?.data?.id
  const c4 = await call(`/api/documents/folders/${FEDEX}`, { method: 'PATCH', key: writerKey, body: { parentId: SUB } })
  check('C4 déplacer un dossier sous son propre enfant : 409', c4.status === 409, brief(c4))
  const c5 = await call('/api/documents/folders', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, nom: 'Y', parentId: closedFolder } })
  check('C5 un parent d’une autre boîte : 404 qui le nomme', c5.status === 404 && c5.body?.parentId === closedFolder, brief(c5))
  const c6 = await call(`/api/documents/folders?account=${ACCOUNT}`, { key: readerKey })
  check('C6 lister : à plat, le sous-dossier porte son parentId, `unfiled` compte les 3 documents', c6.status === 200 && c6.body?.data?.folders?.some(f => f.id === SUB && f.parentId === FEDEX) && c6.body.data.unfiled === 3, brief(c6))

  // ---- D. le rangement -----------------------------------------------------------------------
  console.log('D. le rangement')
  const d1 = await call(`/api/documents/${D1}/filing`, { method: 'POST', cookie, body: { folderId: FEDEX } })
  check('D1 une session range en `humain` et apprend le SIRET', d1.status === 200 && d1.body?.data?.filing?.source === HUMAN_SOURCE && d1.body.data.learned.some(i => i.genre === 'siret' && i.valeur === '91234567800011'), brief(d1))
  check('D1b rien d’appris ne contient l’IBAN en clair', !JSON.stringify(d1.body?.data?.learned ?? []).includes('0112'), JSON.stringify(d1.body?.data?.learned))
  const d2 = await call(`/api/documents/${D3}/filing`, { method: 'POST', key: writerKey, body: { folderId: SUB } })
  check('D2 une clé range en `agent`, signé de la clé', d2.status === 200 && d2.body?.data?.filing?.source === 'agent' && /bench g5 writer/.test(d2.body.data.filing.auteurNom), brief(d2))
  const d3 = await call(`/api/documents/${D1}/filing`, { method: 'POST', key: writerKey, body: { folderId: closedFolder } })
  check('D3 ranger dans un dossier d’une autre boîte : 404 qui le nomme', d3.status === 404 && d3.body?.folderId === closedFolder, brief(d3))
  const d4 = await call(`/api/documents?account=${ACCOUNT}&folder=${FEDEX}`, { key: readerKey })
  check('D4 lister par dossier : le document rangé, et seulement lui', d4.status === 200 && d4.body?.data?.documents?.map(d => d.id).join() === D1 && d4.body.data.documents[0].filingSource === HUMAN_SOURCE, brief(d4))
  const d5 = await call(`/api/documents?account=${ACCOUNT}&folder=${UNFILED}`, { key: readerKey })
  check('D5 `folder=unfiled` : le document non rangé, `unfiled` = 1', d5.status === 200 && d5.body?.data?.documents?.map(d => d.id).join() === D2 && d5.body.data.unfiled === 1, brief(d5))
  const d6 = await call(`/api/documents?account=${ACCOUNT}&q=${encodeURIComponent('artillery3d')}`, { key: readerKey })
  check('D6 recherche dans le texte OCR : trouve le document qui le porte', d6.status === 200 && d6.body?.data?.documents?.map(d => d.id).join() === D3, brief(d6))
  const d7 = await call(`/api/documents/${D2}`, { key: readerKey })
  check('D7 détail d’un document non rangé : texte OCR, historique vide, suggestion vers le dossier qui a appris son SIRET', d7.status === 200 && d7.body?.data?.ocrText?.includes('FEDEX') && d7.body.data.filings.length === 0 && d7.body.data.suggestions?.some(s => s.folderId === FEDEX && s.strong), brief(d7))
  const d8 = await call(`/api/documents/${D1}/filing`, { method: 'POST', cookie, body: { folderId: 'pas-un-uuid' } })
  const d8b = await call(`/api/documents/pas-un-uuid`, { cookie })
  const d8c = await call(`/api/documents/patterns?account=${ACCOUNT}&folder=pas-un-uuid`, { cookie })
  check('D8 un identifiant qui n’est pas un UUID : 404 (corps, chemin) ou 400 (filtre) — jamais un 500 de Postgres', d8.status === 404 && d8b.status === 404 && d8c.status === 400, `${d8.status} / ${d8b.status} / ${d8c.status}`)

  // ---- E. la fusion --------------------------------------------------------------------------
  console.log('E. la fusion')
  const autoRoot = await dbFolder(ACCOUNT, AUTO_ROOT_NAME)
  const PROPOSED = await dbFolder(ACCOUNT, 'FEDEX EXPRESS FR SAS', autoRoot, true)
  const PROPOSED_SUB = await dbFolder(ACCOUNT, 'Relances', PROPOSED)
  await pool.query(`INSERT INTO ged_filings (document_id, folder_id, source, auteur_nom, dossier_nom, confiance) VALUES ($1, $2, 'motif', 'motif', 'FEDEX EXPRESS FR SAS', 0.5)`, [D2, PROPOSED])
  // Le SIRET et la raison sociale sont DÉJÀ sur `into` (appris en D1) : seule la regex doit passer.
  await pool.query(`INSERT INTO ged_patterns (folder_id, genre, valeur, auteur_nom) VALUES ($1, 'siret', '91234567800011', 'motif'), ($1, 'raison_sociale', 'FEDEX EXPRESS FR SAS', 'motif'), ($1, 'regex', 'fedex\\s+express', 'motif')`, [PROPOSED])
  await pool.query(`UPDATE ged_folders SET auto = true WHERE id = $1`, [FEDEX])
  const e1 = await call(`/api/documents/folders/${PROPOSED}/merge`, { method: 'POST', cookie, body: { into: PROPOSED } })
  check('E1 fusionner dans soi-même : 409', e1.status === 409, brief(e1))
  const e2 = await call(`/api/documents/folders/${PROPOSED}/merge`, { method: 'POST', cookie, body: { into: closedFolder } })
  check('E2 fusionner dans un dossier d’une autre boîte : 404 qui le nomme', e2.status === 404 && e2.body?.into === closedFolder, brief(e2))
  const e3 = await call(`/api/documents/folders/${PROPOSED}/merge`, { method: 'POST', cookie, body: { into: FEDEX } })
  check('E3 fusion : 1 document, 1 motif (siret et raison sociale déjà là restent), 1 sous-dossier, source humain', e3.status === 200 && e3.body?.data?.documents === 1 && e3.body.data.patterns === 1 && e3.body.data.folders === 1 && e3.body.data.source === HUMAN_SOURCE, brief(e3))
  const gone = await pool.query(`SELECT 1 FROM ged_folders WHERE id = $1`, [PROPOSED])
  const sub = await pool.query(`SELECT parent_id FROM ged_folders WHERE id = $1`, [PROPOSED_SUB])
  const into = await pool.query(`SELECT auto FROM ged_folders WHERE id = $1`, [FEDEX])
  const pats = await pool.query(`SELECT genre FROM ged_patterns WHERE folder_id = $1 ORDER BY genre`, [FEDEX])
  check('E4 en base : `from` disparu, son sous-dossier sous `into`, `into` n’est plus proposé', gone.rows.length === 0 && sub.rows[0]?.parent_id === FEDEX && into.rows[0]?.auto === false, JSON.stringify({ gone: gone.rows.length, sub: sub.rows[0], into: into.rows[0] }))
  check('E5 `into` porte exactement un motif par (genre, valeur) : siret ×1, raison_sociale ×1, la regex arrivée', pats.rows.filter(p => p.genre === 'siret').length === 1 && pats.rows.filter(p => p.genre === 'raison_sociale').length === 1 && pats.rows.some(p => p.genre === 'regex'), JSON.stringify(pats.rows))
  const e6 = await call(`/api/documents/${D2}`, { cookie })
  // L'historique est GARDÉ (décision 4) : la main qui a fusionné d'abord (effective), puis la ligne `motif` vers le dossier disparu, clé à NULL, nom figé.
  check('E6 le document fusionné : effectif = `into`, historique = la main puis la ligne `motif` vers le dossier disparu (folderId null, dossierNom figé)', e6.status === 200 && e6.body?.data?.folderId === FEDEX && e6.body.data.filings.map(f => f.source).join() === `${HUMAN_SOURCE},motif` && e6.body.data.filings[1].folderId === null && e6.body.data.filings[1].dossierNom === 'FEDEX EXPRESS FR SAS', brief(e6))

  // ---- F. les motifs -------------------------------------------------------------------------
  console.log('F. les motifs')
  const f1 = await call('/api/documents/patterns', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, folderId: FEDEX, genre: 'siret', valeur: '912 345 678 00012' } })
  check('F1 un SIRET à clé de Luhn fausse : 422 qui nomme genre et valeur', f1.status === 422 && f1.body?.genre === 'siret' && f1.body?.valeur === '912 345 678 00012', brief(f1))
  const f2 = await call('/api/documents/patterns', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, folderId: SUB, genre: 'iban4', valeur: IBAN_A } })
  check('F2 un IBAN entier entre RÉDUIT (30006…0189) et ne ressort pas en clair', f2.status === 201 && f2.body?.data?.valeur === '30006…0189', brief(f2))
  const f3 = await call('/api/documents/patterns', { method: 'POST', key: writerKey, body: { accountId: ACCOUNT, folderId: SUB, genre: 'regex', valeur: '(' } })
  check('F3 une regex invalide : 422', f3.status === 422 && f3.body?.genre === 'regex', brief(f3))
  const f4 = await call(`/api/documents/patterns?account=${ACCOUNT}&folder=${SUB}`, { key: readerKey })
  check('F4 lister par dossier : l’IBAN réduit + les motifs appris par la clé en D2', f4.status === 200 && f4.body?.data?.some(p => p.id === f2.body.data.id) && !f4.body.data.some(p => p.valeur.includes('0112')), brief(f4))
  const f5 = await call(`/api/documents/patterns/${f2.body?.data?.id}`, { method: 'DELETE', key: writerKey })
  const f5b = await call(`/api/documents/patterns/${f2.body?.data?.id}`, { method: 'DELETE', key: writerKey })
  check('F5 supprimer : 200 puis 404', f5.status === 200 && f5b.status === 404, `${f5.status} / ${f5b.status}`)

  // ---- G. les identifiants propres -----------------------------------------------------------
  console.log('G. les identifiants propres')
  const g1 = await call('/api/documents/own', { method: 'PUT', cookie, body: { accountId: ACCOUNT, propres: [{ genre: 'regex', valeur: 'x' }] } })
  check('G1 un genre qui n’est pas celui d’un destinataire : 422', g1.status === 422 && g1.body?.genre === 'regex', brief(g1))
  const g2 = await call('/api/documents/own', { method: 'PUT', cookie, body: { accountId: PLAIN, propres: [] } })
  check('G2 une boîte qui n’est pas une GED : 409', g2.status === 409, brief(g2))
  const g3 = await call('/api/documents/own', { method: 'PUT', key: writerKey, body: { accountId: ACCOUNT, propres: [{ genre: 'tva', valeur: 'fr74 912345678' }, { genre: 'tva', valeur: 'FR74912345678' }] } })
  const g4 = await call(`/api/documents/own?account=${ACCOUNT}`, { key: readerKey })
  check('G3 aller-retour : normalisé, dédoublonné', g3.status === 200 && g4.status === 200 && JSON.stringify(g4.body?.data?.propres) === JSON.stringify([{ genre: 'tva', valeur: 'FR74912345678' }]), `${brief(g3)} / ${brief(g4)}`)

  // ---- H. la garde ---------------------------------------------------------------------------
  console.log('H. la garde anti-injection')
  const h1 = await call(`/api/documents/${D1}`, { key: readerKey })
  const uf = h1.body?.aiSafety?.untrustedFields ?? []
  check('H1 à une clé, `ocrText`, `filename` et `pageTexts[].text` sont annoncés donnée externe', h1.status === 200 && ['ocrText', 'filename', 'pageTexts[].text'].every(f => uf.includes(f)), JSON.stringify(uf))
  const h2 = await call(`/api/documents/${D1}`, { cookie })
  check('H2 à une session, pas de bloc aiSafety', h2.status === 200 && !('aiSafety' in (h2.body ?? {})), brief(h2))

  // ---- I. PDF et pages -----------------------------------------------------------------------
  console.log('I. PDF et pages')
  const i1 = await call(`/api/documents/${D1}/pages/0`, { key: readerKey })
  const i2 = await call(`/api/documents/${D1}/pages/1?dpi=999`, { key: readerKey })
  check('I1 page 0 et dpi hors borne : 400, avant toute connexion', i1.status === 400 && i2.status === 400 && i2.body?.dpi === '999', `${i1.status} / ${brief(i2)}`)
  const i3 = await call(`/api/documents/${crypto.randomUUID()}/pdf`, { key: readerKey })
  check('I2 document inconnu : 404', i3.status === 404, brief(i3))
  const t0 = Date.now()
  const i4 = await call(`/api/documents/${D1}/pdf`, { key: readerKey })
  check(`I3 boîte injoignable : 502 qui le dit (${Date.now() - t0} ms)`, i4.status === 502 && /unreachable/.test(i4.body?.error ?? ''), brief(i4))

  // ---- C, fin : supprimer un dossier ---------------------------------------------------------
  const c7 = await call(`/api/documents/folders/${FEDEX}`, { method: 'DELETE', cookie })
  const after = await call(`/api/documents?account=${ACCOUNT}`, { cookie })
  check('C7 supprimer le dossier (et son sous-dossier) : les 3 documents retombent « à ranger », aucun effacé', c7.status === 200 && after.body?.data?.total === 3 && after.body.data.unfiled === 3, `${c7.status} / ${brief(after)}`)
} finally {
  for (const id of created.accounts) await pool.query('DELETE FROM email_accounts WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM email_accounts WHERE email LIKE $1', ['g5-%@banc-g5.invalid']).catch(() => {})
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  const expected = ['A1', 'A2', 'B1', 'B2']
  const fell = failures.map(l => l.split(' ')[0])
  const onlyExpected = fell.every(f => expected.includes(f)) && expected.every(e => fell.includes(e))
  if (onlyExpected) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés (${fell.join(', ')}), exactement ceux attendus`); process.exit(0) }
  console.error(`\nCONTRÔLE NÉGATIF : tombés ${JSON.stringify(fell)}, attendus ${JSON.stringify(expected)}`)
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nroutes documents GED : OK')
