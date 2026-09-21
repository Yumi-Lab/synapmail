import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { query } from '@/lib/db'
import { sanitizeScopes } from '@/lib/apiScopes'
import { grantAccounts } from '@/lib/apiKeyAccounts'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { scopes, accountIds } = (await req.json()) as { scopes?: unknown; accountIds?: unknown }
    const granted = sanitizeScopes(scopes)
    if (!granted.length) return NextResponse.json({ error: 'at least one scope is required' }, { status: 400 })

    const rows = await query<{ id: string; scopes: string[] }>(
      `UPDATE api_keys SET scopes = $1::text[]
       WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
       RETURNING id, scopes`,
      [granted, params.id, session.user.id]
    )
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // `undefined` = l'appelant ne parle pas des boîtes, on n'y touche pas ; une liste,
    // même vide, REMPLACE — c'est ainsi qu'on retire la dernière boîte d'une clé.
    const accounts = await grantAccounts(params.id, session.user.id, accountIds)

    return NextResponse.json({ data: { id: rows[0].id, scopes: sanitizeScopes(rows[0].scopes), accountIds: accounts } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await query(
      'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2',
      [params.id, session.user.id]
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
