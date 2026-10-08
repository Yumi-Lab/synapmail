/**
 * SUR QUELLE BOÎTE une clé API a le droit d'agir — LA seconde moitié de la barrière.
 *
 * Les portées (`lib/apiScopes.ts`) disent QUELLE capacité ; ce module dit SUR QUELLE
 * boîte. Les deux sont exigées : une clé qui porte `messages:read` sans la boîte B ne
 * lit rien de B. Une session humaine n'est limitée ni par l'une ni par l'autre.
 *
 * La vérification est appelée depuis `lib/apiAuth.ts`, à l'endroit EXACT où la portée
 * est vérifiée, et elle lit la boîte dans la requête elle-même. C'est ce qui en fait
 * UNE barrière : une route ouverte au Bearer ne peut pas oublier de la franchir,
 * puisqu'elle ne la franchit pas elle-même. `scripts/check-api-account-grants.mjs`
 * prouve qu'aucune route prenant une boîte en paramètre ne la contourne.
 *
 * Deux façons d'avoir le droit, jamais une troisième :
 *   1. la boîte a été CONNECTÉE par cette clé — elle lui appartient, rien à cocher ;
 *   2. la boîte lui a été COCHÉE dans les réglages (`api_key_accounts`).
 * Toute autre boîte est fermée.
 */

import { query } from './db'
import { ACCESSIBLE_ACCOUNT_IDS } from './accountAccess'

/**
 * Les noms sous lesquels une requête peut désigner une boîte. C'est l'inventaire
 * MESURÉ des routes ouvertes au Bearer (`account` en paramètre d'URL, `accountId`
 * dans un corps JSON), pas une supposition : le banc échoue si une route en
 * introduit un autre. Une route qui nommerait sa boîte autrement échapperait à la
 * barrière — d'où l'inventaire ici, en UN endroit, plutôt qu'au cas par cas.
 */
export const ACCOUNT_PARAM_KEYS = ['account', 'accountId'] as const

/**
 * Le cycle de vie d'une boîte porte son identifiant dans le CHEMIN
 * (`PATCH /api/accounts/<id>`), pas en paramètre. Le segment qui suit ce préfixe est
 * donc une boîte — sauf `test`, qui est une route et non un identifiant. Rien
 * d'équivalent ailleurs : le `<id>` de `/api/messages/<id>` est un message, et sa
 * boîte arrive, elle, par `?account=`.
 */
const ACCOUNT_PATH_PREFIX = '/api/accounts/'
const ACCOUNT_PATH_EXCEPTIONS = ['test']

/**
 * Les objets qui désignent leur boîte INDIRECTEMENT : `PATCH /api/rules/<id>` ne
 * nomme aucune boîte, mais la règle en vise une, et agir sur la règle c'est agir
 * sur cette boîte. Sans cette table, une clé sans la boîte B modifierait le tri de
 * B en passant par l'identifiant de la règle — la barrière serait contournée par
 * l'objet plutôt que par la route.
 *
 * Une entrée = un préfixe de chemin et la requête qui rend la boîte de l'objet.
 * `null` en réponse (objet inconnu, ou sans boîte comme une signature globale) ne
 * désigne aucune boîte : la route rendra elle-même son 404, ce n'est pas à la
 * barrière de trancher l'existence.
 */
const ACCOUNT_BY_OBJECT: { prefix: string; sql: string }[] = [
  { prefix: '/api/rules/', sql: 'SELECT account_id AS id FROM email_rules WHERE id = $1' },
  { prefix: '/api/signatures/', sql: 'SELECT account_id AS id FROM signatures WHERE id = $1' },
]

/** Un identifiant d'objet est un UUID : tout le reste est un sous-chemin (`/run`, `/test`). */
const OBJECT_ID = /^[0-9a-f-]{36}$/i

/** La boîte visée à travers l'objet nommé dans le chemin, ou `null`. */
async function accountIdFromObject(path: string): Promise<string | null> {
  for (const { prefix, sql } of ACCOUNT_BY_OBJECT) {
    if (!path.startsWith(prefix)) continue
    const segment = path.slice(prefix.length)
    if (!OBJECT_ID.test(segment)) continue
    const rows = await query<{ id: string | null }>(sql, [segment])
    return rows[0]?.id ?? null
  }
  return null
}

/**
 * La boîte que cette requête désigne, ou `null` si elle n'en désigne aucune.
 *
 * Le corps est lu sur un CLONE : la route le relira intact derrière nous. Un corps
 * absent, vide ou non-JSON ne désigne pas de boîte — ce n'est pas une erreur, c'est
 * le cas d'une route qui n'en prend pas.
 */
export async function accountIdFromRequest(req: Request): Promise<string | null> {
  const url = new URL(req.url)
  for (const key of ACCOUNT_PARAM_KEYS) {
    const value = url.searchParams.get(key)
    if (value) return value
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path.startsWith(ACCOUNT_PATH_PREFIX)) {
    const segment = path.slice(ACCOUNT_PATH_PREFIX.length)
    if (segment && !segment.includes('/') && !ACCOUNT_PATH_EXCEPTIONS.includes(segment)) return segment
  }

  const byObject = await accountIdFromObject(path)
  if (byObject) return byObject

  if (req.method === 'GET' || req.method === 'HEAD') return null
  if (!req.headers.get('content-type')?.includes('application/json')) return null
  try {
    const body = (await req.clone().json()) as Record<string, unknown> | null
    for (const key of ACCOUNT_PARAM_KEYS) {
      const value = body?.[key]
      if (typeof value === 'string' && value) return value
    }
  } catch {
    /* un corps illisible ne désigne aucune boîte ; la route dira elle-même qu'il est invalide */
  }
  return null
}

/**
 * La règle d'accès, en UNE clause SQL : la boîte appartient à la clé (elle l'a
 * connectée) ou elle lui a été cochée. `$1` est la clé, `$2` la boîte.
 *
 * La propriété de l'UTILISATEUR reste vérifiée où elle l'était (`getAccessibleAccount`
 * et consorts) : cette clause s'y AJOUTE, elle ne la remplace pas. Une clé ne peut
 * donc jamais atteindre une boîte que son propriétaire ne pourrait pas atteindre.
 */
const KEY_REACHES_ACCOUNT_SQL = `
  SELECT 1 FROM email_accounts a
   WHERE a.id = $2 AND a.created_by_api_key = $1
  UNION ALL
  SELECT 1 FROM api_key_accounts g
   WHERE g.api_key_id = $1 AND g.account_id = $2
  LIMIT 1`

/** Cette clé peut-elle agir sur cette boîte ? Ferme par défaut. */
export async function keyReachesAccount(apiKeyId: string, accountId: string): Promise<boolean> {
  const rows = await query(KEY_REACHES_ACCOUNT_SQL, [apiKeyId, accountId])
  return rows.length > 0
}

/**
 * Les boîtes qu'une clé peut atteindre — la MÊME règle, posée pour l'ensemble.
 * Sert à la liste des boîtes (`GET /api/accounts`), qui ne désigne aucune boîte en
 * particulier et doit pourtant ne montrer que ce que la clé peut toucher : une clé
 * qui lirait la liste entière saurait ce qu'elle n'a pas le droit de savoir.
 */
export async function keyAccountIds(apiKeyId: string): Promise<Set<string>> {
  const rows = await query<{ id: string }>(
    `SELECT a.id FROM email_accounts a WHERE a.created_by_api_key = $1
     UNION
     SELECT g.account_id AS id FROM api_key_accounts g WHERE g.api_key_id = $1`,
    [apiKeyId]
  )
  return new Set(rows.map(r => r.id))
}

/**
 * Remplace les boîtes COCHÉES d'une clé, et rend la liste effectivement écrite.
 *
 * `undefined` = l'appelant ne parle pas des boîtes : on ne touche à rien. Une liste,
 * même VIDE, remplace — c'est ainsi qu'on retire la dernière boîte d'une clé.
 *
 * Seules les boîtes ACCESSIBLES à `userId` sont retenues : une liste d'identifiants
 * venue du client ne peut pas cocher la boîte de quelqu'un d'autre. « Accessible »,
 * c'est `ACCESSIBLE_ACCOUNT_IDS` — les siennes ET celles reçues en partage actif,
 * la règle déjà consolidée au lot S6. Filtrer sur la seule PROPRIÉTÉ, comme ici
 * avant le lot P16, laissait quelqu'un qui n'a QUE des partages sans aucune boîte à
 * cocher : sa clé naissait inutilisable.
 *
 * Cocher n'accorde pas pour autant un pouvoir que le partage n'a pas : ce qu'une clé
 * peut FAIRE d'une boîte partagée reste borné, à chaque appel, par les permissions du
 * partage (`lib/apiAuth.ts`). Cette liste dit QUELLES boîtes, jamais QUOI en faire.
 * Les boîtes que la clé a CONNECTÉES ne passent pas par ici — elles lui appartiennent déjà.
 */
export async function grantAccounts(
  apiKeyId: string,
  userId: string,
  accountIds: unknown
): Promise<string[] | undefined> {
  if (accountIds === undefined) return undefined
  const wanted = Array.isArray(accountIds) ? accountIds.filter((v): v is string => typeof v === 'string') : []

  const reachable = await query<{ id: string }>(
    `SELECT a.id FROM email_accounts a
      WHERE a.id IN ${ACCESSIBLE_ACCOUNT_IDS} AND a.id = ANY($2::uuid[])`,
    [userId, wanted]
  )
  const granted = reachable.map(r => r.id)

  await query('DELETE FROM api_key_accounts WHERE api_key_id = $1 AND NOT (account_id = ANY($2::uuid[]))', [apiKeyId, granted])
  if (granted.length) {
    await query(
      `INSERT INTO api_key_accounts (api_key_id, account_id)
       SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
      [apiKeyId, granted]
    )
  }
  return granted
}
