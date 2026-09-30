import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { resetQuestions } from '@/lib/tagging/userQuestions'

export const dynamic = 'force-dynamic'

/**
 * Retour aux valeurs par défaut de `questions.ts` : TOUT le jeu de l'utilisateur est remplacé,
 * questions ajoutées comprises. L'écran demande confirmation avant ; la route, elle, exécute.
 * Les étiquettes déjà posées restent en base.
 */
async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  try {
    return NextResponse.json({ data: await resetQuestions(gate.ctx.id) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const POST = withApiLog(postHandler)
