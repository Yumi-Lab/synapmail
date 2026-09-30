import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { createGroup, listGroups, type GroupInput } from '@/lib/tagging/questionGroups'
import { loadQuestionSet } from '@/lib/tagging/userQuestions'
import { groupErrorResponse } from './errors'

export const dynamic = 'force-dynamic'

/**
 * Les groupes de questions CONDITIONNELS de l'utilisateur (lot T-Q3, décision 24.2) : un
 * déclencheur posé sur un slug de `tag_questions.groupe`. Les questions du groupe ne sont
 * posées au moteur (passe 2) que pour les mails dont le déclencheur est vrai après la passe 1.
 * Portée `tags:read` en lecture, `tags:write` en écriture.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    return NextResponse.json({ data: await listGroups(gate.ctx.id) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as GroupInput
    return NextResponse.json({ data: await createGroup(gate.ctx.id, body, await loadQuestionSet(gate.ctx.id)) }, { status: 201 })
  } catch (err) {
    return groupErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
