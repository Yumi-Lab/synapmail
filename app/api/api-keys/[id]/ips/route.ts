import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { API_KEY_NEW_IP_DAYS } from '@/types/account'
import { locateIps } from '@/lib/ipLocation'
import { isPlottable } from '@/lib/worldMap'

export const dynamic = 'force-dynamic'

type IpRow = {
  ip_address: string
  first_seen: string
  last_seen: string
  call_count: string
}

/**
 * D'OÙ cette clé est-elle utilisée — agrégé depuis `api_key_requests`, qui enregistre
 * déjà l'IP de chaque requête. Rien de nouveau n'est collecté.
 *
 * Ce qui attrape une clé volée n'est pas la liste mais une adresse qui apparaît pour
 * la PREMIÈRE fois : `isNew` est vrai quand la toute première requête depuis cette
 * adresse est récente (voir `API_KEY_NEW_IP_DAYS`), et l'écran la marque.
 *
 * OÙ chaque adresse a été vue est demandé à `lib/ipLocation.ts`, qui n'interroge le
 * service qu'à la PREMIÈRE apparition de l'adresse et relit sa réponse ensuite. Une
 * adresse qui n'a pas pu être située rend `location: null` : elle reste dans la liste,
 * sans point sur la carte, et sera retentée plus tard.
 *
 * L'adresse vaut ce que vaut sa source : `x-forwarded-for` est un en-tête, donc
 * forgeable par qui atteint l'application sans passer par le reverse proxy — voir
 * `clientIp` dans `lib/apiLog.ts`.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const owned = await query<{ id: string }>(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 LIMIT 1',
      [params.id, session.user.id]
    )
    if (!owned.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const rows = await query<IpRow>(
      `SELECT ip_address,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen,
              COUNT(*)::text  AS call_count
         FROM api_key_requests
        WHERE api_key_id = $1 AND ip_address IS NOT NULL
        GROUP BY ip_address
        ORDER BY MAX(created_at) DESC`,
      [params.id]
    )

    // Situer les adresses : celles déjà connues sont relues en base, les autres sont
    // demandées UNE fois au service puis retenues — rouvrir l'écran ne ressort plus.
    const located = await locateIps(rows.map(r => r.ip_address))

    const newSince = Date.now() - API_KEY_NEW_IP_DAYS * 24 * 60 * 60 * 1000
    return NextResponse.json({
      data: rows.map(r => {
        const loc = located.get(r.ip_address)
        const plottable = loc?.status === 'success' && isPlottable(loc.latitude, loc.longitude)
        return {
          ipAddress: r.ip_address,
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
          callCount: parseInt(r.call_count),
          isNew: new Date(r.first_seen).getTime() >= newSince,
          location: plottable && loc
            ? {
                city: loc.city,
                region: loc.region,
                country: loc.country,
                countryCode: loc.countryCode,
                latitude: loc.latitude as number,
                longitude: loc.longitude as number,
              }
            : null,
        }
      }),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
