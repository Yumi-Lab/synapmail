import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { deleteQuestion, updateQuestion, type QuestionInput } from '@/lib/tagging/userQuestions'
import { questionErrorResponse } from '../errors'

export const dynamic = 'force-dynamic'

/**
 * UNE question de l'utilisateur. Le PATCH fusionne le corps avec la ligne puis revalide la
 * question ENTIÈRE (contrat JEV) : un champ fautif est nommé (400). Changer la consigne ou les
 * critères incrémente `version` ; activer, déplacer ou regrouper ne le fait pas.
 */
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    const body = await req.json() as QuestionInput
    return NextResponse.json({ data: await updateQuestion(gate.ctx.id, params.id, body) })
  } catch (err) {
    return questionErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

/** Retire la question du jeu. Les étiquettes déjà posées restent en base : elles sont l'historique. */
async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    await deleteQuestion(gate.ctx.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    return questionErrorResponse(err) ?? NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
