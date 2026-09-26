import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { deleteEngine, InvalidEngineError, updateEngine } from '@/lib/tagging/engines'
import { UnknownEngineError } from '@/lib/tagging/mailbox'

export const dynamic = 'force-dynamic'

/**
 * Modifier ou retirer UN moteur — session seule, propriétaire seul, comme la liste. `user_id`
 * est dans le WHERE de chaque requête : un identifiant deviné rend 404, et ne dit pas si la
 * ligne existe chez quelqu'un d'autre.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    return NextResponse.json({ data: await updateEngine(session.user.id, params.id, body) })
  } catch (err) {
    if (err instanceof UnknownEngineError) return NextResponse.json({ error: err.message }, { status: 404 })
    if (err instanceof InvalidEngineError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    await deleteEngine(session.user.id, params.id)
    return NextResponse.json({ data: { id: params.id } })
  } catch (err) {
    if (err instanceof UnknownEngineError) return NextResponse.json({ error: err.message }, { status: 404 })
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
