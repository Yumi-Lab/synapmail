import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { API_KEY_NEW_IP_DAYS } from '@/types/account'

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

    const newSince = Date.now() - API_KEY_NEW_IP_DAYS * 24 * 60 * 60 * 1000
    return NextResponse.json({
      data: rows.map(r => ({
        ipAddress: r.ip_address,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        callCount: parseInt(r.call_count),
        isNew: new Date(r.first_seen).getTime() >= newSince,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
