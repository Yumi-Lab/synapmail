#!/usr/bin/env node
/**
 * Banc du lot P14, morceau 1 : REVOIR UNE CLÉ.
 *
 * Nicolas assume que la clé redevienne affichable ; ce banc mesure que les trois
 * garde-fous tiennent, sur une instance qui tourne et avec de vraies lignes en base :
 *
 *   A. la clé est stockée CHIFFRÉE, jamais en clair — la colonne ne contient pas le
 *      clair, et le hachage reste ce qui AUTHENTIFIE (la clé révélée fonctionne) ;
 *   B. la révélation exige la RE-SAISIE du mot de passe : sans lui 400, faux 403,
 *      bon mot de passe 200 et le clair rendu est EXACTEMENT celui de la création ;
 *   C. la révélation est INSCRITE au journal de la clé (avec l'IP vue) ;
 *   D. une clé créée AVANT ce lot (sans chiffré) rend 409, pas un bouton mort ;
 *   E. une CLÉ ne peut pas se relire elle-même : la route refuse le Bearer (401).
 *
 *   node --experimental-strip-types scripts/check-api-key-reveal.mjs
 *   node --experimental-strip-types scripts/check-api-key-reveal.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le banc s'authentifie avec un mot de passe FAUX
 * là où il devrait présenter le bon. Le produit DOIT alors refuser, donc les
 * assertions de révélation tombent. Ce qu'il démontre : les assertions portent bien
 * sur la re-saisie du mot de passe, et le banc ne rendrait pas vert un produit qui
 * révèle sans la demander. Ce qu'il ne démontre PAS : le comportement d'un binaire
 * dont on aurait retiré la vérification — il mesure la réponse, pas le code.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { API_KEY_REVEAL_METHOD } from '../types/account.ts'

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

const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }

for (const [k, v] of Object.entries({
  SYNAPMAIL_TEST_URL: BASE, SYNAPMAIL_TEST_EMAIL: EMAIL,
  SYNAPMAIL_TEST_PASSWORD: PASSWORD, DATABASE_URL: DB_URL,
})) if (!v) harness(`${k} n'est pas renseigné`)

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
  let json = null
  try { json = JSON.parse(text) } catch { /* pas du JSON : le statut suffit */ }
  return { status: res.status, text, json }
}

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

  // Session humaine : la route de révélation n'est ouverte qu'à elle.
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
  const { csrfToken } = await csrfRes.json()
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, json: 'true' }),
  })
  const cookie = [csrfCookie, ...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0])].join('; ')
  if (!/session-token/.test(cookie)) harness(`connexion par identifiants refusée (${loginRes.status})`)

  // Une clé créée PAR LE PRODUIT : c'est lui qui décide de chiffrer, pas le banc.
  const createRes = await call('/api/api-keys', {
    method: 'POST', cookie,
    body: { name: `bench reveal ${crypto.randomBytes(3).toString('hex')}`, scopes: ['accounts:read'], accountIds: [] },
  })
  if (createRes.status !== 201) harness(`création de clé refusée (${createRes.status}) : ${createRes.text.slice(0, 200)}`)
  const fresh = createRes.json.data
  created.keys.push(fresh.id)

  // ---- A. stockée chiffrée, et le hachage reste ce qui authentifie ----
  const stored = await pool.query('SELECT key_hash, key_encrypted FROM api_keys WHERE id = $1', [fresh.id])
  const row = stored.rows[0]
  check('A1 la colonne chiffrée est remplie', Boolean(row.key_encrypted), 'key_encrypted est NULL')
  check('A2 elle ne contient PAS le clair',
    Boolean(row.key_encrypted) && !row.key_encrypted.includes(fresh.key),
    'le clair apparaît tel quel dans key_encrypted')
  check('A3 le hachage est toujours le SHA-256 du clair (c\'est lui qui authentifie)',
    row.key_hash === crypto.createHash('sha256').update(fresh.key).digest('hex'))
  check('A4 la clé créée fonctionne réellement en Bearer',
    (await call('/api/accounts', { key: fresh.key })).status === 200)
  check('A5 l\'écran sait qu\'elle est réaffichable', fresh.revealable === true, `revealable=${fresh.revealable}`)

  // ---- B. la re-saisie du mot de passe est exigée ----
  const noPassword = await call(`/api/api-keys/${fresh.id}/reveal`, { method: 'POST', cookie, body: {} })
  check('B1 sans mot de passe : refus 400', noPassword.status === 400, `HTTP ${noPassword.status}`)

  const wrongPassword = await call(`/api/api-keys/${fresh.id}/reveal`, {
    method: 'POST', cookie, body: { password: `${PASSWORD}-wrong` },
  })
  check('B2 avec un mauvais mot de passe : refus 403 et AUCUN clair rendu',
    wrongPassword.status === 403 && !wrongPassword.text.includes(fresh.key),
    `HTTP ${wrongPassword.status}`)

  // Le contrôle négatif présente ICI un mot de passe faux : le produit doit refuser,
  // et les assertions de révélation (B3, B4, C) doivent tomber.
  const revealed = await call(`/api/api-keys/${fresh.id}/reveal`, {
    method: 'POST', cookie, body: { password: NEGATIVE ? `${PASSWORD}-wrong` : PASSWORD },
  })
  check('B3 avec le bon mot de passe : 200', revealed.status === 200, `HTTP ${revealed.status} — ${revealed.text.slice(0, 160)}`)
  check('B4 le clair rendu est EXACTEMENT celui de la création',
    revealed.json?.data?.key === fresh.key,
    `rendu ${String(revealed.json?.data?.key).slice(0, 16)}… vs créé ${fresh.key.slice(0, 16)}…`)

  // ---- C. la révélation est au journal de la clé ----
  const logged = await pool.query(
    `SELECT method, ip_address, status FROM api_key_requests
      WHERE api_key_id = $1 AND method = $2 ORDER BY created_at DESC LIMIT 1`,
    [fresh.id, API_KEY_REVEAL_METHOD]
  )
  check('C1 la révélation a laissé une ligne au journal de la clé',
    logged.rows.length === 1, `${logged.rows.length} ligne(s) ${API_KEY_REVEAL_METHOD}`)
  check('C2 la ligne porte l\'IP vue par l\'application',
    logged.rows[0]?.ip_address != null,
    `ip_address ${logged.rows[0]?.ip_address ?? 'null'} — l'appelant doit poser x-forwarded-for`)

  // ---- D. une clé d'AVANT le lot : explication, pas bouton mort ----
  await pool.query('UPDATE api_keys SET key_encrypted = NULL WHERE id = $1', [fresh.id])
  const legacy = await call(`/api/api-keys/${fresh.id}/reveal`, { method: 'POST', cookie, body: { password: PASSWORD } })
  check('D1 une clé sans chiffré rend 409 (irrécupérable), pas un 500',
    legacy.status === 409, `HTTP ${legacy.status}`)
  const listed = await call('/api/api-keys', { cookie })
  const listedKey = listed.json?.data?.find(k => k.id === fresh.id)
  check('D2 l\'écran la voit non réaffichable', listedKey?.revealable === false, `revealable=${listedKey?.revealable}`)
  check('D3 la liste ne fait JAMAIS sortir le chiffré ni le haché',
    !/key_encrypted|keyEncrypted|key_hash|keyHash/.test(listed.text))

  // ---- E. une clé ne peut pas se relire elle-même ----
  const viaBearer = await call(`/api/api-keys/${fresh.id}/reveal`, {
    method: 'POST', key: fresh.key, body: { password: PASSWORD },
  })
  check('E1 la route de révélation refuse le Bearer (401)',
    viaBearer.status === 401 && !viaBearer.text.includes(fresh.key), `HTTP ${viaBearer.status}`)
} finally {
  // La base est rendue comme elle a été trouvée, même après un échec : les clés
  // d'essai sont SUPPRIMÉES, pas seulement révoquées.
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : mot de passe faux présenté, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nrévélation d\'une clé API : OK')
