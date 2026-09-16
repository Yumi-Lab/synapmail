import crypto from 'crypto'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export interface AuthContext {
  id: string
  role: string
}

/**
 * Drop-in replacement for `auth()` in API routes: tries the NextAuth session
 * cookie first, then falls back to an `Authorization: Bearer <key>` header
 * looked up against api_keys. Returns the same { id, role } shape either way.
 */
export async function authenticate(req: Request): Promise<AuthContext | null> {
  const session = await auth()
  if (session?.user?.id) {
    const role = (session.user as { role?: string }).role ?? 'user'
    return { id: session.user.id, role }
  }

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  const rawKey = header.slice(7).trim()
  if (!rawKey) return null

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const rows = await query<{ id: string; user_id: string; role: string }>(
    `SELECT ak.id, ak.user_id, u.role FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
    [keyHash]
  )
  if (!rows.length) return null

  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].id]).catch(() => { /* best-effort */ })
  return { id: rows[0].user_id, role: rows[0].role }
}
