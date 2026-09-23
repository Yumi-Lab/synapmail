/**
 * OÙ une adresse a été vue — la SEULE façon de le demander, et la seule fois où on le
 * demande.
 *
 * Le service est `ip-api.com` (gratuit, sans clé), interrogé CÔTÉ SERVEUR uniquement :
 * le navigateur n'émet aucune requête vers l'extérieur, donc l'écran s'affiche aussi
 * depuis la Chine. Nicolas a déjà tranché ce compromis sur un autre projet
 * (`projet suivis etudiant/tracking.php`) ; ce module en reprend le modèle exact.
 *
 * UNE SEULE INTERROGATION PAR ADRESSE : le résultat est écrit dans `ip_locations` à la
 * première apparition, puis relu. Rouvrir l'écran ne repart JAMAIS chez le service pour
 * une adresse déjà connue — ce qui vaut aussi pour un échec, mémorisé lui aussi (voir
 * `status`), sans quoi une adresse privée relancerait un appel à chaque ouverture.
 *
 * QUAND LE SERVICE NE RÉPOND PAS (quota, coupure, réseau), rien n'est écrit : l'adresse
 * reste affichée en liste sans point, et la prochaine ouverture réessaiera. Un échec de
 * TRANSPORT ne se mémorise pas — seul un verdict du service ('success' ou son refus) le fait.
 *
 * CE QUE CETTE POSITION NE DIT PAS : où est la PERSONNE. Un VPN, un relais mobile ou un
 * hébergeur déplacent l'adresse de plusieurs milliers de kilomètres sans que rien ne le
 * signale. L'écran le dit à l'utilisateur, en une phrase.
 */
import { query } from '@/lib/db'

/** Le verdict du service pour une adresse, mémorisé pour ne plus la redemander. */
export type IpLocationStatus = 'success' | 'unlocatable'

export interface IpLocation {
  ipAddress: string
  status: IpLocationStatus
  city: string | null
  region: string | null
  country: string | null
  countryCode: string | null
  latitude: number | null
  longitude: number | null
}

/**
 * Les champs demandés au service : exactement ceux que l'écran affiche, pas un de plus.
 * `status`/`message` sont son verdict, `query` l'adresse qu'il a effectivement lue.
 */
const IP_API_FIELDS = 'status,message,country,countryCode,regionName,city,lat,lon,query'
const IP_API_URL = 'http://ip-api.com/json'
const IP_API_TIMEOUT_MS = 4000

type IpApiResponse = {
  status?: string
  message?: string
  country?: string
  countryCode?: string
  regionName?: string
  city?: string
  lat?: number
  lon?: number
}

type LocationRow = {
  ip_address: string
  status: string
  city: string | null
  region: string | null
  country: string | null
  country_code: string | null
  latitude: string | null
  longitude: string | null
}

function toLocation(r: LocationRow): IpLocation {
  return {
    ipAddress: r.ip_address,
    status: r.status === 'success' ? 'success' : 'unlocatable',
    city: r.city,
    region: r.region,
    country: r.country,
    countryCode: r.country_code,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
  }
}

/** Ce qui est DÉJÀ connu, sans jamais sortir. Un ensemble vide rend une carte vide, pas une erreur. */
export async function readCachedLocations(ips: string[]): Promise<Map<string, IpLocation>> {
  const found = new Map<string, IpLocation>()
  if (!ips.length) return found
  const rows = await query<LocationRow>(
    `SELECT ip_address, status, city, region, country, country_code, latitude, longitude
       FROM ip_locations WHERE ip_address = ANY($1::text[])`,
    [ips]
  )
  for (const r of rows) found.set(r.ip_address, toLocation(r))
  return found
}

/**
 * L'appel sortant, une seule adresse. Rend `null` si le service n'a pas répondu — ce
 * cas-là ne se mémorise pas, on réessaiera.
 */
async function askService(ip: string): Promise<IpLocation | null> {
  let body: IpApiResponse
  try {
    const res = await fetch(`${IP_API_URL}/${encodeURIComponent(ip)}?fields=${IP_API_FIELDS}`, {
      signal: AbortSignal.timeout(IP_API_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    body = await res.json()
  } catch {
    return null
  }

  if (body.status !== 'success') {
    // Le service a bien répondu, mais ne sait pas situer cette adresse (privée, réservée,
    // inconnue). C'est un verdict : on le retient pour ne plus la redemander.
    return { ipAddress: ip, status: 'unlocatable', city: null, region: null, country: null, countryCode: null, latitude: null, longitude: null }
  }

  return {
    ipAddress: ip,
    status: 'success',
    city: body.city ?? null,
    region: body.regionName ?? null,
    country: body.country ?? null,
    countryCode: body.countryCode ?? null,
    latitude: typeof body.lat === 'number' ? body.lat : null,
    longitude: typeof body.lon === 'number' ? body.lon : null,
  }
}

/** Écrit le verdict. `ON CONFLICT DO NOTHING` : deux écrans ouverts en même temps n'en font pas deux. */
async function remember(loc: IpLocation): Promise<void> {
  await query(
    `INSERT INTO ip_locations (ip_address, status, city, region, country, country_code, latitude, longitude)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ip_address) DO NOTHING`,
    [loc.ipAddress, loc.status, loc.city, loc.region, loc.country, loc.countryCode, loc.latitude, loc.longitude]
  )
}

/**
 * Situer un lot d'adresses : celles déjà connues sont relues, les AUTRES seulement sont
 * demandées au service, une fois chacune, puis retenues.
 *
 * Une adresse que le service n'a pas su rendre (transport en échec) est simplement
 * absente de la carte rendue — l'appelant l'affiche en liste sans point.
 */
export async function locateIps(ips: string[]): Promise<Map<string, IpLocation>> {
  const unique = Array.from(new Set(ips.filter(Boolean)))
  const known = await readCachedLocations(unique)

  const missing = unique.filter(ip => !known.has(ip))
  for (const ip of missing) {
    const loc = await askService(ip)
    if (!loc) continue
    await remember(loc)
    known.set(ip, loc)
  }
  return known
}
