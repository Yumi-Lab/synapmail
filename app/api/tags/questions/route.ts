import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { createQuestion, listQuestions, type QuestionInput } from '@/lib/tagging/userQuestions'
import { questionErrorResponse } from './errors'

export const dynamic = 'force-dynamic'

/**
 * Les questions de tri de l'utilisateur (lot T-Q, décision 22) : la source unique de SA
 * taxonomie. Un utilisateur sans ligne reçoit le jeu par défaut de `questions.ts` à la première
 * lecture. Portée `tags:read` en lecture, `tags:write` en écriture ; aucune boîte n'est nommée,
 * le jeu appartient à l'utilisateur.
 */
async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    return NextResponse.json({ data: await listQuestions(gate.ctx.id) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as QuestionInput
    return NextResponse.json({ data: await createQuestion(gate.ctx.id, body) }, { status: 201 })
  } catch (err) {
    return questionErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
