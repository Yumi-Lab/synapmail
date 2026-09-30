import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { createTagRule, listTagRules, type TagRuleInput } from '@/lib/tagging/tagRules'
import { loadQuestionSet } from '@/lib/tagging/userQuestions'
import { tagRuleErrorResponse } from './errors'

export const dynamic = 'force-dynamic'

/**
 * Les règles d'étiquetage de l'utilisateur (lot T-Q2, décision 24.1) : « si le mail vérifie ces
 * conditions, pose ces étiquettes », sans moteur. Portée `tags:read` en lecture, `tags:write`
 * en écriture ; une règle est à l'utilisateur, pour toutes ses boîtes ou pour l'une d'elles.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    return NextResponse.json({ data: await listTagRules(gate.ctx.id) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as TagRuleInput
    return NextResponse.json({ data: await createTagRule(gate.ctx.id, body, await loadQuestionSet(gate.ctx.id)) }, { status: 201 })
  } catch (err) {
    return tagRuleErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
