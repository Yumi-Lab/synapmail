import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

type ApiKeyRow = {
  id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  created_at: string
}

function toApi(r: ApiKeyRow) {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await query<ApiKeyRow>(
      `SELECT id, name, key_prefix, last_used_at, created_at
       FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
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
    const { name } = body as { name?: string }
    if (!name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    const rawKey = `syn_${crypto.randomBytes(24).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.slice(0, 12)

    const rows = await query<ApiKeyRow>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, key_prefix, last_used_at, created_at`,
      [session.user.id, name.trim(), keyPrefix, keyHash]
    )

    // rawKey is returned once, here, and never stored or logged in cleartext.
    return NextResponse.json({ data: { ...toApi(rows[0]), key: rawKey } }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
