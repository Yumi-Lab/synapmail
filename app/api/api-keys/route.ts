import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { sanitizeScopes } from '@/lib/apiScopes'
import { grantAccounts } from '@/lib/apiKeyAccounts'
import { encrypt } from '@/lib/encrypt'
import { sanitizeIpRules } from '@/lib/apiKeyIpRules'

export const dynamic = 'force-dynamic'

type ApiKeyRow = {
  id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  created_at: string
  scopes: string[] | null
  request_count_24h?: string
  account_ids?: string[] | null
  owned_account_ids?: string[] | null
  key_encrypted?: string | null
  allowed_ips?: string[] | null
}

function toApi(r: ApiKeyRow) {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    scopes: sanitizeScopes(r.scopes),
    requestCount24h: r.request_count_24h ? parseInt(r.request_count_24h) : 0,
    accountIds: (r.account_ids ?? []).filter(Boolean),
    // Une clé créée AVANT le lot P14 n'a aucun clair stocké : il n'existe nulle part.
    // L'écran le DIT au lieu d'offrir un bouton mort — jamais le chiffré lui-même.
    revealable: Boolean(r.key_encrypted),
    // Liste vide = aucune restriction, comme avant : c'est l'état de toute clé existante.
    allowedIps: sanitizeIpRules(r.allowed_ips),
    // Les boîtes que la clé a CONNECTÉES : elles lui appartiennent, donc l'écran les
    // montre cochées et verrouillées plutôt que de laisser croire qu'on peut les retirer.
    ownedAccountIds: (r.owned_account_ids ?? []).filter(Boolean),
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await query<ApiKeyRow>(
      `SELECT ak.id, ak.name, ak.key_prefix, ak.last_used_at, ak.created_at, ak.scopes,
              ak.key_encrypted, ak.allowed_ips,
              COUNT(r.id) FILTER (WHERE r.created_at >= NOW() - INTERVAL '24 hours')::text AS request_count_24h,
              ARRAY(SELECT g.account_id::text FROM api_key_accounts g WHERE g.api_key_id = ak.id) AS account_ids,
              ARRAY(SELECT a.id::text FROM email_accounts a WHERE a.created_by_api_key = ak.id) AS owned_account_ids
       FROM api_keys ak
       LEFT JOIN api_key_requests r ON r.api_key_id = ak.id
       WHERE ak.user_id = $1 AND ak.revoked_at IS NULL
       GROUP BY ak.id
       ORDER BY ak.created_at DESC`,
      [session.user.id]
    )
    return NextResponse.json({ data: rows.map(toApi) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { name, scopes, accountIds, allowedIps } = body as
      { name?: string; scopes?: unknown; accountIds?: unknown; allowedIps?: unknown }
    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    // Une clé sans portée ne peut rien faire : ce serait une clé morte, jamais un
    // passe-partout. Les portées inconnues tombent (sanitizeScopes).
    const granted = sanitizeScopes(scopes)
    if (!granted.length) return NextResponse.json({ error: 'at least one scope is required' }, { status: 400 })

    const rawKey = `syn_${crypto.randomBytes(24).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.slice(0, 12)

    const rows = await query<ApiKeyRow>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, key_encrypted, scopes, allowed_ips, scopes_migrated_at, accounts_migrated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], NOW(), NOW())
       RETURNING id, name, key_prefix, last_used_at, created_at, scopes, key_encrypted, allowed_ips`,
      [session.user.id, name.trim(), keyPrefix, keyHash, encrypt(rawKey), granted, sanitizeIpRules(allowedIps)]
    )

    // Les boîtes cochées à la création. `accounts_migrated_at` est posé ci-dessus pour
    // qu'un redémarrage ne vienne PAS lui accorder toutes les boîtes au titre de la
    // migration : une clé neuve n'a que ce qu'on lui a coché.
    await grantAccounts(rows[0].id, session.user.id, accountIds)

    // Le clair part ici, et n'est stocké que CHIFFRÉ (`encrypt`, clé maître hors base).
    // Le hachage reste seul consulté pour l'authentification : on ne déchiffre que pour
    // ré-afficher, après re-saisie du mot de passe — voir app/api/api-keys/[id]/reveal.
    return NextResponse.json({ data: { ...toApi(rows[0]), key: rawKey } }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
