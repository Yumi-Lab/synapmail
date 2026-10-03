import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { deleteGroup, updateGroup, type GroupInput } from '@/lib/tagging/questionGroups'
import { loadQuestionSet } from '@/lib/tagging/userQuestions'
import { groupErrorResponse } from '../errors'

export const dynamic = 'force-dynamic'

/** UN groupe de l'utilisateur. Le PATCH fusionne le corps avec la ligne puis revalide le groupe ENTIER ; le slug ne change pas. */
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as GroupInput
    return NextResponse.json({ data: await updateGroup(gate.ctx.id, params.id, body, await loadQuestionSet(gate.ctx.id)) })
  } catch (err) {
    return groupErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Retire le déclencheur : les questions du slug redeviennent du tronc, aucune n'est supprimée. */
async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    await deleteGroup(gate.ctx.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    return groupErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
