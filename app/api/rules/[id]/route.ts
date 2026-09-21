import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { getRuleById, updateRule, deleteRule } from '@/lib/rules'
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
