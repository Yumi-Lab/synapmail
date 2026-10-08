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
    const { name, subject, contentHtml } = body

    const result = await query(
      `UPDATE compose_templates
       SET name = COALESCE($1, name),
           subject = COALESCE($2, subject),
           content_html = COALESCE($3, content_html)
       WHERE id = $4 AND user_id = $5
       RETURNING id, user_id AS "userId", name, subject,
                 content_html AS "contentHtml", created_at AS "createdAt"`,
      [name ?? null, subject ?? null, contentHtml ?? null, params.id, userId]
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
      'DELETE FROM compose_templates WHERE id = $1 AND user_id = $2',
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
