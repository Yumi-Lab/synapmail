import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import type { ApiKeyRequestLog } from '@/types/account'

export const dynamic = 'force-dynamic'

type LogRow = {
  id: string
  method: string
  path: string
  ip_address: string | null
  created_at: string
  status: number | null
  duration_ms: number | null
  account_id: string | null
  denial_reason: ApiKeyRequestLog['denialReason']
  denial_detail: string | null
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
      `SELECT id, method, path, ip_address, created_at,
              status, duration_ms, account_id, denial_reason, denial_detail
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
        status: r.status,
        durationMs: r.duration_ms,
        accountId: r.account_id,
        denialReason: r.denial_reason,
        denialDetail: r.denial_detail,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
