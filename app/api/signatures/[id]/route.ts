import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json()
    const { name, contentHtml, isDefault, accountId } = body

    if (isDefault) {
      await query(
        'UPDATE signatures SET is_default = false WHERE user_id = $1',
        [userId]
      )
    }

    const result = await query(
      `UPDATE signatures
       SET name = COALESCE($1, name),
           content_html = COALESCE($2, content_html),
           is_default = COALESCE($3, is_default),
           account_id = COALESCE($4, account_id)
       WHERE id = $5 AND user_id = $6
       RETURNING id, user_id AS "userId", account_id AS "accountId", name,
                 content_html AS "contentHtml", is_default AS "isDefault"`,
      [name ?? null, contentHtml ?? null, isDefault ?? null, accountId ?? null, params.id, userId]
    )

    if (!result.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data: result[0] })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function deleteHandler(req: Request, { params }: { params: { id: string } }) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    await query(
      'DELETE FROM signatures WHERE id = $1 AND user_id = $2',
      [params.id, userId]
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const PATCH = withApiLog(patchHandler)
export const DELETE = withApiLog(deleteHandler)
