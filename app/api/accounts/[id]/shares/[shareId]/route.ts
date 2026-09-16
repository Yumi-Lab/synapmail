import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string; shareId: string } }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const owned = await query<{ id: string }>(
      'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
      [params.id, session.user.id]
    )
    if (!owned.length) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    await query(
      `UPDATE account_shares SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND account_id = $2`,
      [params.shareId, params.id]
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
