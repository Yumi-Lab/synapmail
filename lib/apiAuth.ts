import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { API_SCOPES, type ApiScope, accountPermissionForRequest, scopeForRequest } from '@/lib/apiScopes'
import { getAccessibleAccount, type AccountPermission } from '@/lib/accountAccess'
import { accountIdFromRequest, keyReachesAccount } from '@/lib/apiKeyAccounts'
import { clientIp, noteAccount, noteDenial, openLog } from '@/lib/apiLog'
import { ipAllowed, type IpRule } from '@/lib/apiKeyIpRules'

export interface AuthContext {
  id: string
  role: string
  /** `null` pour une session humaine : elle n'est jamais limitée par une portée. */
  scopes: ApiScope[] | null
  /** La clé qui parle, ou `null` pour une session humaine. */
  apiKeyId: string | null
}

/**
 * Pourquoi l'accès est refusé. `scope` porte la portée manquante quand la clé
 * est valide mais trop étroite ; `unauthenticated` couvre tout le reste.
 */
type Denial =
  | { reason: 'unauthenticated' }
  | { reason: 'scope'; scope: ApiScope }
  | { reason: 'account'; accountId: string }
  | { reason: 'share'; accountId: string; permission: AccountPermission }
  | { reason: 'ip'; ip: string }
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
    return { ctx: { id: session.user.id, role, scopes: null, apiKeyId: null } }
  }

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return { denied: { reason: 'unauthenticated' } }
  const rawKey = header.slice(7).trim()
  if (!rawKey) return { denied: { reason: 'unauthenticated' } }

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const rows = await query<{ id: string; user_id: string; role: string; scopes: string[] | null; allowed_ips: string[] | null }>(
    `SELECT ak.id, ak.user_id, u.role, ak.scopes, ak.allowed_ips FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
    [keyHash]
  )
  if (!rows.length) return { denied: { reason: 'unauthenticated' } }

  const apiKeyId = rows[0].id
  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [apiKeyId]).catch(() => { /* best-effort */ })

  // La ligne du journal s'OUVRE ici et se complète au retour de la requête : le
  // statut, la durée et le motif du refus n'existent pas encore. Voir lib/apiLog.ts.
  openLog(req, apiKeyId)
  const path = new URL(req.url).pathname

  // La TROISIÈME moitié de la barrière, au même endroit que les deux autres : d'où la
  // clé a le droit de parler. Liste vide = aucune restriction, comme avant ce lot.
  // L'adresse est celle du journal (`clientIp`) — ce que l'écran montre est donc bien
  // ce qui est comparé. Vérifiée AVANT la portée : une clé qui parle d'un endroit
  // interdit n'a rien à savoir de ce qui lui manque par ailleurs.
  const ip = clientIp(req)
  if (!ipAllowed(rows[0].allowed_ips as IpRule[] | null, ip)) {
    return { denied: { reason: 'ip', ip: ip ?? '' } }
  }

  const required = scopeForRequest(req.method, path)
  if (!required) return { denied: { reason: 'unauthenticated' } }
  const scopes = (rows[0].scopes ?? []) as ApiScope[]
  if (!scopes.includes(required)) return { denied: { reason: 'scope', scope: required } }

  // La SECONDE moitié de la barrière, au même endroit que la première : la portée dit
  // quelle capacité, celle-ci dit sur quelle boîte. Une requête qui ne désigne aucune
  // boîte passe — c'est le cas de `POST /api/accounts`, qui en CRÉE une, et des routes
  // qui n'en prennent pas. Voir lib/apiKeyAccounts.ts.
  const accountId = await accountIdFromRequest(req)
  noteAccount(req, accountId)
  if (accountId && !(await keyReachesAccount(apiKeyId, accountId))) {
    return { denied: { reason: 'account', accountId } }
  }

  // UNE CLÉ NE DÉPASSE PAS LE PARTAGE. Cocher une boîte PARTAGÉE dit sur quelle boîte
  // la clé agit, jamais ce qu'elle a le droit d'y faire : cela reste borné par les
  // permissions du partage. Sans ce test, une clé portant `messages:send` enverrait
  // depuis une boîte que son porteur n'a pas le droit d'utiliser pour envoyer.
  //
  // L'accès est relu ICI, à chaque appel, jamais figé au moment où on a coché : un
  // partage révoqué, expiré ou amputé d'une permission ferme donc la clé sans qu'on
  // ait à y toucher. `getAccessibleAccount` est la source unique de cette règle — le
  // propriétaire y reçoit toutes les permissions, donc une boîte à soi passe d'office.
  const permission = accountId ? accountPermissionForRequest(req.method, path) : null
  if (accountId && permission) {
    const account = await getAccessibleAccount(accountId, rows[0].user_id, [permission])
    if (!account) return { denied: { reason: 'share', accountId, permission } }
  }

  return { ctx: { id: rows[0].user_id, role: rows[0].role, scopes, apiKeyId } }
}

/**
 * `resolve` + la trace de ce qui a été refusé, pour que le journal porte le MOTIF et
 * pas seulement le statut. Le motif n'est connu qu'ici, au moment où la barrière le
 * prononce. Avant que la clé ne soit reconnue il n'y a pas de ligne ouverte, et
 * `noteDenial` ne fait alors rien — une requête sans clé valide n'est pas journalisée.
 */
async function resolveAndNote(req: Request): Promise<Resolution> {
  const result = await resolve(req)
  if ('denied' in result) {
    const d = result.denied
    noteDenial(req, d.reason, d.reason === 'scope' ? d.scope : d.reason === 'account' || d.reason === 'share' ? d.accountId : d.reason === 'ip' ? d.ip : null)
  }
  return result
}

/**
 * Ce que NOMME un refus de partage. La permission brute (`manageRules`) ne dit rien à
 * l'agent qui lit le refus : il lui faut le geste qu'on lui interdit, comme un refus
 * de portée nomme la capacité manquante. Une table, pas une chaîne construite.
 */
const ACCOUNT_PERMISSION_LABELS: Record<AccountPermission, string> = {
  send: 'send',
  delete: 'delete',
  organize: 'organize',
  manageRules: 'manage rules',
  manageSignatures: 'manage signatures',
}

/**
 * Remplaçant direct d'`auth()` dans une route API : rend le contexte quand
 * l'accès est accordé, `null` sinon — portée manquante comprise, pour que toute
 * route qui teste seulement `!ctx` refuse par défaut plutôt que de laisser passer.
 * Une route qui veut annoncer la portée manquante utilise `authorize()`.
 */
export async function authenticate(req: Request): Promise<AuthContext | null> {
  const result = await resolveAndNote(req)
  return 'ctx' in result ? result.ctx : null
}

/**
 * `authenticate` + la réponse de refus, en une étape et une seule recherche.
 * Le refus d'une portée rend un 403 QUI LA NOMME : un agent doit pouvoir dire à
 * son propriétaire ce qu'il faut lui cocher, pas se heurter à un 401 muet.
 */
export async function authorize(req: Request): Promise<{ ctx: AuthContext } | { denied: NextResponse }> {
  const result = await resolveAndNote(req)
  if ('ctx' in result) return result
  if (result.denied.reason === 'unauthenticated') {
    return { denied: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (result.denied.reason === 'ip') {
    const ip = result.denied.ip
    return {
      denied: NextResponse.json(
        {
          error: ip
            ? `API key is not allowed from address ${ip}`
            : 'API key is restricted to known addresses, and this request carries none',
          deniedIp: ip || null,
        },
        { status: 403 }
      ),
    }
  }
  if (result.denied.reason === 'account') {
    const accountId = result.denied.accountId
    return {
      denied: NextResponse.json(
        {
          error: `API key has no access to mailbox ${accountId}`,
          missingAccount: accountId,
          missingAccountReason: 'not_granted',
        },
        { status: 403 }
      ),
    }
  }
  if (result.denied.reason === 'share') {
    const { accountId, permission } = result.denied
    return {
      denied: NextResponse.json(
        {
          error: `API key cannot ${ACCOUNT_PERMISSION_LABELS[permission]} on mailbox ${accountId}: the share granting access to it does not allow it`,
          missingAccount: accountId,
          missingAccountReason: 'share_permission',
          missingSharePermission: permission,
        },
        { status: 403 }
      ),
    }
  }
  const scope = result.denied.scope
  return {
    denied: NextResponse.json(
      { error: `Missing API key scope: ${scope}`, missingScope: scope, missingScopeLabel: API_SCOPES[scope] },
      { status: 403 }
    ),
  }
}
