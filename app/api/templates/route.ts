import { NextResponse } from 'next/server'
import { authorize } from '@/lib/apiAuth'
import { withApiLog } from '@/lib/apiLog'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function getHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const templates = await query(
      `SELECT id, user_id AS "userId", name, subject,
              content_html AS "contentHtml", created_at AS "createdAt"
       FROM compose_templates WHERE user_id = $1 ORDER BY name ASC`,
      [userId]
    )
    return NextResponse.json({ data: templates })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function postHandler(req: Request) {
  const gate = await authorize(req)
  if ('denied' in gate) return gate.denied
  const userId = gate.ctx.id

  try {
    const body = await req.json()
    const { name, subject = '', contentHtml = '' } = body

    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

    const result = await query(
      `INSERT INTO compose_templates (user_id, name, subject, content_html)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id AS "userId", name, subject,
                 content_html AS "contentHtml", created_at AS "createdAt"`,
      [userId, name.trim(), subject, contentHtml]
    )

    return NextResponse.json({ data: result[0] }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// Le journal se termine avec la réponse : statut et durée n'existent qu'ici. Voir lib/apiLog.ts.
export const GET = withApiLog(getHandler)
export const POST = withApiLog(postHandler)
