import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getDeliveryOwned, retryDelivery } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/**
 * Une tentative de PLUS sur la ligne existante (décision 7) : renvoyer ne crée pas une seconde
 * ligne, sinon l'unicité « une fois par mail » se contournerait par le bouton « renvoyer ».
 * L'envoi part du planificateur, comme le premier.
 */
async function postHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const owned = await getDeliveryOwned(params.id, gate.ctx.id)
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await retryDelivery(owned.id)
    return NextResponse.json({ data: { id: owned.id, webhookId: owned.webhookId, queued: true } }, { status: 202 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
