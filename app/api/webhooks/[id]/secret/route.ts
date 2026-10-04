import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getWebhook, rotateWebhookSecret } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/**
 * Un secret neuf, rendu en clair UNE fois. L'ancien cesse de valider immédiatement : c'est
 * le but, on régénère un secret qu'on suppose lu par quelqu'un d'autre.
 */
async function postHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const secret = await rotateWebhookSecret(params.id, gate.ctx.id)
    if (!secret) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const hook = await getWebhook(params.id, gate.ctx.id)
    return NextResponse.json({ data: { ...hook, secret } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
