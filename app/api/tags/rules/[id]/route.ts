import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { deleteTagRule, updateTagRule, type TagRuleInput } from '@/lib/tagging/tagRules'
import { loadQuestionSet } from '@/lib/tagging/userQuestions'
import { tagRuleErrorResponse } from '../errors'

export const dynamic = 'force-dynamic'

/** UNE règle de l'utilisateur. Le PATCH fusionne le corps avec la ligne puis revalide la règle ENTIÈRE. */
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as TagRuleInput
    return NextResponse.json({ data: await updateTagRule(gate.ctx.id, params.id, body, await loadQuestionSet(gate.ctx.id)) })
  } catch (err) {
    return tagRuleErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Retire la règle. Les étiquettes qu'elle a posées restent en base : elles sont l'historique. */
async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    await deleteTagRule(gate.ctx.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    return tagRuleErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
