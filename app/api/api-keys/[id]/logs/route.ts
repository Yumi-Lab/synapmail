import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

type LogRow = {
  id: string
  method: string
  path: string
  ip_address: string | null
  created_at: string
}

// GET /api/api-keys/[id]/logs?limit=50 — most recent Bearer requests logged for this key
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)

  try {
    const owned = await query<{ id: string }>(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 LIMIT 1',
      [params.id, session.user.id]
    )
    if (!owned.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const rows = await query<LogRow>(
      `SELECT id, method, path, ip_address, created_at
       FROM api_key_requests WHERE api_key_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [params.id, limit]
    )

    return NextResponse.json({
      data: rows.map(r => ({
        id: r.id,
        method: r.method,
        path: r.path,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
