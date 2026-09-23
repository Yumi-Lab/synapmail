#!/usr/bin/env node
/**
 * Banc du lot P14, morceau 3 : RESTREINDRE UNE CLÉ À DES ADRESSES.
 *
 * Mesuré sur une instance qui tourne, à travers la vraie barrière (`lib/apiAuth.ts`) :
 *
 *   A. une liste VIDE n'interdit rien — c'est l'état de toute clé existante, et la
 *      migration ne doit restreindre personne ;
 *   B. une clé restreinte passe depuis l'adresse autorisée, et est REFUSÉE depuis
 *      une autre par un 403 qui NOMME l'adresse refusée ;
 *   C. une plage CIDR autorise ce qu'elle couvre et refuse le reste ;
 *   D. le refus est INSCRIT au journal de la clé avec son motif ;
 *   E. une session HUMAINE n'est jamais concernée, depuis n'importe quelle adresse ;
 *   F. le verrou est posé AVANT la portée : une clé qui parle d'un endroit interdit
 *      ne reçoit pas un refus qui lui apprendrait ce qu'il lui manque par ailleurs.
 *
 *   node --experimental-strip-types scripts/check-api-key-ip-rules.mjs
 *   node --experimental-strip-types scripts/check-api-key-ip-rules.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les requêtes qui devraient être refusées sont
 * envoyées depuis l'adresse AUTORISÉE, c'est-à-dire comme si le verrou n'existait
 * pas et laissait tout passer. Le banc DOIT alors virer au rouge sur B, C et D. Ce
 * qu'il démontre : les assertions portent sur le REFUS et pas sur la simple réponse
 * de la route. Ce qu'il ne démontre PAS : le comportement d'un binaire dont on aurait
 * retiré `ipAllowed` — il mesure la réponse, pas la suppression du code.
 *
 * SÛRETÉ : aucune vraie boîte n'est touchée. Les clés d'essai sont SUPPRIMÉES à la fin.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { ipAllowed, sanitizeIpRules } from '../lib/apiKeyIpRules.ts'

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

/** Adresses de documentation (RFC 5737) : elles n'appartiennent à personne. */
const ALLOWED_IP = '203.0.113.7'
const OTHER_IP = '198.51.100.42'
const RANGE = '192.0.2.0/24'
const IN_RANGE = '192.0.2.88'

/** Le contrôle négatif parle depuis l'adresse autorisée là où il devrait être refusé. */
const from = ip => NEGATIVE ? ALLOWED_IP : ip

const call = async (path, { method = 'GET', key, cookie, ip, body } = {}) => {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (cookie) headers.cookie = cookie
  if (ip) headers['x-forwarded-for'] = ip
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* pas du JSON : le statut suffit */ }
  return { status: res.status, text, json }
}

// ---- Le matcher lui-même, avant tout réseau : il décide de tout le reste ----
check('M1 une liste vide autorise tout', ipAllowed([], ALLOWED_IP) && ipAllowed(null, OTHER_IP))
check('M2 une adresse exacte n\'autorise qu\'elle',
  ipAllowed([ALLOWED_IP], ALLOWED_IP) && !ipAllowed([ALLOWED_IP], OTHER_IP))
check('M3 une plage autorise ce qu\'elle couvre, et rien d\'autre',
  ipAllowed([RANGE], IN_RANGE) && !ipAllowed([RANGE], OTHER_IP))
check('M4 une adresse ABSENTE face à une liste non vide est refusée',
  !ipAllowed([ALLOWED_IP], null))
check('M5 une entrée illisible est écartée à la saisie',
  JSON.stringify(sanitizeIpRules([ALLOWED_IP, 'pas-une-ip', '', '999.1.1.1', `${ALLOWED_IP}`])) === JSON.stringify([ALLOWED_IP]))

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }

try {
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

  const makeKey = async (name, allowedIps, scopes = ['accounts:read']) => {
    const res = await call('/api/api-keys', {
      method: 'POST', cookie,
      body: { name: `bench ip ${name} ${crypto.randomBytes(3).toString('hex')}`, scopes, accountIds: [], allowedIps },
    })
    if (res.status !== 201) harness(`création de clé refusée (${res.status}) : ${res.text.slice(0, 200)}`)
    created.keys.push(res.json.data.id)
    return res.json.data
  }

  // ---- A. aucune restriction par défaut ----
  const free = await makeKey('sans-restriction', [])
  check('A1 une clé neuve n\'a AUCUNE restriction', free.allowedIps.length === 0, JSON.stringify(free.allowedIps))
  check('A2 elle répond depuis n\'importe quelle adresse',
    (await call('/api/accounts', { key: free.key, ip: OTHER_IP })).status === 200)

  // ---- B. restriction à une adresse exacte ----
  const pinned = await makeKey('adresse-exacte', [ALLOWED_IP])
  check('B1 la restriction est enregistrée telle quelle',
    JSON.stringify(pinned.allowedIps) === JSON.stringify([ALLOWED_IP]), JSON.stringify(pinned.allowedIps))
  check('B2 depuis l\'adresse autorisée : 200',
    (await call('/api/accounts', { key: pinned.key, ip: ALLOWED_IP })).status === 200)

  const refused = await call('/api/accounts', { key: pinned.key, ip: from(OTHER_IP) })
  check('B3 depuis une autre adresse : 403', refused.status === 403, `HTTP ${refused.status}`)
  check('B4 le refus NOMME l\'adresse refusée',
    refused.json?.deniedIp === OTHER_IP && String(refused.json?.error).includes(OTHER_IP),
    `deniedIp ${refused.json?.deniedIp ?? 'null'} — ${String(refused.json?.error).slice(0, 120)}`)

  // ---- C. plage CIDR ----
  const ranged = await makeKey('plage', [RANGE])
  check('C1 une adresse DANS la plage passe',
    (await call('/api/accounts', { key: ranged.key, ip: IN_RANGE })).status === 200)
  const outOfRange = await call('/api/accounts', { key: ranged.key, ip: from(OTHER_IP) })
  check('C2 une adresse HORS de la plage est refusée en la nommant',
    outOfRange.status === 403 && outOfRange.json?.deniedIp === OTHER_IP,
    `HTTP ${outOfRange.status} / deniedIp ${outOfRange.json?.deniedIp ?? 'null'}`)

  // ---- D. le refus est au journal ----
  const logged = async () => {
    for (let waited = 0; waited < 3000; waited += 50) {
      const { rows } = await pool.query(
        `SELECT status, denial_reason, denial_detail, ip_address FROM api_key_requests
          WHERE api_key_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [pinned.id]
      )
      if (rows[0]?.status != null) return rows[0]
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }
  const line = await logged()
  check('D1 le refus a laissé une ligne portant 403 et son motif',
    line?.status === 403 && line?.denial_reason === 'ip',
    `ligne ${JSON.stringify(line)}`)
  check('D2 la ligne nomme l\'adresse refusée, la MÊME que le 403',
    line?.denial_detail === OTHER_IP && line?.ip_address === OTHER_IP,
    `detail ${line?.denial_detail ?? 'null'} / ip ${line?.ip_address ?? 'null'}`)

  // ---- E. une session humaine n'est jamais restreinte ----
  check('E1 la session humaine répond depuis une adresse quelconque',
    (await call('/api/accounts', { cookie, ip: OTHER_IP })).status === 200)

  // ---- F. le verrou passe AVANT la portée ----
  // Cette clé n'a PAS la portée d'écriture des messages ET parle d'un endroit interdit :
  // le refus doit citer l'adresse, jamais la portée qui lui manque.
  const both = await call('/api/messages/bulk', {
    method: 'PATCH', key: pinned.key, ip: from(OTHER_IP), body: { uids: [], action: 'read' },
  })
  check('F1 adresse interdite ET portée manquante : c\'est l\'ADRESSE qui est citée',
    both.status === 403 && both.json?.deniedIp === OTHER_IP && !both.json?.missingScope,
    `HTTP ${both.status} — ${both.text.slice(0, 160)}`)
} finally {
  // La base est rendue comme elle a été trouvée : les clés d'essai sont SUPPRIMÉES.
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : requêtes envoyées de l\'adresse autorisée, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nrestriction par adresse d\'une clé API : OK')
