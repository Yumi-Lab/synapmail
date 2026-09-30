import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { createEngine, InvalidEngineError, listEngines } from '@/lib/tagging/engines'

export const dynamic = 'force-dynamic'

/**
 * Les moteurs de décision de l'utilisateur — **session seule, propriétaire seul** (décision 13) :
 * ils portent une clé, comme les identifiants d'une boîte. Aucune clé API ne les lit ni ne les
 * écrit (ces routes ne figurent pas dans `ROUTE_SCOPES`) : sinon une clé volée servirait à lire
 * l'URL d'un moteur interne, ou à s'en donner un qui pointe ailleurs.
 *
 * La réponse ne porte JAMAIS la clé enregistrée, seulement `hasKey` — voir `lib/tagging/engines.ts`.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ data: await listEngines(session.user.id) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    return NextResponse.json({ data: await createEngine(session.user.id, body) }, { status: 201 })
  } catch (err) {
    if (err instanceof InvalidEngineError) {
      return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
