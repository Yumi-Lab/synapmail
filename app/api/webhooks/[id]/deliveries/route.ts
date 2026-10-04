import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { DELIVERY_PAGE_DEFAULT, DELIVERY_PAGE_MAX, getWebhook, listDeliveries } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

async function getHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const hook = await getWebhook(params.id, gate.ctx.id)
    if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const asked = Number(new URL(req.url).searchParams.get('limit') ?? DELIVERY_PAGE_DEFAULT)
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, DELIVERY_PAGE_MAX) : DELIVERY_PAGE_DEFAULT
    return NextResponse.json({ data: await listDeliveries(hook.id, limit) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
