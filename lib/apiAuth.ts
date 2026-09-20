import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { API_SCOPES, type ApiScope, scopeForRequest } from '@/lib/apiScopes'

export interface AuthContext {
  id: string
  role: string
  /** `null` pour une session humaine : elle n'est jamais limitée par une portée. */
  scopes: ApiScope[] | null
}

/**
 * Pourquoi l'accès est refusé. `scope` porte la portée manquante quand la clé
 * est valide mais trop étroite ; `unauthenticated` couvre tout le reste.
 */
type Denial = { reason: 'unauthenticated' } | { reason: 'scope'; scope: ApiScope }
type Resolution = { ctx: AuthContext } | { denied: Denial }

/**
 * Session NextAuth d'abord, puis `Authorization: Bearer <clé>` retrouvé dans
 * `api_keys`. La PORTÉE se vérifie ici, là où la clé est reconnue : une route
 * ouverte au Bearer ne peut pas oublier de la contrôler. La table des portées
 * vit dans `lib/apiScopes.ts` ; une route qui n'y figure pas n'est pas ouverte
 * aux clés — elle reste réservée à une session humaine.
 */
async function resolve(req: Request): Promise<Resolution> {
  const session = await auth()
  if (session?.user?.id) {
    const role = (session.user as { role?: string }).role ?? 'user'
    return { ctx: { id: session.user.id, role, scopes: null } }
  }

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return { denied: { reason: 'unauthenticated' } }
  const rawKey = header.slice(7).trim()
  if (!rawKey) return { denied: { reason: 'unauthenticated' } }

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const rows = await query<{ id: string; user_id: string; role: string; scopes: string[] | null }>(
    `SELECT ak.id, ak.user_id, u.role, ak.scopes FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
    [keyHash]
  )
  if (!rows.length) return { denied: { reason: 'unauthenticated' } }

  const apiKeyId = rows[0].id
  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [apiKeyId]).catch(() => { /* best-effort */ })

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    null
  const path = new URL(req.url).pathname
  query(
    'INSERT INTO api_key_requests (api_key_id, method, path, ip_address) VALUES ($1, $2, $3, $4)',
    [apiKeyId, req.method, path, ip?.slice(0, 45) ?? null]
  ).catch(() => { /* best-effort */ })

  const required = scopeForRequest(req.method, path)
  if (!required) return { denied: { reason: 'unauthenticated' } }
  const scopes = (rows[0].scopes ?? []) as ApiScope[]
  if (!scopes.includes(required)) return { denied: { reason: 'scope', scope: required } }

  return { ctx: { id: rows[0].user_id, role: rows[0].role, scopes } }
}

/**
 * Remplaçant direct d'`auth()` dans une route API : rend le contexte quand
 * l'accès est accordé, `null` sinon — portée manquante comprise, pour que toute
 * route qui teste seulement `!ctx` refuse par défaut plutôt que de laisser passer.
 * Une route qui veut annoncer la portée manquante utilise `authorize()`.
 */
export async function authenticate(req: Request): Promise<AuthContext | null> {
  const result = await resolve(req)
  return 'ctx' in result ? result.ctx : null
}

/**
 * `authenticate` + la réponse de refus, en une étape et une seule recherche.
 * Le refus d'une portée rend un 403 QUI LA NOMME : un agent doit pouvoir dire à
 * son propriétaire ce qu'il faut lui cocher, pas se heurter à un 401 muet.
 */
export async function authorize(req: Request): Promise<{ ctx: AuthContext } | { denied: NextResponse }> {
  const result = await resolve(req)
  if ('ctx' in result) return result
  if (result.denied.reason === 'unauthenticated') {
    return { denied: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const scope = result.denied.scope
  return {
    denied: NextResponse.json(
      { error: `Missing API key scope: ${scope}`, missingScope: scope, missingScopeLabel: API_SCOPES[scope] },
      { status: 403 }
    ),
  }
}
