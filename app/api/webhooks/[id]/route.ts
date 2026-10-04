import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { checkWebhookUrl, deleteWebhook, getWebhook, updateWebhook, WEBHOOK_NAME_MAX } from '@/lib/webhooks'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

async function getHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const hook = await getWebhook(params.id, gate.ctx.id)
    if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: hook })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function patchHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const body = await req.json() as { name?: string; url?: string; enabled?: boolean }

    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: 'name required' }, { status: 400 })
    }
    if (body.name !== undefined && body.name.trim().length > WEBHOOK_NAME_MAX) {
      return NextResponse.json({ error: `name longer than ${WEBHOOK_NAME_MAX} characters` }, { status: 400 })
    }
    // Une URL qui CHANGE est contrôlée comme une URL qui naît : sinon on refuserait à la
    // création ce qu'on laisserait entrer par une modification.
    if (body.url !== undefined) {
      if (!body.url.trim()) return NextResponse.json({ error: 'url required' }, { status: 400 })
      const verdict = await checkWebhookUrl(body.url.trim())
      if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 422 })
    }

    const hook = await updateWebhook(params.id, gate.ctx.id, {
      name: body.name?.trim(),
      url: body.url?.trim(),
      enabled: body.enabled,
    })
    if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: hook })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function deleteHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied

  try {
    const gone = await deleteWebhook(params.id, gate.ctx.id)
    if (!gone) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: { deleted: true } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
