import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getRuleById, updateRule, deleteRule, validateConditions } from '@/lib/rules'
import { validateWebhookActions } from '@/lib/webhooks'
import { questionSetForAccount } from '@/lib/tagging/userQuestions'
import type { EmailRule } from '@/types/rule'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

async function getHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const rule = await getRuleById(params.id, userId)
    if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: rule })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function patchHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json() as Partial<EmailRule>
    // La boîte vient de la RÈGLE, jamais du corps : un `accountId` envoyé ici ne déplace pas
    // une règle, donc le webhook visé doit appartenir à la boîte qu'elle a déjà.
    const current = await getRuleById(params.id, userId)
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (body.conditions) {
      const invalid = validateConditions(body.conditions, await questionSetForAccount(current.accountId))
      if (invalid) return NextResponse.json({ error: invalid }, { status: 422 })
    }
    if (body.actions) {
      const badWebhook = await validateWebhookActions(body.actions, current.accountId, userId)
      if (badWebhook) return NextResponse.json({ error: badWebhook }, { status: 422 })
    }
    const rule = await updateRule(params.id, userId, body)
    if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: rule })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function deleteHandler(req: Request, { params }: Ctx) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const ok = await deleteRule(params.id, userId)
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: { deleted: true } })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
