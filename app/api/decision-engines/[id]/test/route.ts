import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { testEngine } from '@/lib/tagging/engines'
import { UnknownEngineError } from '@/lib/tagging/mailbox'
import { EngineError } from '@/lib/tagging/engine'

export const dynamic = 'force-dynamic'

/**
 * UNE requête minimale au moteur, pour vérifier une clé avant de s'en servir (décision 13).
 * Session seule : c'est le SEUL endroit de l'application où un clic humain fait dépenser un
 * appel au moteur, et il en coûte un, pas 41 — voir `testEngine`.
 *
 * Un refus du moteur est recopié tel quel (`credit`, `auth`, `rate`…) : c'est ce qui distingue
 * « clé fausse » de « crédit épuisé », et l'écran le dit en clair plutôt qu'un « échec ».
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ data: await testEngine(session.user.id, params.id) })
  } catch (err) {
    if (err instanceof UnknownEngineError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof EngineError) {
      return NextResponse.json({ error: err.message, failure: err.kind, status: err.status }, { status: 502 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
