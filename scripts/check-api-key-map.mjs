#!/usr/bin/env node
/**
 * Banc du lot P15 : LA CARTE DES CONNEXIONS À UNE CLÉ.
 *
 * Ce que ce banc mesure sur une instance qui tourne :
 *
 *   A. deux adresses de VILLES différentes sont situées, chacune avec sa ville, son
 *      pays et des coordonnées plaçables sur le fond de carte ;
 *   B. LE critère du lot : ouvrir l'écran DEUX fois ne déclenche qu'UNE interrogation
 *      par adresse. La mesure est directe — le nombre d'appels sortants est compté en
 *      base (`ip_locations.located_at` ne bouge pas) ET par un compteur de requêtes
 *      vers le service, obtenu en comparant les lignes avant / après la 2ᵉ ouverture ;
 *   C. une adresse PRIVÉE ne fabrique pas un faux lieu : elle rend `location: null`,
 *      reste dans la liste, et n'est pas redemandée au service à chaque ouverture ;
 *   D. le fond de carte est EMBARQUÉ : le module rend un tracé non vide, son repère est
 *      bien celui du viewBox, et la page ne référence aucun domaine externe ;
 *   E. le cloisonnement de P14 tient toujours : la position n'ouvre rien de plus.
 *
 *   node --experimental-strip-types scripts/check-api-key-map.mjs
 *   node --experimental-strip-types scripts/check-api-key-map.mjs --negative
 *
 * CONTRÔLE NÉGATIF (`--negative`) : le cache est VIDÉ entre les deux ouvertures de
 * l'écran, c'est-à-dire exactement ce que ferait un code qui ne retiendrait pas la
 * réponse. Le banc DOIT alors virer au rouge sur B. Ce qu'il démontre : l'assertion
 * porte bien sur le fait de NE PAS ressortir, et pas sur la simple présence d'une
 * position. Ce qu'il ne démontre PAS : le comportement du service lui-même, ni
 * l'exactitude de la ville qu'il annonce — ça, c'est sa parole, pas une mesure.
 *
 * DÉPENDANCE EXTERNE ASSUMÉE : ce banc a besoin d'ip-api.com pour la partie A. Si le
 * service ne répond pas, le banc sort en HARNESS (code 2) et ne conclut RIEN sur le
 * produit — c'est le harnais qui n'a pas pu mesurer, pas le produit qui a échoué.
 */
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'
import { WORLD_VIEWBOX_WIDTH, WORLD_VIEWBOX_HEIGHT, lonToX, latToY, isPlottable } from '../lib/worldMap.ts'

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

/**
 * Deux adresses PUBLIQUES de villes très éloignées — le banc ne vérifie pas QUELLE
 * ville le service annonce (ce serait mesurer le service), mais qu'il en annonce une,
 * différente pour chacune, et plaçable.
 */
const IP_A = '24.48.0.1'
const IP_B = '223.5.5.5'
/** Une adresse privée : le service la refuse, et rien ne doit être inventé pour elle. */
const IP_PRIVATE = '10.11.12.13'

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

const pool = new pg.Pool({ connectionString: DB_URL })
const created = { keys: [] }

try {
  const users = await pool.query('SELECT id FROM users WHERE email = $1', [EMAIL])
  if (!users.rows.length) harness(`aucun utilisateur ${EMAIL} dans cette base`)

  // Le banc part d'une ardoise propre pour SES adresses : sinon une exécution
  // précédente aurait déjà rempli le cache et B ne mesurerait plus rien.
  const BENCH_IPS = [IP_A, IP_B, IP_PRIVATE]
  await pool.query('DELETE FROM ip_locations WHERE ip_address = ANY($1::text[])', [BENCH_IPS])

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
      body: { name: `bench carte ${name} ${crypto.randomBytes(3).toString('hex')}`, scopes: ['accounts:read'], accountIds: [] },
    })
    if (res.status !== 201) harness(`création de clé refusée (${res.status}) : ${res.text.slice(0, 200)}`)
    created.keys.push(res.json.data.id)
    return res.json.data
  }

  const watched = await makeKey('observée')

  // Trois adresses, des nombres d'appels DIFFÉRENTS : c'est ce qui distingue à l'écran
  // une adresse vue une fois d'une adresse vue souvent.
  const CALLS = { [IP_A]: 5, [IP_B]: 1, [IP_PRIVATE]: 2 }
  for (const [ip, n] of Object.entries(CALLS)) {
    for (let i = 0; i < n; i++) await call('/api/accounts', { key: watched.key, ip })
  }

  const expected = Object.values(CALLS).reduce((a, b) => a + b, 0)
  const settle = async () => {
    for (let waited = 0; waited < 5000; waited += 50) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM api_key_requests WHERE api_key_id = $1 AND ip_address = ANY($2::text[])',
        [watched.id, BENCH_IPS]
      )
      if (rows[0].n >= expected) return rows[0].n
      await new Promise(r => setTimeout(r, 50))
    }
    return null
  }
  if (await settle() === null) harness(`le journal n'a pas enregistré les ${expected} requêtes du banc`)

  // ---- 1ʳᵉ OUVERTURE de l'écran ----
  const first = await call(`/api/api-keys/${watched.id}/ips`, { cookie })
  check('A1 la liste répond 200', first.status === 200, `HTTP ${first.status}`)
  const listOne = first.json?.data ?? []
  const byIp = list => Object.fromEntries(list.map(i => [i.ipAddress, i]))
  const one = byIp(listOne)

  // Le service tiers est une dépendance du BANC pour A : s'il n'a rien rendu, c'est le
  // harnais qui n'a pas pu mesurer.
  const cached = await pool.query(
    'SELECT ip_address, status, city, country, latitude, longitude, located_at FROM ip_locations WHERE ip_address = ANY($1::text[])',
    [BENCH_IPS]
  )
  if (!cached.rows.some(r => r.status === 'success')) {
    harness('ip-api.com n\'a situé aucune des adresses du banc — rien à conclure sur le produit')
  }

  // ---- A. deux adresses de villes différentes, situées et plaçables ----
  for (const ip of [IP_A, IP_B]) {
    const loc = one[ip]?.location
    check(`A2 ${ip} est située (ville + pays)`,
      Boolean(loc?.city) && Boolean(loc?.country),
      `location=${JSON.stringify(one[ip]?.location ?? null)}`)
    check(`A3 ${ip} porte des coordonnées plaçables sur le fond de carte`,
      Boolean(loc) && isPlottable(loc.latitude, loc.longitude) &&
        lonToX(loc.longitude) >= 0 && lonToX(loc.longitude) <= WORLD_VIEWBOX_WIDTH &&
        latToY(loc.latitude) >= 0 && latToY(loc.latitude) <= WORLD_VIEWBOX_HEIGHT,
      `lat/lon=${loc?.latitude},${loc?.longitude}`)
  }
  check('A4 les deux adresses ne tombent pas au MÊME endroit',
    one[IP_A]?.location?.city !== one[IP_B]?.location?.city,
    `${one[IP_A]?.location?.city} vs ${one[IP_B]?.location?.city}`)
  check('A5 le nombre d\'appels distingue une adresse vue souvent d\'une vue une fois',
    one[IP_A]?.callCount === CALLS[IP_A] && one[IP_B]?.callCount === CALLS[IP_B],
    `${one[IP_A]?.callCount} vs ${one[IP_B]?.callCount}`)

  // ---- C. une adresse privée ne fabrique pas un faux lieu ----
  check('C1 une adresse privée reste dans la LISTE', Boolean(one[IP_PRIVATE]),
    `adresses : ${listOne.map(i => i.ipAddress).join(', ')}`)
  check('C2 une adresse privée n\'a PAS de position inventée',
    one[IP_PRIVATE]?.location === null, `location=${JSON.stringify(one[IP_PRIVATE]?.location)}`)

  // ---- B. LE critère : rouvrir l'écran ne ressort pas ----
  // `located_at` est l'horodatage de l'interrogation. S'il ne bouge pas entre les deux
  // ouvertures, c'est qu'aucune 2ᵉ interrogation n'a eu lieu pour cette adresse.
  const stamps = r => Object.fromEntries(r.rows.map(x => [x.ip_address, x.located_at.toISOString()]))
  const before = stamps(cached)
  check('B1 la première ouverture a interrogé le service UNE fois par adresse',
    Object.keys(before).length === BENCH_IPS.length,
    `en cache : ${Object.keys(before).join(', ')}`)

  if (NEGATIVE) {
    // Ce que ferait un code qui ne retient pas la réponse : le cache est vidé, donc la
    // 2ᵉ ouverture ressort forcément. B DOIT tomber.
    await pool.query('DELETE FROM ip_locations WHERE ip_address = ANY($1::text[])', [BENCH_IPS])
  }

  // ---- 2ᵉ OUVERTURE, à l'identique ----
  const second = await call(`/api/api-keys/${watched.id}/ips`, { cookie })
  const two = byIp(second.json?.data ?? [])
  const after = stamps(await pool.query(
    'SELECT ip_address, located_at FROM ip_locations WHERE ip_address = ANY($1::text[])',
    [BENCH_IPS]
  ))

  const reasked = BENCH_IPS.filter(ip => before[ip] !== after[ip])
  check('B2 rouvrir l\'écran ne déclenche AUCUNE nouvelle interrogation',
    reasked.length === 0, `réinterrogées : ${reasked.join(', ') || 'aucune'}`)
  check('B3 la 2ᵉ ouverture montre les MÊMES positions que la 1ʳᵉ',
    JSON.stringify(two[IP_A]?.location) === JSON.stringify(one[IP_A]?.location) &&
    JSON.stringify(two[IP_B]?.location) === JSON.stringify(one[IP_B]?.location),
    `${JSON.stringify(two[IP_A]?.location)} vs ${JSON.stringify(one[IP_A]?.location)}`)
  check('B4 l\'adresse privée non plus n\'est pas redemandée',
    before[IP_PRIVATE] !== undefined && before[IP_PRIVATE] === after[IP_PRIVATE],
    `avant ${before[IP_PRIVATE]} / après ${after[IP_PRIVATE]}`)

  // ---- D. le fond de carte est EMBARQUÉ ----
  const worldSrc = readFileSync(new URL('../lib/worldMap.ts', import.meta.url), 'utf8')
  const pathMatch = worldSrc.match(/WORLD_LAND_PATH = '([^']+)'/)
  check('D1 le fond de carte est un tracé non vide, dans le dépôt',
    Boolean(pathMatch) && pathMatch[1].length > 1000, `${pathMatch?.[1].length ?? 0} caractères`)
  check('D2 le tracé tient dans le repère annoncé par le viewBox', (() => {
    const nums = (pathMatch?.[1] ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    if (!nums.length) return false
    const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1)
    return Math.min(...xs) >= 0 && Math.max(...xs) <= WORLD_VIEWBOX_WIDTH &&
           Math.min(...ys) >= 0 && Math.max(...ys) <= WORLD_VIEWBOX_HEIGHT
  })(), 'des points sortent du viewBox')
  const pageSrc = readFileSync(new URL('../app/(app)/settings/api-keys/page.tsx', import.meta.url), 'utf8')
  check('D3 l\'écran ne référence AUCUN fond de carte externe',
    !/https?:\/\/(?!\S*\.invalid)/.test(pageSrc.replace(/https:\/\/nextjs\.org\S*/g, '')),
    'une URL externe apparaît dans l\'écran')
  check('D4 le service n\'est appelé que CÔTÉ SERVEUR',
    !pageSrc.includes('ip-api.com') && readFileSync(new URL('../lib/ipLocation.ts', import.meta.url), 'utf8').includes('ip-api.com'),
    'ip-api.com apparaît dans un composant client')

  // ---- E. le cloisonnement de P14 tient toujours ----
  check('E1 sans session, la liste reste refusée',
    (await call(`/api/api-keys/${watched.id}/ips`)).status === 401)
  check('E2 un identifiant qui n\'est pas le sien rend toujours 404',
    (await call(`/api/api-keys/${crypto.randomUUID()}/ips`, { cookie })).status === 404)
} finally {
  for (const id of created.keys) await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {})
  await pool.query('DELETE FROM ip_locations WHERE ip_address = ANY($1::text[])', [[IP_A, IP_B, IP_PRIVATE]]).catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} assertion(s) tombée(s), comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : cache vidé entre les deux ouvertures, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\ncarte des connexions à une clé : OK')
