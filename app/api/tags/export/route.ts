import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { exportTags } from '@/lib/tagging/store'

export const dynamic = 'force-dynamic'

/** L'export des étiquettes d'une boîte, paginé par `id` : toutes les lignes, toutes sources. */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, gate.ctx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    const { rows, nextAfter } = await exportTags({
      accountId,
      after: Number(searchParams.get('after') ?? '0') || 0,
      limit: Number(searchParams.get('limit') ?? '') || undefined,
    })
    return NextResponse.json({ data: { tags: rows, nextAfter } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
