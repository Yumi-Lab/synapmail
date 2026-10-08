import bcrypt from 'bcryptjs'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { decrypt } from '@/lib/encrypt'
import { clientIp } from '@/lib/apiLog'
import { API_KEY_REVEAL_MAX_ATTEMPTS, API_KEY_REVEAL_METHOD, API_KEY_REVEAL_WINDOW_MS } from '@/types/account'

export const dynamic = 'force-dynamic'

/**
 * Wrong passwords per user, in process memory. A stolen session gets
 * API_KEY_REVEAL_MAX_ATTEMPTS tries per API_KEY_REVEAL_WINDOW_MS, then 429 until the
 * window has passed; a correct password clears the count.
 *
 * ponytail: one process, one map — a restart forgets everything, and several app
 * instances behind one proxy each count on their own. Move the counter to Postgres
 * (a `reveal_attempts` table keyed by user) the day the app runs replicated.
 */
const wrongPasswords = new Map<string, { count: number; since: number }>()

function attemptsLeft(userId: string): number {
  const entry = wrongPasswords.get(userId)
  if (!entry || Date.now() - entry.since > API_KEY_REVEAL_WINDOW_MS) return API_KEY_REVEAL_MAX_ATTEMPTS
  return Math.max(0, API_KEY_REVEAL_MAX_ATTEMPTS - entry.count)
}

function noteWrongPassword(userId: string): void {
  const entry = wrongPasswords.get(userId)
  if (!entry || Date.now() - entry.since > API_KEY_REVEAL_WINDOW_MS) wrongPasswords.set(userId, { count: 1, since: Date.now() })
  else entry.count += 1
}

/**
 * Ré-afficher le clair d'une clé — opération SENSIBLE, donc session humaine seulement
 * (jamais au Bearer : une clé ne doit pas pouvoir se relire, ni en lire une autre) et
 * mot de passe du compte re-saisi, comme un changement de mot de passe.
 *
 * Le clair sort du CHIFFRÉ (`key_encrypted`), jamais du haché : `key_hash` reste seul
 * consulté pour authentifier. Une clé créée avant ce lot n'a pas de chiffré — son clair
 * n'existe nulle part — et rend un 409 que l'écran traduit en explication.
 *
 * Every attempt on the owner's own key leaves a line in that key's log: a refused
 * password (403), a locked-out user (429), and a success (200) — the latter written
 * only AFTER `decrypt()` returned, so the log never claims a reveal that did not
 * happen. Le « qui » est le propriétaire de la clé : lui seul peut atteindre cette route.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { password } = (await req.json()) as { password?: string }
    if (!password) return NextResponse.json({ error: 'password is required' }, { status: 400 })

    // Ownership first: a line is only ever written to the caller's OWN key's log.
    const rows = await query<{ key_encrypted: string | null }>(
      'SELECT key_encrypted FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [params.id, session.user.id]
    )
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const log = (status: number) => query(
      `INSERT INTO api_key_requests (api_key_id, method, path, ip_address, status, denial_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.id, API_KEY_REVEAL_METHOD, new URL(req.url).pathname, clientIp(req), status, status === 200 ? null : 'password']
    )

    if (attemptsLeft(session.user.id) === 0) {
      await log(429)
      return NextResponse.json(
        { error: 'Too many wrong passwords, try again later' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(API_KEY_REVEAL_WINDOW_MS / 1000)) } }
      )
    }

    const users = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [session.user.id]
    )
    if (!users.length || !(await bcrypt.compare(password, users[0].password_hash))) {
      noteWrongPassword(session.user.id)
      await log(403)
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 })
    }
    wrongPasswords.delete(session.user.id)

    if (!rows[0].key_encrypted) {
      return NextResponse.json({ error: 'This key predates key recovery and cannot be shown' }, { status: 409 })
    }

    const key = decrypt(rows[0].key_encrypted)
    await log(200)
    return NextResponse.json({ data: { key } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
