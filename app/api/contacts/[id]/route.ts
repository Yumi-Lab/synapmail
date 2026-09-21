import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

// PATCH /api/contacts/[id] — update name, notes, isStarred
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  const body = await req.json() as { name?: string; notes?: string; isStarred?: boolean }
  const { name, notes, isStarred } = body

  const sets: string[] = ['updated_at = NOW()']
  const values: unknown[] = [params.id, userId]
  let i = 3

  if (name !== undefined) {
    if (!name.trim()) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    sets.push(`name = $${i++}`)
    values.push(name.trim())
  }
  if (notes !== undefined) { sets.push(`notes = $${i++}`); values.push(notes) }
  if (isStarred !== undefined) { sets.push(`is_starred = $${i++}`); values.push(isStarred) }

  await query(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
    values
  )

  return NextResponse.json({ success: true })
}

// DELETE /api/contacts/[id]
async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  await query(
    'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
    [params.id, userId]
  )

  return NextResponse.json({ success: true })
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
