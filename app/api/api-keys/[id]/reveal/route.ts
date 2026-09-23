import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { decrypt } from '@/lib/encrypt'
import { clientIp } from '@/lib/apiLog'
import { API_KEY_REVEAL_METHOD } from '@/types/account'

export const dynamic = 'force-dynamic'

/**
 * Ré-afficher le clair d'une clé — opération SENSIBLE, donc session humaine seulement
 * (jamais au Bearer : une clé ne doit pas pouvoir se relire, ni en lire une autre) et
 * mot de passe du compte re-saisi, comme un changement de mot de passe.
 *
 * Le clair sort du CHIFFRÉ (`key_encrypted`), jamais du haché : `key_hash` reste seul
 * consulté pour authentifier. Une clé créée avant ce lot n'a pas de chiffré — son clair
 * n'existe nulle part — et rend un 409 que l'écran traduit en explication.
 *
 * Chaque révélation laisse une ligne au journal de la clé (quand, depuis quelle IP).
 * Le « qui » est le propriétaire de la clé : lui seul peut atteindre cette route.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { password } = (await req.json()) as { password?: string }
    if (!password) return NextResponse.json({ error: 'password is required' }, { status: 400 })

    const users = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [session.user.id]
    )
    if (!users.length || !(await bcrypt.compare(password, users[0].password_hash))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 })
    }

    const rows = await query<{ key_encrypted: string | null }>(
      'SELECT key_encrypted FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [params.id, session.user.id]
    )
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!rows[0].key_encrypted) {
      return NextResponse.json({ error: 'This key predates key recovery and cannot be shown' }, { status: 409 })
    }

    await query(
      `INSERT INTO api_key_requests (api_key_id, method, path, ip_address, status)
       VALUES ($1, $2, $3, $4, 200)`,
      [params.id, API_KEY_REVEAL_METHOD, new URL(req.url).pathname, clientIp(req)]
    )

    return NextResponse.json({ data: { key: decrypt(rows[0].key_encrypted) } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
