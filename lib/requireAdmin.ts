/**
 * La garde d'administration, en UN seul endroit : le rôle vit en base (`users.role`)
 * et non dans la session, donc chaque route protégée doit le relire. Extraite de
 * `app/api/admin/users/route.ts` quand une deuxième zone d'administration est
 * apparue, pour que les deux refusent exactement de la même façon.
 */
import { query } from '@/lib/db'

type SessionLike = { user?: { id?: string } } | null

export async function isAdmin(session: SessionLike): Promise<boolean> {
  if (!session?.user?.id) return false
  const rows = await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [session.user.id])
  return rows[0]?.role === 'admin'
}
