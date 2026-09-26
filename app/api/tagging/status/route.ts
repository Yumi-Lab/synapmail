import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getAccessibleAccount } from '@/lib/accountAccess'
import { readTaggingStatus } from '@/lib/tagging/mailbox'

export const dynamic = 'force-dynamic'

/**
 * Où en est le tri d'une boîte : état, compteurs, dépense, estimation, et `hasKey` — jamais la
 * clé du moteur, ni en clair ni chiffrée (décision 13). C'est ce que l'écran rafraîchit pendant
 * un tri.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  const accountId = new URL(req.url).searchParams.get('account')
  if (!accountId) return NextResponse.json({ error: 'account required' }, { status: 400 })
  const account = await getAccessibleAccount(accountId, gate.ctx.id, [])
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  try {
    return NextResponse.json({ data: await readTaggingStatus(accountId) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
