#!/usr/bin/env node
/**
 * Banc du lot P14, morceau 2 : D'OÙ LA CLÉ EST-ELLE UTILISÉE.
 *
 * `api_key_requests` enregistre déjà l'IP de chaque requête ; ce banc mesure que la
 * liste agrégée par clé dit la vérité sur une instance qui tourne :
 *
 *   A. l'IP du banc apparaît, avec ses compteurs (première fois, dernière fois, appels) ;
 *   B. une adresse vue pour la PREMIÈRE fois récemment est MARQUÉE, une ancienne ne
 *      l'est pas — c'est ce signal qui attrape une clé volée, pas la liste ;
 *   C. la liste est CLOISONNÉE : la clé d'un autre propriétaire rend 404, et les
 *      adresses d'une autre clé n'apparaissent jamais ici ;
 *   D. la source de l'adresse est la MÊME que celle du journal (`clientIp`) : ce que
 *      la liste montre est ce que le journal a écrit, sinon une restriction par IP
 *      comparerait à autre chose que ce qu'on lit.
 *
 *   node --experimental-strip-types scripts/check-api-key-ips.mjs
 *   node --experimental-strip-types scripts/check-api-key-ips.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : la fenêtre de « nouveauté » est relue comme si
 * elle valait zéro jour — c'est-à-dire sans le marquage du lot. Le banc DOIT alors
 * virer au rouge sur B. Ce qu'il démontre : l'assertion porte bien sur le marquage
 * et pas sur la simple présence d'une ligne. Ce qu'il ne démontre PAS : le
 * comportement d'un binaire dont on aurait retiré le calcul côté serveur.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { API_KEY_NEW_IP_DAYS } from '../types/account.ts'

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

/** L'adresse que le banc annonce : c'est elle que la liste doit montrer. */
const BENCH_IP = '203.0.113.7'

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

/** La liste, relue en IGNORANT le marquage du lot pour le contrôle négatif. */
const readIps = list => NEGATIVE ? list.map(i => ({ ...i, isNew: false })) : list

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)
  const userId = users.rows[0].id

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

  const makeKey = async name => {
    const res = await call('/api/api-keys', {
      method: 'POST', cookie,
      body: { name: `bench ips ${name} ${crypto.randomBytes(3).toString('hex')}`, scopes: ['accounts:read'], accountIds: [] },
    })
    if (res.status !== 201) harness(`création de clé refusée (${res.status}) : ${res.text.slice(0, 200)}`)
    created.keys.push(res.json.data.id)
    return res.json.data
  }

  const watched = await makeKey('observée')
  const other = await makeKey('voisine')

  // ---- A. l'IP du banc apparaît avec ses compteurs ----
  const CALLS = 3
  for (let i = 0; i < CALLS; i++) await call('/api/accounts', { key: watched.key, ip: BENCH_IP })
  // La ligne du journal s'ouvre puis se complète : on attend qu'elle existe.
  const settle = async () => {
    for (let waited = 0; waited < 3000; waited += 50) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM api_key_requests WHERE api_key_id = $1 AND ip_address = $2',
        [watched.id, BENCH_IP]
      )
      if (rows[0].n >= CALLS) return rows[0].n
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }
  const written = await settle()
  if (written === null) harness(`le journal n'a pas enregistré les ${CALLS} requêtes du banc`)

  const listed = await call(`/api/api-keys/${watched.id}/ips`, { cookie })
  check('A1 la liste répond 200', listed.status === 200, `HTTP ${listed.status}`)
  const ips = readIps(listed.json?.data ?? [])
  const bench = ips.find(i => i.ipAddress === BENCH_IP)
  check('A2 l\'IP du banc y figure', Boolean(bench), `adresses vues : ${ips.map(i => i.ipAddress).join(', ') || 'aucune'}`)
  check(`A3 elle compte les ${CALLS} appels du banc`,
    bench?.callCount === CALLS, `callCount ${bench?.callCount ?? 'null'}`)
  check('A4 elle porte une première ET une dernière fois, dans cet ordre',
    Boolean(bench) && new Date(bench.firstSeen) <= new Date(bench.lastSeen),
    `${bench?.firstSeen ?? 'null'} → ${bench?.lastSeen ?? 'null'}`)

  // ---- B. le marquage des adresses vues pour la première fois ----
  check('B1 une adresse vue à l\'instant est MARQUÉE nouvelle', bench?.isNew === true, `isNew=${bench?.isNew}`)

  // Une adresse dont la première vue est ANTÉRIEURE à la fenêtre : la ligne est
  // reculée dans le journal, ce qui est exactement ce que le temps aurait fait.
  const OLD_IP = '198.51.100.9'
  await pool.query(
    `INSERT INTO api_key_requests (api_key_id, method, path, ip_address, status, created_at)
     VALUES ($1, 'GET', '/api/accounts', $2, 200, NOW() - ($3 || ' days')::interval)`,
    [watched.id, OLD_IP, API_KEY_NEW_IP_DAYS + 1]
  )
  const afterOld = readIps((await call(`/api/api-keys/${watched.id}/ips`, { cookie })).json?.data ?? [])
  const old = afterOld.find(i => i.ipAddress === OLD_IP)
  check('B2 une adresse vue avant la fenêtre n\'est PAS marquée',
    old !== undefined && old.isNew === false, `isNew=${old?.isNew ?? 'absente'}`)
  check('B3 la plus récemment vue est en tête',
    afterOld[0]?.ipAddress === BENCH_IP, `tête : ${afterOld[0]?.ipAddress ?? 'aucune'}`)

  // ---- C. cloisonnement ----
  const otherIps = readIps((await call(`/api/api-keys/${other.id}/ips`, { cookie })).json?.data ?? [])
  check('C1 les adresses d\'une clé n\'apparaissent pas chez une autre',
    !otherIps.some(i => i.ipAddress === BENCH_IP),
    `la clé voisine voit ${otherIps.map(i => i.ipAddress).join(', ')}`)
  check('C2 sans session, la liste est refusée',
    (await call(`/api/api-keys/${watched.id}/ips`)).status === 401)
  check('C3 une clé ne peut pas lire ses propres origines au Bearer',
    (await call(`/api/api-keys/${watched.id}/ips`, { key: watched.key })).status === 401)
  check('C4 un identifiant qui n\'est pas le sien rend 404',
    (await call(`/api/api-keys/${crypto.randomUUID()}/ips`, { cookie })).status === 404)

  // ---- D. même source que le journal ----
  const logged = await pool.query(
    `SELECT DISTINCT ip_address FROM api_key_requests WHERE api_key_id = $1 AND ip_address IS NOT NULL`,
    [watched.id]
  )
  const fromLog = logged.rows.map(r => r.ip_address).sort()
  const fromList = afterOld.map(i => i.ipAddress).sort()
  check('D1 la liste montre EXACTEMENT les adresses que le journal a écrites',
    JSON.stringify(fromLog) === JSON.stringify(fromList),
    `journal ${fromLog.join(',')} vs liste ${fromList.join(',')}`)
} finally {
  // La base est rendue comme elle a été trouvée : les clés d'essai sont SUPPRIMÉES
  // (leurs lignes de journal partent en cascade).
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : marquage ignoré, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\norigines d\'une clé API : OK')
