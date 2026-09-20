import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { sanitizeScopes } from '@/lib/apiScopes'

export const dynamic = 'force-dynamic'

type ApiKeyRow = {
  id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  created_at: string
  scopes: string[] | null
  request_count_24h?: string
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
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await query<ApiKeyRow>(
      `SELECT ak.id, ak.name, ak.key_prefix, ak.last_used_at, ak.created_at, ak.scopes,
              COUNT(r.id) FILTER (WHERE r.created_at >= NOW() - INTERVAL '24 hours')::text AS request_count_24h
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
    const { name, scopes } = body as { name?: string; scopes?: unknown }
    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    // Une clé sans portée ne peut rien faire : ce serait une clé morte, jamais un
    // passe-partout. Les portées inconnues tombent (sanitizeScopes).
    const granted = sanitizeScopes(scopes)
    if (!granted.length) return NextResponse.json({ error: 'at least one scope is required' }, { status: 400 })

    const rawKey = `syn_${crypto.randomBytes(24).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.slice(0, 12)

    const rows = await query<ApiKeyRow>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, scopes_migrated_at)
       VALUES ($1, $2, $3, $4, $5::text[], NOW())
       RETURNING id, name, key_prefix, last_used_at, created_at, scopes`,
      [session.user.id, name.trim(), keyPrefix, keyHash, granted]
    )

    // rawKey is returned once, here, and never stored or logged in cleartext.
    return NextResponse.json({ data: { ...toApi(rows[0]), key: rawKey } }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
