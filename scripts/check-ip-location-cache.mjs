#!/usr/bin/env node
/**
 * Banc du lot P15 : SITUER UNE ADRESSE UNE SEULE FOIS.
 *
 * Le critère qui commande le lot n'est pas « la carte s'affiche », c'est le NOMBRE
 * D'APPELS SORTANTS : ouvrir l'écran deux fois ne doit interroger le service qu'UNE
 * fois par adresse. Ce banc les COMPTE, en remplaçant `fetch` par un compteur — le
 * seul moyen d'en faire une mesure et pas une impression.
 *
 *   node --experimental-strip-types scripts/check-ip-location-cache.mjs
 *   node --experimental-strip-types scripts/check-ip-location-cache.mjs --negative
 *
 * CE QUI EST MESURÉ :
 *   A. une adresse jamais vue déclenche EXACTEMENT un appel, et sa ville est retenue ;
 *   B. la MÊME adresse redemandée (2ᵉ ouverture de l'écran) déclenche ZÉRO appel ;
 *   C. deux adresses distinctes sont situées chacune dans SA ville ;
 *   D. une adresse que le service refuse de situer est retenue comme telle, et ne
 *      repart PAS chez le service à l'ouverture suivante (sans quoi une adresse privée
 *      relancerait un appel à chaque fois) ;
 *   E. le service INDISPONIBLE (transport en échec) n'écrit RIEN : l'adresse reste sans
 *      position, et la prochaine ouverture réessaie — un échec de transport n'est pas
 *      un verdict.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : la lecture du cache est court-circuitée, comme si
 * le lot n'avait pas de table `ip_locations`. Le banc DOIT alors virer au rouge sur B
 * et D — les deux assertions qui portent sur le « une seule fois ». Ce qu'il démontre :
 * ces assertions mesurent bien le cache et pas la simple présence d'une ligne. Ce qu'il
 * ne démontre PAS : le comportement de l'écran, qui relève du gate humain.
 *
 * CE BANC NE SORT JAMAIS SUR LE RÉSEAU : `fetch` est remplacé de bout en bout. Il ne
 * dit donc RIEN de ce que `ip-api.com` répond réellement, ni de son quota — seulement
 * de la façon dont ce module l'interroge.
 */
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import pg from 'pg'

for (const file of ['../.env', '../.env.local']) {
  const path = new URL(file, import.meta.url)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const { DATABASE_URL: DB_URL } = process.env
const NEGATIVE = process.argv.includes('--negative')

/** Le banc n'a rien pu mesurer : il ne conclut RIEN sur le produit. */
const harness = msg => { console.error(`HARNESS: ${msg}`); process.exit(2) }
if (!DB_URL) harness("DATABASE_URL n'est pas renseigné")

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  failures.push(label)
}

/**
 * Des adresses de DOCUMENTATION (RFC 5737 / RFC 3849), qui n'appartiennent à personne
 * et ne seront jamais routées : le banc ne peut donc pas polluer les compteurs d'une
 * vraie adresse, ni en faire fuiter une.
 */
const IP_PARIS = '192.0.2.10'
const IP_TOKYO = '198.51.100.20'
const IP_PRIVATE = '203.0.113.30'
const IP_OFFLINE = '192.0.2.99'
const BENCH_IPS = [IP_PARIS, IP_TOKYO, IP_PRIVATE, IP_OFFLINE]

/** Ce que le faux service répond, par adresse. `null` = transport en échec. */
const SERVICE = {
  [IP_PARIS]: { status: 'success', country: 'France', countryCode: 'FR', regionName: 'Île-de-France', city: 'Paris', lat: 48.85, lon: 2.35 },
  [IP_TOKYO]: { status: 'success', country: 'Japon', countryCode: 'JP', regionName: 'Tokyo', city: 'Tokyo', lat: 35.68, lon: 139.69 },
  [IP_PRIVATE]: { status: 'fail', message: 'reserved range' },
  [IP_OFFLINE]: null,
}

/** LE compteur : combien de fois le module est sorti, et pour quelle adresse. */
const calls = []
globalThis.fetch = async (url) => {
  const ip = decodeURIComponent(String(url).split('/json/')[1].split('?')[0])
  calls.push(ip)
  const answer = SERVICE[ip]
  if (answer === null) throw new Error('service injoignable (simulé)')
  if (answer === undefined) harness(`le banc a demandé une adresse qu'il n'a pas prévue : ${ip}`)
  return { ok: true, json: async () => answer }
}
const callsFor = ip => calls.filter(c => c === ip).length

const pool = new pg.Pool({ connectionString: DB_URL })
const clean = () => pool.query('DELETE FROM ip_locations WHERE ip_address = ANY($1::text[])', [BENCH_IPS])

const ipLocation = await import('../lib/ipLocation.ts')
let locateIps = ipLocation.locateIps

if (NEGATIVE) {
  // Comme si `ip_locations` n'existait pas : on redemande tout, à chaque fois.
  locateIps = async (ips) => {
    const found = new Map()
    for (const ip of Array.from(new Set(ips.filter(Boolean)))) {
      const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=x`
      try {
        const res = await globalThis.fetch(url)
        const body = await res.json()
        if (body.status === 'success') {
          found.set(ip, { ipAddress: ip, status: 'success', city: body.city ?? null, region: body.regionName ?? null, country: body.country ?? null, countryCode: body.countryCode ?? null, latitude: body.lat ?? null, longitude: body.lon ?? null })
        } else {
          found.set(ip, { ipAddress: ip, status: 'unlocatable', city: null, region: null, country: null, countryCode: null, latitude: null, longitude: null })
        }
      } catch { /* transport en échec : pas de position */ }
    }
    return found
  }
}

try {
  await clean()

  // ---- A. première ouverture de l'écran : un appel par adresse, et la ville est retenue ----
  const first = await locateIps([IP_PARIS, IP_TOKYO, IP_PRIVATE, IP_OFFLINE])

  check('A1 une adresse jamais vue déclenche EXACTEMENT un appel sortant',
    callsFor(IP_PARIS) === 1, `${callsFor(IP_PARIS)} appel(s) pour ${IP_PARIS}`)
  check('A2 et sa VILLE est celle que le service a rendue',
    first.get(IP_PARIS)?.city === 'Paris', `reçu ${JSON.stringify(first.get(IP_PARIS))}`)

  // ---- C. deux adresses distinctes, chacune dans SA ville ----
  check('C deux adresses distinctes sont situées chacune dans sa ville',
    first.get(IP_TOKYO)?.city === 'Tokyo' && first.get(IP_PARIS)?.city !== first.get(IP_TOKYO)?.city,
    `${first.get(IP_PARIS)?.city} / ${first.get(IP_TOKYO)?.city}`)

  // ---- E. service indisponible : rien n'est retenu, on réessaiera ----
  check('E1 une adresse dont le service n\'a pas répondu n\'a AUCUNE position',
    !first.has(IP_OFFLINE), `reçu ${JSON.stringify(first.get(IP_OFFLINE))}`)
  const offlineRows = await pool.query('SELECT COUNT(*)::int AS n FROM ip_locations WHERE ip_address = $1', [IP_OFFLINE])
  check('E2 et RIEN n\'est écrit en base : un échec de transport n\'est pas un verdict',
    offlineRows.rows[0].n === 0, `${offlineRows.rows[0].n} ligne(s)`)

  const callsBeforeReopen = calls.length

  // ---- B + D + E3. deuxième ouverture de l'écran, à l'identique ----
  const second = await locateIps([IP_PARIS, IP_TOKYO, IP_PRIVATE, IP_OFFLINE])

  check('B rouvrir l\'écran ne redemande PAS une adresse déjà située (zéro appel)',
    callsFor(IP_PARIS) === 1 && callsFor(IP_TOKYO) === 1,
    `${callsFor(IP_PARIS)} appel(s) pour ${IP_PARIS}, ${callsFor(IP_TOKYO)} pour ${IP_TOKYO}`)
  check('B2 et la ville relue est la MÊME, sans être allée la rechercher',
    second.get(IP_PARIS)?.city === 'Paris', `reçu ${JSON.stringify(second.get(IP_PARIS))}`)

  check('D une adresse que le service REFUSE de situer est retenue comme telle, et n\'est plus redemandée',
    callsFor(IP_PRIVATE) === 1 && second.get(IP_PRIVATE)?.status === 'unlocatable',
    `${callsFor(IP_PRIVATE)} appel(s), statut ${second.get(IP_PRIVATE)?.status}`)
  check('D2 et elle ne FABRIQUE pas un faux lieu',
    second.get(IP_PRIVATE)?.city === null && second.get(IP_PRIVATE)?.latitude === null,
    `reçu ${JSON.stringify(second.get(IP_PRIVATE))}`)

  check('E3 l\'adresse dont le service n\'avait pas répondu est bien RÉESSAYÉE',
    callsFor(IP_OFFLINE) === 2, `${callsFor(IP_OFFLINE)} appel(s) pour ${IP_OFFLINE}`)

  const reopenCalls = calls.length - callsBeforeReopen
  check('B3 au total, la 2ᵉ ouverture n\'a coûté QUE le réessai de l\'adresse sans réponse',
    reopenCalls === 1, `${reopenCalls} appel(s) sortant(s) à la 2ᵉ ouverture`)
} finally {
  await clean().catch(() => {})
  await pool.end()
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET : aucun cache, et le banc reste vert — il ne mesure rien')
  process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nsituer une adresse une seule fois : OK')
